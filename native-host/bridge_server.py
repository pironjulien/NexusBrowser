"""
Antigravity Chrome Bridge - Local Server & Native Gateway
Provides WebSocket (ws://127.0.0.1:9224) and HTTP REST (http://127.0.0.1:9225/api/command)
to bridge Antigravity AI agent with the Chrome extension.

WebSocket : authentification mutuelle nexusagy-bridge/1 (bridge_auth.py) ; seule une connexion qui a prouvé le jeton
devient un client actif, et chaque message est signé. HTTP : en-tête X-NexusAGY-Token, aucune origine de navigateur.
"""

import argparse
import asyncio
import collections
import hashlib
import hmac
import json
import logging
import math
import os
import socket
import uuid
from logging.handlers import RotatingFileHandler
from pathlib import Path

try:
    from websockets.asyncio.server import serve
except ImportError:
    from websockets.server import serve

from bridge_auth import (
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
from bridge_security import TOKEN_HEADER, VERSION, load_or_create_token, token_path

PORT = 9224
HTTP_READ_TIMEOUT = 10.0
MAX_HEADER_BYTES = 64 * 1024
MAX_REQUEST_BYTES = 16 * 1024 * 1024
HANDSHAKE_TIMEOUT = 10.0
MAX_HANDSHAKE_BYTES = 2048
MAX_SIDEPANEL_TEXT = 4000
ROLE_PRIORITY = {"service_worker": 0, "offscreen": 1}
active_connections: list = []  # BridgeClient authentifiés seulement
pending_requests: dict = {}  # requestId -> (BridgeClient, Future) : seule la connexion visée peut répondre
sidepanel_requests: collections.deque = collections.deque(maxlen=50)
_background_tasks: set = set()
_auth_order = 0
BRIDGE_TOKEN_PATH: Path | None = None
LOGGER = logging.getLogger("nexusagy.bridge")


def read_bridge_token(path: Path) -> str:
    """Read the deployed credential without relying on cached helper bytecode."""
    if not path.exists():
        load_or_create_token(path)
    token = path.read_text(encoding="ascii").strip()
    if len(token) < 43:
        raise RuntimeError(f"Invalid NexusAGY bridge token in {path}")
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
    """Poignée de main nexusagy-bridge/1 (bridge_auth) ; AuthError si l'extension ne prouve pas le jeton."""
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
    token = read_bridge_token(BRIDGE_TOKEN_PATH)
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
            elif data.get("event") == "sidepanel_request":
                queue_sidepanel_request(data.get("request"), client)
            elif "event" in data:
                LOGGER.info("Event received: %s", data.get("event"))
    except Exception as exc:
        LOGGER.info("WebSocket connection ended: %s", exc)
    finally:
        if client in active_connections:
            active_connections.remove(client)
        LOGGER.info("Chrome Extension disconnected. Active clients: %d", len(active_connections))
        # Les commandes envoyées à CETTE connexion n'auront jamais de réponse.
        for req_id, (owner, future) in list(pending_requests.items()):
            if owner is client:
                pending_requests.pop(req_id, None)
                if not future.done():
                    future.set_exception(ConnectionResetError("Chrome Extension disconnected while processing request"))


def queue_sidepanel_request(request: object, client: BridgeClient) -> None:
    """Demande saisie dans le panneau latéral : gardée pour Antigravity (browser_sidepanel_requests)."""
    if not isinstance(request, dict):
        return
    request_id, text = request.get("id"), request.get("text")
    if not isinstance(request_id, str) or not 0 < len(request_id) <= 64:
        return
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_SIDEPANEL_TEXT:
        return
    if any(item["id"] == request_id for item in sidepanel_requests):
        return
    tab = request.get("tab") if isinstance(request.get("tab"), dict) else None
    sidepanel_requests.append(
        {
            "id": request_id,
            "text": text.strip(),
            "tab": {key: tab.get(key) for key in ("id", "title", "url")} if tab else None,
            "created_at": request.get("created_at") if isinstance(request.get("created_at"), (int, float)) else None,
            "extension_id": client.extension_id,
        }
    )
    LOGGER.info("Side panel request queued: %s", request_id)


async def take_sidepanel_requests(consume: bool) -> dict:
    """File des demandes du panneau ; consume les retire et prévient le panneau qu'elles ont été lues."""
    items = list(sidepanel_requests)
    if consume and items:
        sidepanel_requests.clear()

        async def mark_read() -> None:
            try:
                await send_command_to_chrome("sidepanel_mark_read", {"ids": [item["id"] for item in items]}, 5.0)
            except Exception as error:  # le panneau garde seulement l'état « transmise »
                LOGGER.info("Side panel read receipt not delivered: %s", error)

        task = asyncio.create_task(mark_read())
        _background_tasks.add(task)
        task.add_done_callback(_background_tasks.discard)
    return {"requests": items, "consumed": consume, "remaining": len(sidepanel_requests)}


ACTION_ALIASES = {
    "list-tabs": "list_tabs",
    "active-tab": "get_active_tab",
    "active_tab": "get_active_tab",
    "select-tab": "select_tab",
    "new-tab": "create_tab",
    "create-tab": "create_tab",
    "close-tab": "close_tab",
    "reload-tab": "reload",
    "hover": "hover",
    "wait-load": "wait_load",
    "wait-network-idle": "wait_network_idle",
    "get-cookies": "get_cookies",
    "cookies": "get_cookies",
    "cdp-send": "cdp_send",
    "eval": "evaluate",
    "content": "get_dom",
    "pdf": "print_pdf",
    "upload": "upload_file",
    "vision-inspect": "vision_inspect",
    "click-mark": "click_mark",
    "semantic-click": "semantic_click",
    "semantic-fill": "semantic_fill",
    "select-option": "select_option",
    "press-key": "press_key",
    "check-handoff": "check_handoff",
    "logs": "get_logs",
    "interactive-map": "interactive_map",
    "interactive_map": "interactive_map",
    "drag-and-drop": "drag_and_drop",
    "drag_and_drop": "drag_and_drop",
    "reload-extension": "reload_extension",
}


async def send_command_to_chrome(action, params=None, timeout=15.0):
    normalized_action = ACTION_ALIASES.get(action, (action or "").lower().replace("-", "_"))
    while True:
        target = select_target()
        if target is None:
            raise RuntimeError(
                "No Chrome browser extension connected to Antigravity Bridge. Make sure the extension is active in Chrome."
            )
        req_id = str(uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        pending_requests[req_id] = (target, future)
        try:
            await target.send({"requestId": req_id, "action": normalized_action, "params": params or {}})
            break
        except Exception:
            pending_requests.pop(req_id, None)
            if target in active_connections:
                active_connections.remove(target)

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
        current_token = read_bridge_token(BRIDGE_TOKEN_PATH)
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
                    "sidepanel_requests": len(sidepanel_requests),
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

            try:
                if action.strip().lower().replace("_", "-") == "sidepanel-requests":
                    # Servie par le pont lui-même : la file des demandes du panneau latéral.
                    result = await take_sidepanel_requests(params.get("consume", True) is not False)
                else:
                    result = await send_command_to_chrome(action, params, timeout=timeout)
                await send_json_response(writer, 200, {"success": True, "data": result})
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
    LOGGER.info(
        "starting version=%s pid=%s token_path=%s token_fingerprint=%s",
        VERSION,
        os.getpid(),
        BRIDGE_TOKEN_PATH.resolve(),
        hashlib.sha256(bridge_token.encode("ascii")).hexdigest()[:12],
    )
    print("==================================================")
    print(f"  NexusAGY Browser Bridge Server (v{VERSION})")
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

    await asyncio.gather(ws_server.wait_closed(), http_server.serve_forever())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=f"NexusAGY Browser Bridge v{VERSION}")
    parser.add_argument("--token-file", type=Path, help="Explicit per-user authentication token path")
    parser.add_argument("--log-file", type=Path, help="Rotating operational log path")
    arguments = parser.parse_args()
    try:
        asyncio.run(main(arguments.token_file, arguments.log_file))
    except KeyboardInterrupt:
        print("\nBridge server stopped.")
