"""Shared authenticated transport for NexusBrowser browser clients."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

# Aucun __pycache__ à côté des sources (OneDrive), quel que soit le lanceur.
sys.dont_write_bytecode = True

REPOSITORY_ROOT = Path(__file__).resolve().parent.parent
NATIVE_HOST_DIRECTORY = REPOSITORY_ROOT / "native-host"
BRIDGE_SERVER_PATH = NATIVE_HOST_DIRECTORY / "bridge_server.py"
API_URL = "http://127.0.0.1:9225/api/command"
STATUS_URL = "http://127.0.0.1:9225/api/status"

sys.path.insert(0, str(NATIVE_HOST_DIRECTORY))

# Aucun repli : sans ce module, pas de jeton ni de liste des lectures ; l'erreur d'import remonte telle quelle.
from bridge_security import (  # noqa: E402
    AGENT_HEADER,
    CLIENT_HEADER,
    PID_HEADER,
    READ_ONLY_ACTIONS,
    TOKEN_HEADER,
    check_identity,
    check_upload_files,
    is_read_only_action,
    is_upload_action,
    protected_upload_roots,
    read_token,
)

__all__ = [
    "READ_ONLY_ACTIONS",
    "TOKEN_HEADER",
    "call_bridge",
    "check_upload_files",
    "is_read_only_action",
    "protected_upload_roots",
    "set_identity",
]

# Identité de CE client auprès du pont : nom de l'agent et identifiant de sa session. L'extension rattache à cette
# identité les onglets ouverts par browser_new_tab et refuse toute commande de page sur les autres. Le serveur MCP
# d'un agent la fixe une fois au démarrage (un identifiant neuf par processus) ; la CLI garde un identifiant stable
# (« CLI » / « cli-local ») pour retrouver ses onglets d'un appel à l'autre.
_identity: dict[str, str] = {
    "agent": os.environ.get("NEXUS_BROWSER_AGENT", "").strip() or "CLI",
    "id": os.environ.get("NEXUS_BROWSER_CLIENT", "").strip() or "cli-local",
}
# Processus annoncé au pont : seulement pour une session liée à CE processus (set_identity). Quand il disparaît
# (serveur MCP redémarré, planté), ses onglets deviennent orphelins et le même agent peut les reprendre. La CLI, à
# identité stable d'un appel à l'autre, n'en annonce aucun.
_session_pid: int | None = None


def set_identity(agent: str, client_id: str | None = None) -> dict[str, str]:
    """Fixe l'identité de ce processus ; client_id absent : identifiant neuf (session unique, liée à ce processus)."""
    global _session_pid
    identity = check_identity(agent, client_id or f"{agent.lower().replace(' ', '-')}-{uuid.uuid4().hex[:12]}")
    if identity is None:
        raise ValueError(f"Identité de client invalide : agent={agent!r}, client={client_id!r}")
    _identity.update(identity)
    _session_pid = os.getpid()
    return dict(_identity)


def identity() -> dict[str, str]:
    return dict(_identity)


def authentication_headers() -> dict[str, str]:
    """Jeton relu à chaque commande (une rotation prend effet aussitôt), en LECTURE seule : ses droits sont réglés à
    sa création par le pont, jamais ici (aucun whoami ni icacls par commande). Identité du client jointe, et son
    processus pour une session liée à ce processus."""
    headers = {TOKEN_HEADER: read_token(), AGENT_HEADER: _identity["agent"], CLIENT_HEADER: _identity["id"]}
    if _session_pid is not None:
        headers[PID_HEADER] = str(_session_pid)
    return headers


# Signe de vie d'une session (serveur MCP) : sans commande ni battement pendant SESSION_DEAD_S, l'extension la tient
# pour morte et ses onglets deviennent orphelins. Battement toutes les 60 / 1,618 s, silence toléré 1,618 x 60 s.
HEARTBEAT_S = 60 / 1.618
SESSION_DEAD_S = 1.618 * 60


def heartbeat(reclaim: bool = False) -> Any:
    """Un battement : jamais de démarrage du pont ni de Chrome, aucun nouvel essai. reclaim=True : l'extension confie
    à cette session les onglets orphelins de son agent si elle n'en a aucun (reprise après redémarrage)."""
    return call_bridge("heartbeat", {"reclaim": bool(reclaim)}, 5.0, retry=False)


def start_heartbeat(interval_s: float = HEARTBEAT_S, stop: threading.Event | None = None) -> threading.Thread:
    """Battement de fond du serveur MCP (jusqu'à stop) ; le premier réussi reprend les onglets orphelins de l'agent."""
    stop = stop or threading.Event()

    def beat() -> None:
        reclaim = True
        while not stop.is_set():
            try:
                reclaimed = (heartbeat(reclaim) or {}).get("reclaimed") or []
                if reclaimed:
                    print(f"[nexus-browser] Onglets orphelins repris : {reclaimed}", file=sys.stderr, flush=True)
                reclaim = False
            except Exception:  # pont arrêté, Chrome fermé : réessayé au battement suivant
                pass
            stop.wait(interval_s)

    thread = threading.Thread(target=beat, name="nexus-browser-heartbeat", daemon=True)
    thread.start()
    return thread


def bridge_is_running() -> bool:
    """Probe the authenticated bridge status endpoint."""
    try:
        request = urllib.request.Request(STATUS_URL, headers=authentication_headers())
        with urllib.request.urlopen(request, timeout=1.0) as response:
            return response.status == 200
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def ensure_bridge_running() -> bool:
    """Ask the single Windows supervisor to start the bridge."""
    if bridge_is_running():
        return True
    if not BRIDGE_SERVER_PATH.exists():
        return False

    if sys.platform != "win32":
        return False
    try:
        subprocess.run(
            ["schtasks.exe", "/Run", "/TN", "Nexus Browser Bridge"],
            check=True,
            capture_output=True,
            creationflags=subprocess.CREATE_NO_WINDOW,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return False

    for _ in range(30):
        time.sleep(0.1)
        if bridge_is_running():
            return True
    return False


def is_chrome_running() -> bool:
    """Check if any chrome.exe process is currently alive."""
    if sys.platform != "win32":
        return False
    try:
        output = subprocess.check_output(
            ["tasklist.exe", "/FI", "IMAGENAME eq chrome.exe", "/FO", "CSV"],
            creationflags=subprocess.CREATE_NO_WINDOW,
            text=True,
            timeout=3,
        )
        return "chrome.exe" in output.lower()
    except (OSError, subprocess.SubprocessError):
        return False


FIXED_CHROME_PATHS = [
    Path("C:/Program Files/Google/Chrome/Application/chrome.exe"),
    Path("C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"),
]
CHROME_APP_PATHS_KEY = r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"


def _registered_chrome() -> list[Path]:
    """Chemins déclarés par l'installeur de Chrome dans App Paths (utilisateur puis machine)."""
    if sys.platform != "win32":
        return []
    import winreg

    found = []
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        try:
            with winreg.OpenKey(hive, CHROME_APP_PATHS_KEY) as key:
                value, _ = winreg.QueryValueEx(key, "")
        except OSError:
            continue
        if isinstance(value, str) and value.strip():
            found.append(Path(os.path.expandvars(value.strip().strip('"'))))
    return found


def get_chrome_executable() -> Path | None:
    """Locate the Google Chrome executable on Windows : registre App Paths, puis installations machine et utilisateur."""
    candidates = [*_registered_chrome()]
    for variable in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
        base = os.environ.get(variable)
        if base:
            candidates.append(Path(base) / "Google" / "Chrome" / "Application" / "chrome.exe")
    candidates += FIXED_CHROME_PATHS
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


# Relance de Chrome : profil par défaut seulement. Arguments en plus : variable d'environnement
# NEXUS_CHROME_EXTRA_ARGS, des drapeaux séparés par des espaces, pris dans une LISTE BLANCHE (langue, pays des
# variations, thème sombre, fonctions Glic désactivées) ; tout autre élément est ignoré (une liste noire laissait passer
# des drapeaux qui affaiblissent Chrome, comme --disable-web-security ; audit du 18/10).
CHROME_BASE_ARGS: tuple[str, ...] = ("--profile-directory=Default",)
EXTRA_ARGS_VARIABLE = "NEXUS_CHROME_EXTRA_ARGS"
_ALLOWED_FLAGS: dict[str, re.Pattern[str] | None] = {
    "--lang": re.compile(r"[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*"),
    "--accept-lang": re.compile(r"[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*(,[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*)*"),
    "--variations-override-country": re.compile(r"[A-Za-z]{2}"),
    "--disable-features": re.compile(r"Glic\w*(,Glic\w*)*"),
    "--force-dark-mode": None,
}


def chrome_extra_args(value: str | None = None) -> list[str]:
    """Drapeaux supplémentaires lus dans NEXUS_CHROME_EXTRA_ARGS (vide par défaut), liste blanche seulement."""
    raw = os.environ.get(EXTRA_ARGS_VARIABLE, "") if value is None else value
    accepted: list[str] = []
    for item in raw.split():
        name, sep, flag_value = item.partition("=")
        if name not in _ALLOWED_FLAGS:
            continue
        expected = _ALLOWED_FLAGS[name]
        valid = not sep if expected is None else bool(sep) and expected.fullmatch(flag_value) is not None
        if valid:
            accepted.append(item)
    return accepted


def chrome_launch_args() -> list[str]:
    return [*CHROME_BASE_ARGS, *chrome_extra_args()]


def launch_chrome() -> bool:
    """Relance Google Chrome normalement sur le profil Default, avec les drapeaux de NEXUS_CHROME_EXTRA_ARGS.

    L'extension Nexus Browser Bridge doit y être installée et activée : Chrome stable n'accepte plus
    --load-extension, ce chemin ne sert donc plus de relance. Vrai si le processus a été lancé (la connexion de
    l'extension est vérifiée ensuite par ensure_chrome_running).
    """
    chrome_exe = get_chrome_executable()
    if not chrome_exe:
        return False
    try:
        subprocess.Popen(
            [str(chrome_exe), *chrome_launch_args()],
            creationflags=getattr(subprocess, "DETACHED_PROCESS", 0),
        )
        return True
    except OSError:
        return False


def ping_bridge() -> bool:
    """Test if the Chrome extension is connected and responding to ping."""
    payload = {"action": "ping", "params": {}, "timeout": 1.0}
    try:
        request = urllib.request.Request(
            API_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", **authentication_headers()},
        )
        with urllib.request.urlopen(request, timeout=1.5) as response:
            data = json.loads(response.read().decode("utf-8"))
            return bool(data.get("success"))
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError):
        return False


EXTENSION_NOT_CONNECTED = (
    "L'extension Nexus Browser Bridge ne s'est pas connectée au pont NexusBrowser{detail}. Vérifier qu'elle est "
    "installée et activée dans chrome://extensions sur le profil Default (Chrome stable n'accepte plus "
    "--load-extension : elle doit être chargée une fois depuis le dossier extension du dépôt)."
)


def ensure_chrome_running(timeout: float = 6.0) -> bool:
    """Ensure Chrome is started and the extension has established its bridge connection."""
    ensure_bridge_running()

    if not is_chrome_running():
        launch_chrome()

    deadline = time.time() + timeout
    while time.time() < deadline:
        if ping_bridge():
            return True
        time.sleep(0.25)
    return False


# Téléversements : jamais un fichier des dossiers de secrets de Julien (bridge_security.upload_refusal). Contrôlé ici
# (avant tout envoi) ET par le pont lui-même, pour tout client HTTP.


def _not_delivered(error: urllib.error.URLError) -> bool:
    """Vrai si la requête n'a certainement pas atteint le pont (connexion refusée) : la renvoyer est sans risque."""
    reason = getattr(error, "reason", None)
    return isinstance(reason, ConnectionRefusedError)


def call_bridge(action: str, params: dict[str, Any] | None = None, timeout: float = 20.0, *, retry: bool = True) -> Any:
    """Execute one browser action and return its decoded result.

    Nouvel essai unique, seulement quand c'est sûr : la commande n'a pas été remise (pont arrêté, extension non
    connectée), ou c'est une lecture. Après un délai dépassé, une action (clic, saisie, navigation...) n'est jamais
    renvoyée : elle a pu être exécutée.
    """
    if is_upload_action(action):
        check_upload_files((params or {}).get("files"))
    payload = {"action": action, "params": params or {}, "timeout": timeout}
    try:
        headers = authentication_headers()
    except FileNotFoundError:
        # Jeton pas encore créé : c'est le pont qui le crée (droits restreints) à son démarrage.
        if not (retry and ensure_bridge_running()):
            raise ConnectionError(
                f"Impossible de joindre le pont NexusBrowser sur {API_URL} : jeton absent et démarrage du pont échoué. "
                "Pont et extension pas encore installés sur ce PC ? Une fois : install.ps1 "
                "(https://github.com/pironjulien/NexusBrowser#installation)."
            ) from None
        headers = authentication_headers()
    request = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", **headers},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout + 2) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            try:
                payload = json.loads(error.read().decode("utf-8"))
                message = payload.get("error", f"HTTP {error.code}: {error.reason}")
            except (json.JSONDecodeError, UnicodeDecodeError, OSError):
                message = f"HTTP {error.code}: {error.reason}"
        finally:
            error.close()

        if "No Chrome browser extension connected" in message:
            # Commande non remise : relancer Chrome (normalement) puis la renvoyer une fois est sans risque.
            if retry and ensure_chrome_running():
                return call_bridge(action, params, timeout, retry=False)
            detail = "" if is_chrome_running() else " (Chrome n'a pas pu être relancé)"
            raise RuntimeError(EXTENSION_NOT_CONNECTED.format(detail=detail)) from error

        raise RuntimeError(message) from error
    except (urllib.error.URLError, TimeoutError) as error:
        delivered = not (isinstance(error, urllib.error.URLError) and _not_delivered(error))
        if retry and (not delivered or is_read_only_action(action)) and ensure_bridge_running():
            return call_bridge(action, params, timeout, retry=False)
        if delivered and not is_read_only_action(action):
            raise ConnectionError(
                f"Pas de réponse du pont NexusBrowser pour '{action}' dans le délai : la commande a pu être exécutée. "
                "Elle n'est pas renvoyée automatiquement (risque de double action) ; vérifier l'état de la page "
                "avant de la relancer."
            ) from error
        raise ConnectionError(
            f"Impossible de joindre le pont NexusBrowser sur {API_URL}. Le démarrage automatique a échoué."
        ) from error

    if not data.get("success"):
        raise RuntimeError(data.get("error", "Erreur inconnue du pont NexusBrowser"))
    return data.get("data")
