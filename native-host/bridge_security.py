"""Shared authentication primitives for the local NexusBrowser bridge."""

from __future__ import annotations

import csv
import os
import re
import secrets
import socket
import subprocess
import sys
from pathlib import Path
from typing import Any

VERSION = "2.22.0"
TOKEN_HEADER = "X-Nexus-Browser-Token"
# Identité du client du pont (serveur MCP d'un agent, CLI, validation réelle) : nom de l'agent et identifiant de SA
# session (un par processus MCP). Le pont la transmet à l'extension dans le canal signé ; l'extension s'en sert pour
# tenir la propriété des onglets (un agent n'agit jamais sur l'onglet d'un autre ni sur ceux de Julien).
AGENT_HEADER = "X-Nexus-Browser-Agent"
CLIENT_HEADER = "X-Nexus-Browser-Client"
# Processus de la session (serveur MCP : identifiant neuf par processus). Le pont vérifie qu'il tourne encore : une
# session dont le processus a disparu est MORTE et ses onglets deviennent orphelins, repris par le même agent.
PID_HEADER = "X-Nexus-Browser-Pid"
_AGENT_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9 _.-]{0,31}")
_CLIENT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{3,63}")


def check_identity(agent: object, client_id: object) -> dict[str, str] | None:
    """{"agent", "id"} si les deux valeurs sont bien formées (ASCII court), sinon None."""
    if not isinstance(agent, str) or not isinstance(client_id, str):
        return None
    agent, client_id = agent.strip(), client_id.strip()
    if not _AGENT_NAME.fullmatch(agent) or not _CLIENT_ID.fullmatch(client_id):
        return None
    return {"agent": agent, "id": client_id}


def check_pid(value: object) -> int | None:
    """Numéro de processus annoncé par un client (en-tête X-Nexus-Browser-Pid), ou None s'il est absent ou invalide."""
    if not isinstance(value, str) or not value.strip().isdigit() or len(value.strip()) > 10:
        return None
    pid = int(value.strip())
    return pid if 0 < pid < 2**32 else None


def process_running(pid: int) -> bool:
    """Vrai si le processus pid tourne encore. Dans le doute (accès refusé, erreur), vrai : une session n'est déclarée
    morte que sur une preuve, jamais sur une lecture ratée."""
    if sys.platform == "win32":
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.restype = ctypes.c_void_p
        kernel32.OpenProcess.argtypes = (ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32)
        kernel32.GetExitCodeProcess.argtypes = (ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32))
        kernel32.CloseHandle.argtypes = (ctypes.c_void_p,)
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return ctypes.get_last_error() != 87  # ERROR_INVALID_PARAMETER : aucun processus de ce numéro
        try:
            code = ctypes.c_uint32()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return True
            return code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def harden_token_permissions(path: Path) -> None:
    """Restrict the Windows token ACL to the user, SYSTEM and administrators."""
    if sys.platform != "win32":
        path.chmod(0o600)
        return

    no_window = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    identity = subprocess.run(
        ["whoami", "/user", "/fo", "csv", "/nh"],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        creationflags=no_window,
    ).stdout.strip()
    user_sid = next(csv.reader([identity]))[1]
    result = subprocess.run(
        [
            "icacls",
            str(path),
            "/inheritance:r",
            "/grant:r",
            f"*{user_sid}:(F)",
            "*S-1-5-18:(F)",
            "*S-1-5-32-544:(F)",
        ],
        check=False,
        capture_output=True,
        text=True,
        # Page de code OEM (messages français accentués), lisible même avec PYTHONUTF8=1.
        encoding="oem",
        errors="replace",
        creationflags=no_window,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Unable to restrict NexusBrowser bridge token permissions: {result.stderr.strip()}")


def token_path() -> Path:
    """Return the per-user token path, overridable for tests."""
    override = os.environ.get("NEXUS_BROWSER_TOKEN_FILE")
    if override:
        return Path(override).expanduser().resolve()

    return Path.home() / ".nexus" / "nexus-browser" / "bridge-token"


def read_token(path: Path | None = None) -> str:
    """Lit le jeton existant, sans le créer ni retoucher ses droits (côté client, à chaque commande).

    Les droits du fichier se règlent à sa création et au démarrage du pont : aucun sous-processus (whoami, icacls) par
    commande. FileNotFoundError si le pont n'a pas encore créé le jeton.
    """
    path = path or token_path()
    token = path.read_text(encoding="ascii").strip()
    if len(token) < 43:
        raise RuntimeError(f"Invalid NexusBrowser bridge token in {path}")
    return token


def load_or_create_token(path: Path | None = None) -> str:
    """Load a strong per-user token, creating it atomically when necessary (droits restreints à la création)."""
    path = path or token_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    return _load_or_create_file_token(path)


def rotate_token(path: Path | None = None) -> str:
    """Replace the token atomically and return the new value."""
    path = path or token_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(48)
    temporary = path.with_name(f".{path.name}-{secrets.token_hex(8)}.tmp")
    try:
        temporary.write_text(token + "\n", encoding="ascii", newline="\n")
        harden_token_permissions(temporary)
        os.replace(temporary, path)
        harden_token_permissions(path)
    finally:
        temporary.unlink(missing_ok=True)
    return token


def _load_or_create_file_token(path: Path) -> str:
    """Portable fallback for non-Windows systems."""

    try:
        file_descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return read_token(path)
    token = secrets.token_urlsafe(48)
    with os.fdopen(file_descriptor, "w", encoding="ascii", newline="\n") as token_file:
        token_file.write(token + "\n")
    harden_token_permissions(path)
    return read_token(path)


# Commandes sans effet sur la page ni sur les onglets : seules à pouvoir être renvoyées après un délai dépassé,
# quand on ne sait pas si la première tentative a été exécutée, et seules permises pendant l'arrêt d'urgence (client
# et pont). Un clic, une saisie ou une navigation ne sont JAMAIS renvoyés dans ce cas (double soumission, double
# paiement, double envoi...). Les cookies n'y sont pas : ce sont des secrets de session, jamais relus d'office.
READ_ONLY_ACTIONS = frozenset(
    {
        "ping",
        "list-tabs",
        "active-tab",
        "content",
        "axtree",
        "logs",
        "screenshot",
        "pdf",
        "check-handoff",
        "download-status",
        "wait-load",
        "wait-network-idle",
        "interactive-map",
        "vision-inspect",
        "find",
        "field-state",
        "network-requests",
        "network-response",
        "wait-download",
        # Exports : lecture de la page ou fetch GET de l'export Google. La transcription YouTube peut activer un
        # instant les sous-titres du lecteur : elle reste une action, bloquée par l'arrêt d'urgence.
        "export-content",
        "export-gsuite",
        # Désescalades, sûres à renvoyer et permises pendant l'arrêt d'urgence : rendre un onglet à l'utilisateur
        # (propriété retirée, débogueur détaché), arrêter l'enregistrement réseau (débogueur détaché).
        "release-tab",
        "network-stop",
        # Signe de vie d'une session (serveur MCP) : aucune action sur une page.
        "heartbeat",
    }
)


def is_read_only_action(action: str) -> bool:
    return action.strip().lower().replace("_", "-") in READ_ONLY_ACTIONS


# -----------------------------------------------------------------------------
# Téléversements : jamais un fichier des dossiers de secrets de Julien (jetons, clés, configurations des agents,
# profil Chrome), quel que soit l'agent ou le client du pont. Contrôle partagé par le client Python et par le pont
# lui-même (un client HTTP qui contourne bridge_client est arrêté au pont). Comparaison sur le chemin normalisé :
# préfixes \\?\ et \\.\, partages administratifs locaux (\\localhost\C$\, \\127.0.0.1\C$\, nom du poste), liens
# symboliques et jonctions résolus, points et espaces finaux retirés, casse ignorée.
# -----------------------------------------------------------------------------
UPLOAD_ACTIONS = frozenset({"upload"})
_ADMIN_SHARE = re.compile(r"^\\\\([^\\]+)\\([A-Za-z])\$(?:\\(.*))?$", re.S)
_LOCAL_HOSTS = frozenset({"localhost", "localhost.localdomain", "::1", "[::1]", "0:0:0:0:0:0:0:1", ".", "?"})


def is_upload_action(action: str, params: object = None) -> bool:
    """Commande qui envoie des fichiers à la page : l'action upload, ou toute commande dont les paramètres portent
    « files », quel que soit son nom (le contrôle des dossiers secrets ne dépend jamais d'un alias)."""
    if isinstance(params, dict) and "files" in params:
        return True
    return action.strip().lower().replace("_", "-") in UPLOAD_ACTIONS


def _env_dir(variable: str, fallback: Path) -> Path:
    value = os.environ.get(variable, "").strip()
    return Path(value) if value else fallback


def protected_upload_roots() -> list[Path]:
    """Dossiers (et fichiers) de secrets dont rien ne part vers une page web."""
    home = Path.home()
    appdata = _env_dir("APPDATA", home / "AppData" / "Roaming")
    local = _env_dir("LOCALAPPDATA", home / "AppData" / "Local")
    roots = [
        home / name
        for name in (
            ".nexus",
            ".nexusagy",
            ".ssh",
            ".codex",
            ".claude",
            ".gemini",
            ".android",
            ".git-credentials",
            ".config/gcloud",
            ".aws",
            ".azure",
            ".kube",
            ".docker",
            ".gnupg",
            ".netrc",
            "_netrc",
            ".npmrc",
            ".pypirc",
        )
    ]
    roots += [
        appdata / "gcloud",
        appdata / "Microsoft" / "Credentials",
        appdata / "Microsoft" / "Protect",
        local / "Microsoft" / "Credentials",
        local / "Google" / "Chrome" / "User Data",
        home / "Documents" / "NexusSecure",
        home / "OneDrive" / "Documents" / "NexusSecure",
    ]
    for variable in ("OneDrive", "OneDriveConsumer", "OneDriveCommercial"):
        base = os.environ.get(variable, "").strip()
        if base:
            roots.append(Path(base) / "Documents" / "NexusSecure")
    return roots


def _local_host(name: str) -> bool:
    host = name.strip().lower().rstrip(".")
    if host in _LOCAL_HOSTS or host.startswith("127."):
        return True
    names = {socket.gethostname().lower(), os.environ.get("COMPUTERNAME", "").strip().lower()}
    return host in names - {""}


def canonical_path(raw: str) -> str:
    """Clé de comparaison d'un chemin Windows : forme longue, sans préfixe NT ni partage administratif local, liens
    résolus, casse ignorée. Rien n'est créé ni modifié (lecture des métadonnées seulement)."""
    text = os.path.expandvars(os.path.expanduser(str(raw).strip().strip('"')))
    if "\x00" in text:
        raise ValueError("invalid file path (null character)")
    if os.name == "nt":
        text = text.replace("/", "\\")
        lowered = text.lower()
        for prefix in ("\\\\?\\unc\\", "\\??\\unc\\"):
            if lowered.startswith(prefix):
                text = "\\\\" + text[len(prefix) :]
                break
        else:
            for prefix in ("\\\\?\\", "\\\\.\\", "\\??\\"):
                if lowered.startswith(prefix):
                    text = text[len(prefix) :]
                    break
        share = _ADMIN_SHARE.match(text)
        if share and _local_host(share.group(1)):
            text = f"{share.group(2)}:\\{share.group(3) or ''}"
    resolved = os.path.realpath(text)  # liens symboliques et jonctions existants résolus
    if os.name == "nt":
        drive, rest = os.path.splitdrive(resolved)
        # Windows ignore les points et espaces en fin de nom (« .ssh. » ouvre « .ssh ») : retirés de même.
        parts = [part.rstrip(" .") or part for part in rest.split("\\")]
        resolved = drive + "\\".join(parts)
    return os.path.normcase(resolved).casefold().rstrip("\\/")


def upload_refusal(files: Any) -> str | None:
    """Message de refus si un fichier à téléverser est sous un dossier de secrets (ou si la liste est invalide)."""
    if not isinstance(files, list) or not files or not all(isinstance(item, str) and item.strip() for item in files):
        return "files must be a non-empty list of file paths"
    roots = []
    for root in protected_upload_roots():
        try:
            roots.append((root, canonical_path(str(root))))
        except (OSError, ValueError):
            continue
    for item in files:
        try:
            key = canonical_path(item)
        except (OSError, ValueError) as error:
            return f"Upload refused: unreadable path {item!r} ({error})."
        for root, root_key in roots:
            if key == root_key or key.startswith(root_key + os.sep.casefold()):
                return (
                    f"Upload refused: {item} is in a secrets folder ({root}). "
                    "No token, key, Chrome profile or agent configuration is ever sent to a web page."
                )
    return None


def check_upload_files(files: Any) -> None:
    """PermissionError (ou ValueError pour une liste invalide) avant tout envoi vers Chrome."""
    refusal = upload_refusal(files)
    if refusal is None:
        return
    if refusal.startswith("files must"):
        raise ValueError(refusal)
    raise PermissionError(refusal)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Manage the local NexusBrowser bridge credential")
    parser.add_argument("--rotate", action="store_true", help="replace the current token")
    parser.add_argument("--token-file", type=Path, help="explicit token path")
    arguments = parser.parse_args()
    if not arguments.rotate:
        parser.error("--rotate is required")
    rotate_token(arguments.token_file)
