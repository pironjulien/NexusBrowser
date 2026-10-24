"""
NexusBrowser - pont local (HTTP 9225 pour les agents, WebSocket 9224 pour l'extension)
Provides WebSocket (ws://127.0.0.1:9224) and HTTP REST (http://127.0.0.1:9225/api/command)
entre les agents (Antigravity, Claude, Codex) et l'extension Chrome.

WebSocket : authentification mutuelle nexus-browser/1 (bridge_auth.py) ; seule une connexion qui a prouvé le jeton
devient un client actif, et chaque message est signé. HTTP : en-tête X-Nexus-Browser-Token, aucune origine de navigateur.

Garanties tenues ICI, pour tout client HTTP (même un script qui contourne bridge_client) :
- identité du client (en-têtes X-Nexus-Browser-Agent et X-Nexus-Browser-Client) obligatoire, transmise à l'extension
  dans le canal signé : c'est elle qui fixe la propriété des onglets, jamais un paramètre de la commande ;
- sessions mortes : le processus annoncé par chaque session (en-tête X-Nexus-Browser-Pid) est vérifié ; les sessions
  du même agent dont le processus a disparu sont signalées à l'extension (« gone »), qui rend leurs onglets orphelins ;
- téléversement refusé depuis un dossier de secrets (bridge_security.upload_refusal) ;
- arrêt d'urgence : actions refusées, et dès qu'il est posé, commandes en cours annulées et extension prévenue (frappe,
  glisser et attentes interrompus, débogueur détaché).
"""

import argparse
import asyncio
import hashlib
import hmac
import json
import logging
import math
import os
import socket
import sys
import uuid
from logging.handlers import RotatingFileHandler
from pathlib import Path

# Aucun __pycache__ à côté des sources (OneDrive), quel que soit le lanceur.
sys.dont_write_bytecode = True

from bridge_auth import (  # noqa: E402
    PROTOCOL,
    AuthError,
    Channel,
    check_extension_id,
    check_nonce,
    check_role,
    client_proof,
    new_nonce,
    same,
    server_proof,
    session_key,
)
from bridge_security import (  # noqa: E402
    AGENT_HEADER,
    CLIENT_HEADER,
    PID_HEADER,
    TOKEN_HEADER,
    VERSION,
    check_identity,
    check_pid,
    harden_token_permissions,
    is_read_only_action,
    is_upload_action,
    load_or_create_token,
    process_running,
    token_path,
    upload_refusal,
)
from websockets.asyncio.server import serve  # noqa: E402

# Arrêt d'urgence commun (client/emergency_stop.py, même module que les serveurs MCP) : vérifié ici aussi, pour tout
# client HTTP du pont, même s'il ne le vérifie pas lui-même.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "client"))
import emergency_stop  # noqa: E402

PORT = 9224
HTTP_READ_TIMEOUT = 10.0
MAX_HEADER_BYTES = 64 * 1024
MAX_REQUEST_BYTES = 16 * 1024 * 1024
HANDSHAKE_TIMEOUT = 10.0
MAX_HANDSHAKE_BYTES = 2048
ROLE_PRIORITY = {"service_worker": 0, "offscreen": 1}
STOP_POLL_S = 0.2
# Actions que seul le pont envoie à l'extension (canal signé), jamais un client HTTP.
RESERVED_ACTIONS = frozenset({"emergency_stop"})
# Seule commande permise sans identité : le contrôle de vie (verify.ps1, validation réelle).
ANONYMOUS_ACTIONS = frozenset({"ping"})
active_connections: list = []  # BridgeClient authentifiés seulement
# requestId -> (BridgeClient, Future, action) : seule la connexion visée peut répondre
pending_requests: dict = {}
_background_tasks: set = set()
_auth_order = 0
BRIDGE_TOKEN_PATH: Path | None = None
# (agent, id) -> processus annoncé par la session (None : identité stable, la CLI) ; les plus récentes seulement.
client_processes: dict[tuple[str, str], int | None] = {}
MAX_KNOWN_SESSIONS = 256


class CommandCancelled(RuntimeError):
    """Commande annulée par l'arrêt d'urgence pendant son exécution."""


def _token_path() -> Path:
    if BRIDGE_TOKEN_PATH is None:
        raise RuntimeError("pont non configuré : chemin du jeton absent")
    return BRIDGE_TOKEN_PATH


LOGGER = logging.getLogger("nexus-browser.bridge")


def read_bridge_token(path: Path) -> str:
    """Read the deployed credential without relying on cached helper bytecode."""
    if not path.exists():
        load_or_create_token(path)
    token = path.read_text(encoding="ascii").strip()
    if len(token) < 43:
        raise RuntimeError(f"Invalid NexusBrowser bridge token in {path}")
    return token


def configure_logging(log_file: Path | None) -> None:
    if not log_file:
        return
    log_file.parent.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(log_file, maxBytes=1_048_576, backupCount=3, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    LOGGER.setLevel(logging.INFO)
    LOGGER.addHandler(handler)


def load_allowed_extension_origins() -> list[str]:
    manifest_path = Path(__file__).with_name("bridge_config.json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    origins = []
    for origin in manifest.get("allowed_origins", []):
        if origin.startswith("chrome-extension://") and "*" not in origin:
            origins.extend((origin.rstrip("/"), origin))
    if not origins:
        raise RuntimeError("No explicit Chrome extension origin is configured")
    return origins


ALLOWED_EXTENSION_ORIGINS = load_allowed_extension_origins()


class BridgeClient:
    """Connexion authentifiée de l'extension (rôle, ordre d'authentification, canal signé)."""

    def __init__(self, websocket, role: str, extension_id: str, key: bytes, order: int) -> None:
        self.websocket, self.role, self.extension_id, self.order = websocket, role, extension_id, order
        self.channel = Channel(key, "s2c", "c2s")
        self.lock = asyncio.Lock()

    async def send(self, payload: dict) -> None:
        # Numéro d'ordre attribué et message envoyé sous le même verrou : l'ordre reçu est l'ordre signé.
        async with self.lock:
            await self.websocket.send(json.dumps(self.channel.seal(json.dumps(payload, ensure_ascii=False))))

    def describe(self) -> dict:
        return {"role": self.role, "extension_id": self.extension_id, "order": self.order}


def select_target() -> BridgeClient | None:
    """Cible déterministe parmi les connexions authentifiées : le service worker (il exécute lui-même les commandes)
    avant le document offscreen (relais vers le service worker), puis la plus récemment authentifiée du même rôle
    (après une reconnexion, l'ancienne socket peut n'être pas encore fermée)."""
    if not active_connections:
        return None
    return min(active_connections, key=lambda client: (ROLE_PRIORITY.get(client.role, 99), -client.order))


async def authenticate(websocket) -> BridgeClient:
    """Poignée de main nexus-browser/1 (bridge_auth) ; AuthError si l'extension ne prouve pas le jeton."""
    global _auth_order

    async def receive() -> dict:
        raw = await asyncio.wait_for(websocket.recv(), HANDSHAKE_TIMEOUT)
        if not isinstance(raw, str) or len(raw) > MAX_HANDSHAKE_BYTES:
            raise AuthError("message de poignée de main invalide")
        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            raise AuthError("message de poignée de main illisible") from None
        if not isinstance(message, dict):
            raise AuthError("message de poignée de main invalide")
        return message

    hello = await receive()
    if hello.get("type") != "auth_hello" or hello.get("protocol") != PROTOCOL:
        raise AuthError("poignée de main attendue")
    client_nonce = check_nonce(hello.get("client_nonce"), "client_nonce")
    role = check_role(hello.get("role"))
    extension_id = check_extension_id(hello.get("extension_id"))
    token = read_bridge_token(_token_path())
    server_nonce = new_nonce()
    await websocket.send(
        json.dumps(
            {
                "type": "auth_challenge",
                "server_nonce": server_nonce,
                "server_proof": server_proof(token, client_nonce, server_nonce, role, extension_id),
            }
        )
    )
    reply = await receive()
    if reply.get("type") != "auth_proof" or not same(
        reply.get("client_proof"), client_proof(token, client_nonce, server_nonce, role, extension_id)
    ):
        raise AuthError("preuve du client fausse")
    _auth_order += 1
    client = BridgeClient(
        websocket, role, extension_id, session_key(token, client_nonce, server_nonce, role, extension_id), _auth_order
    )
    await client.send({"type": "auth_ok"})
    return client


async def ws_handler(websocket):
    request = getattr(websocket, "request", None)
    request_headers = request.headers if request else getattr(websocket, "request_headers", {})
    origin = request_headers.get("Origin") or request_headers.get("origin") or getattr(websocket, "origin", None)
    if origin not in ALLOWED_EXTENSION_ORIGINS:
        LOGGER.warning("WebSocket connection rejected: origin '%s' not allowed", origin)
        await websocket.close(code=1008, reason="Extension origin not allowed")
        return
    # L'en-tête Origin se falsifie : seule la preuve du jeton fait d'une connexion un client actif.
    try:
        client = await authenticate(websocket)
    except (AuthError, asyncio.TimeoutError) as error:
        reason = str(error) if isinstance(error, AuthError) else "poignée de main trop lente"
        LOGGER.warning("WebSocket authentication rejected: %s", reason)
        await websocket.close(code=1008, reason="Authentication failed")
        return
    except Exception as exc:
        LOGGER.info("WebSocket connection ended during authentication: %s", exc)
        return

    active_connections.append(client)
    LOGGER.info(
        "Chrome Extension authenticated: role=%s extension=%s. Active clients: %d",
        client.role,
        client.extension_id,
        len(active_connections),
    )
    # Service worker redémarré pendant un arrêt d'urgence : il l'apprend dès sa connexion.
    left = emergency_stop.remaining_s()
    if left > 0:
        background(notify_extension_stop(left, client))
    try:
        async for message in websocket:
            try:
                data = json.loads(client.channel.open(json.loads(message)))
            except (AuthError, json.JSONDecodeError, TypeError) as error:
                LOGGER.warning("Unauthenticated WebSocket message, connection closed: %s", error)
                await websocket.close(code=1008, reason="Invalid signed message")
                break
            if not isinstance(data, dict):
                continue
            req_id = data.get("requestId")
            pending = pending_requests.get(req_id) if isinstance(req_id, str) else None
            if pending and pending[0] is client:
                pending_requests.pop(req_id)
                if not pending[1].done():
                    pending[1].set_result(data)
            elif "event" in data:
                LOGGER.info("Event received: %s", data.get("event"))
    except Exception as exc:
        LOGGER.info("WebSocket connection ended: %s", exc)
    finally:
        if client in active_connections:
            active_connections.remove(client)
        LOGGER.info("Chrome Extension disconnected. Active clients: %d", len(active_connections))
        # Les commandes envoyées à CETTE connexion n'auront jamais de réponse.
        for req_id, (owner, future, _action) in list(pending_requests.items()):
            if owner is client:
                pending_requests.pop(req_id, None)
                if not future.done():
                    future.set_exception(ConnectionResetError("Chrome Extension disconnected while processing request"))


def background(coroutine) -> None:
    task = asyncio.ensure_future(coroutine)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


# -----------------------------------------------------------------------------
# Arrêt d'urgence : annulation des commandes en cours (pas seulement refus des suivantes)
# -----------------------------------------------------------------------------
_stop_seen_until = 0.0  # échéance monotone de l'arrêt déjà traité (un nouvel appui la repousse)


async def notify_extension_stop(left: float, target: "BridgeClient | None" = None) -> None:
    """Prévient l'extension : elle interrompt frappe, glisser et attentes, détache tous les débogueurs et refuse
    toute action jusqu'à la fin de l'arrêt."""
    try:
        await send_command_to_chrome("emergency_stop", {"hold_s": round(left, 1)}, 5.0, target=target)
    except Exception as error:  # extension absente : rien à interrompre côté Chrome
        LOGGER.info("Emergency stop not delivered to the extension: %s", error)


async def cancel_for_stop(left: float) -> int:
    """Annule toutes les commandes en attente de l'extension (réponse 423 au client) et prévient l'extension."""
    global _stop_seen_until
    if left <= 0:
        return 0
    _stop_seen_until = max(_stop_seen_until, asyncio.get_running_loop().time() + left)
    cancelled = 0
    for req_id, (_owner, future, action) in list(pending_requests.items()):
        if action == "emergency_stop" or future.done():
            continue
        pending_requests.pop(req_id, None)
        future.set_exception(
            CommandCancelled(f"Command '{action}' cancelled while running: {emergency_stop.message(left)}")
        )
        cancelled += 1
    LOGGER.warning("Emergency stop: %d command(s) cancelled", cancelled)
    await notify_extension_stop(left)
    return cancelled


async def watch_emergency_stop() -> None:
    """Relit l'arrêt commun toutes les 0,2 s (posé par n'importe quel agent ou par le raccourci) : chaque NOUVEL
    arrêt annule aussitôt les commandes en cours."""
    loop = asyncio.get_running_loop()
    while True:
        try:
            left = emergency_stop.remaining_s()
            if left > 0 and loop.time() + left > _stop_seen_until + 1.0:
                await cancel_for_stop(left)
        except Exception:  # noqa: BLE001 - cette surveillance tient l'arrêt d'urgence : elle ne doit jamais mourir
            LOGGER.exception("emergency stop watch failure")
        await asyncio.sleep(STOP_POLL_S)


def note_session(client: dict, pid: int | None) -> list[str]:
    """Retient le processus de la session qui commande et renvoie les sessions MORTES du même agent : processus annoncé
    qui ne tourne plus (redémarrage du serveur MCP, plantage). Seule la preuve compte : une session sans processus
    connu n'est jamais déclarée morte ici (l'extension le fait après un silence prolongé)."""
    key = (client["agent"], client["id"])
    client_processes.pop(key, None)
    client_processes[key] = pid
    while len(client_processes) > MAX_KNOWN_SESSIONS:
        client_processes.pop(next(iter(client_processes)))
    return [
        session
        for (agent, session), known in client_processes.items()
        if agent == client["agent"] and session != client["id"] and known is not None and not process_running(known)
    ]


def normalize_action(action: str) -> str:
    """Nom reçu par l'extension : celui du client, tirets remplacés par des soulignés. Un seul nom par action, sans
    table d'alias (chaque alias devait être recopié dans les listes de garde-fous)."""
    return (action or "").lower().replace("-", "_")


async def send_command_to_chrome(action, params=None, timeout=15.0, client=None, target=None, gone=None):
    """Commande signée vers l'extension. client : identité du demandeur ({"agent", "id"}), posée par le pont à côté
    des paramètres (jamais lue dans les paramètres de la commande). gone : sessions mortes du même agent."""
    normalized_action = normalize_action(action)
    payload = {"action": normalized_action, "params": params or {}}
    if client is not None:
        payload["client"] = client
    if gone:
        payload["gone"] = list(gone)
    while True:
        chosen = target if target is not None and target in active_connections else select_target()
        if chosen is None:
            raise RuntimeError(
                "No Chrome browser extension connected to Nexus Browser Bridge. Make sure the extension is active in Chrome."
            )
        req_id = str(uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        pending_requests[req_id] = (chosen, future, normalized_action)
        try:
            await chosen.send({"requestId": req_id, **payload})
            break
        except Exception:
            pending_requests.pop(req_id, None)
            if chosen in active_connections:
                active_connections.remove(chosen)
            target = None

    try:
        response = await asyncio.wait_for(future, timeout=timeout)
        if not response.get("success", False):
            raise RuntimeError(response.get("error", "Unknown error from Chrome extension"))
        return response.get("data")
    except asyncio.TimeoutError:
        raise TimeoutError(f"Command '{action}' timed out after {timeout}s.") from None
    finally:
        pending_requests.pop(req_id, None)


async def handle_http(reader, writer):
    try:
        try:
            raw_header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), HTTP_READ_TIMEOUT)
        except asyncio.LimitOverrunError:
            await send_json_response(writer, 431, {"success": False, "error": "Request headers too large"})
            return
        except asyncio.IncompleteReadError:
            await send_json_response(writer, 400, {"success": False, "error": "Incomplete HTTP headers"})
            return
        if len(raw_header) > MAX_HEADER_BYTES:
            await send_json_response(writer, 431, {"success": False, "error": "Request headers too large"})
            return
        try:
            lines = raw_header.decode("ascii").split("\r\n")
        except UnicodeDecodeError:
            await send_json_response(writer, 400, {"success": False, "error": "Invalid HTTP headers"})
            return
        request_line = lines[0].split()
        if len(request_line) != 3 or not request_line[2].startswith("HTTP/"):
            await send_json_response(writer, 400, {"success": False, "error": "Invalid HTTP request line"})
            return

        method, path = request_line[0], request_line[1]

        # Read headers
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()

        try:
            content_length = int(headers.get("content-length", 0))
        except ValueError:
            await send_json_response(writer, 400, {"success": False, "error": "Invalid Content-Length"})
            return
        if content_length < 0 or content_length > MAX_REQUEST_BYTES:
            await send_json_response(writer, 413, {"success": False, "error": "Request body too large"})
            return

        if "origin" in headers:
            await send_json_response(writer, 403, {"success": False, "error": "Browser origins are not allowed"})
            return

        supplied_token = headers.get(TOKEN_HEADER.lower(), "")
        current_token = read_bridge_token(_token_path())
        if not hmac.compare_digest(supplied_token, current_token):
            await send_json_response(writer, 401, {"success": False, "error": "Authentication required"})
            return

        body = b""
        if content_length > 0:
            body = await asyncio.wait_for(reader.readexactly(content_length), HTTP_READ_TIMEOUT)

        if path in {"/api/status", "/status"} and method != "GET":
            await send_json_response(writer, 405, {"success": False, "error": "Method not allowed"}, {"Allow": "GET"})
            return

        if path in {"/api/status", "/status"}:
            await send_json_response(
                writer,
                200,
                {
                    "status": "online",
                    "version": VERSION,
                    "connected_clients": len(active_connections),
                    "clients": [client.describe() for client in active_connections],
                    "target": target.describe() if (target := select_target()) else None,
                    "emergency_stop_s": round(emergency_stop.remaining_s(), 1),
                    "port": PORT,
                },
            )
            return

        if path == "/api/command" and method != "POST":
            await send_json_response(writer, 405, {"success": False, "error": "Method not allowed"}, {"Allow": "POST"})
            return

        if path == "/api/command":
            if headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
                await send_json_response(writer, 415, {"success": False, "error": "application/json required"})
                return

            try:
                req_json = json.loads(body.decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                await send_json_response(writer, 400, {"success": False, "error": "Invalid JSON body"})
                return
            if not isinstance(req_json, dict):
                await send_json_response(writer, 400, {"success": False, "error": "JSON body must be an object"})
                return
            action = req_json.get("action")
            params = req_json.get("params", {})
            timeout = req_json.get("timeout", 15.0)

            if not isinstance(action, str) or not action.strip():
                await send_json_response(writer, 400, {"success": False, "error": "A non-empty action is required"})
                return
            if not isinstance(params, dict):
                await send_json_response(writer, 400, {"success": False, "error": "params must be an object"})
                return
            if not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not 0.1 <= timeout <= 120:
                await send_json_response(
                    writer, 400, {"success": False, "error": "timeout must be between 0.1 and 120 seconds"}
                )
                return

            normalized = normalize_action(action.strip())
            if normalized in RESERVED_ACTIONS:
                await send_json_response(
                    writer, 403, {"success": False, "error": f"Action '{action}' is reserved to the bridge itself."}
                )
                return
            client = check_identity(headers.get(AGENT_HEADER.lower()), headers.get(CLIENT_HEADER.lower()))
            if client is None and normalized not in ANONYMOUS_ACTIONS:
                await send_json_response(
                    writer,
                    400,
                    {
                        "success": False,
                        "error": (
                            f"Missing or invalid client identity ({AGENT_HEADER} and {CLIENT_HEADER} headers): "
                            "go through an up-to-date nexus-browser MCP server (or bridge_client), rerun install.ps1."
                        ),
                    },
                )
                return

            if not is_read_only_action(action):
                try:
                    emergency_stop.check()
                except emergency_stop.EmergencyStopError as error:
                    await send_json_response(
                        writer, 423, {"success": False, "error": str(error), "emergency_stop": True}
                    )
                    return

            if is_upload_action(action, params):
                refusal = upload_refusal(params.get("files"))
                if refusal is not None:
                    await send_json_response(writer, 403, {"success": False, "error": refusal})
                    return

            gone = note_session(client, check_pid(headers.get(PID_HEADER.lower()))) if client is not None else []
            try:
                result = await send_command_to_chrome(action, params, timeout=timeout, client=client, gone=gone)
                await send_json_response(writer, 200, {"success": True, "data": result})
            except CommandCancelled as exc:
                await send_json_response(writer, 423, {"success": False, "error": str(exc), "emergency_stop": True})
            except Exception as exc:
                await send_json_response(writer, 400, {"success": False, "error": str(exc)})
            return

        await send_json_response(writer, 404, {"success": False, "error": "Not found"})
    except asyncio.TimeoutError:
        await send_json_response(writer, 408, {"success": False, "error": "HTTP request timed out"})
    except asyncio.IncompleteReadError:
        await send_json_response(writer, 400, {"success": False, "error": "Incomplete HTTP body"})
    except Exception:
        LOGGER.exception("unexpected HTTP handler failure")
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


async def send_json_response(writer, status: int, payload: dict, extra_headers: dict[str, str] | None = None) -> None:
    reason = {
        200: "OK",
        400: "Bad Request",
        401: "Unauthorized",
        403: "Forbidden",
        404: "Not Found",
        405: "Method Not Allowed",
        408: "Request Timeout",
        413: "Content Too Large",
        415: "Unsupported Media Type",
        423: "Locked",
        431: "Request Header Fields Too Large",
    }.get(status, "Error")
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    header_lines = [
        f"HTTP/1.1 {status} {reason}\r\n"
        "Content-Type: application/json; charset=utf-8\r\n"
        "Cache-Control: no-store\r\n"
        "X-Content-Type-Options: nosniff\r\n"
        "Connection: close\r\n"
        f"Content-Length: {len(body)}\r\n"
    ]
    header_lines.extend(f"{name}: {value}\r\n" for name, value in (extra_headers or {}).items())
    response = ("".join(header_lines) + "\r\n").encode("ascii") + body
    try:
        writer.write(response)
        await writer.drain()
    except (OSError, ConnectionError):
        pass
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


def exclusive_listener(port: int) -> socket.socket:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        listener.bind(("127.0.0.1", port))
        listener.listen(128)
        listener.setblocking(False)
    except OSError:
        listener.close()
        raise
    return listener


async def main(token_file: Path | None = None, log_file: Path | None = None):
    global BRIDGE_TOKEN_PATH
    configure_logging(log_file)
    BRIDGE_TOKEN_PATH = token_file or token_path()
    bridge_token = read_bridge_token(BRIDGE_TOKEN_PATH)
    # Droits du jeton réglés une fois, par le pont, au démarrage (les clients le lisent seulement).
    harden_token_permissions(BRIDGE_TOKEN_PATH)
    LOGGER.info(
        "starting version=%s pid=%s token_path=%s token_fingerprint=%s",
        VERSION,
        os.getpid(),
        BRIDGE_TOKEN_PATH.resolve(),
        hashlib.sha256(bridge_token.encode("ascii")).hexdigest()[:12],
    )
    print("==================================================")
    print(f"  Nexus Browser Bridge Server (v{VERSION})")
    print(f"  WebSocket: ws://127.0.0.1:{PORT}")
    print(f"  HTTP REST: http://127.0.0.1:{PORT + 1}/api/command")
    print("==================================================")

    # Ports pris en exclusivité : sous Windows, sans SO_EXCLUSIVEADDRUSE, un autre programme peut lier le même port
    # avec SO_REUSEADDR et capter les connexions (la signature des messages l'empêcherait d'agir, pas d'écouter).
    ws_server = await serve(
        ws_handler,
        sock=exclusive_listener(PORT),
        max_size=MAX_REQUEST_BYTES,
        ping_interval=20,
        ping_timeout=20,
    )
    http_server = await asyncio.start_server(handle_http, sock=exclusive_listener(PORT + 1), limit=MAX_HEADER_BYTES + 4)
    print(f"  HTTP API available at http://127.0.0.1:{PORT + 1}/api/command")

    await asyncio.gather(ws_server.wait_closed(), http_server.serve_forever(), watch_emergency_stop())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=f"Nexus Browser Bridge v{VERSION}")
    parser.add_argument("--token-file", type=Path, help="Explicit per-user authentication token path")
    parser.add_argument("--log-file", type=Path, help="Rotating operational log path")
    arguments = parser.parse_args()
    try:
        asyncio.run(main(arguments.token_file, arguments.log_file))
    except KeyboardInterrupt:
        print("\nBridge server stopped.")
