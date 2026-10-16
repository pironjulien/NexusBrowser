"""Hôte natif « com.nexusagy.bridge_auth » : preuves d'authentification de l'extension, sans lui donner le jeton.

Chrome le lance (chrome.runtime.sendNativeMessage) seulement pour les extensions listées dans son manifeste
(allowed_origins, mêmes identifiants que bridge_config.json). Un message par lancement (protocole natif de Chrome :
longueur sur 4 octets little-endian puis JSON UTF-8) :

  {"op": "handshake", "client_nonce", "server_nonce", "server_proof", "role", "extension_id"}
  → {"ok": true, "client_proof", "session_key"}  si server_proof prouve que le pont connaît le jeton ;
  → {"ok": false, "error"}                        sinon (aucune preuve du client n'est alors calculée).

Le jeton est lu dans ~/.nexusagy/bridge-token (jamais créé ici) et ne sort pas de ce processus.
"""

from __future__ import annotations

import json
import re
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from bridge_auth import (  # noqa: E402
    AuthError,
    b64url,
    check_extension_id,
    check_nonce,
    check_role,
    client_proof,
    same,
    server_proof,
    session_key,
)
from bridge_security import token_path  # noqa: E402

MAX_MESSAGE_BYTES = 4096


def read_token(path: Path) -> str:
    try:
        token = path.read_text(encoding="ascii").strip()
    except OSError as error:
        raise AuthError(f"jeton du pont illisible ({error.strerror or error}) : lancer install.ps1") from None
    if len(token) < 43:
        raise AuthError("jeton du pont invalide")
    return token


def caller_extension_id(argv: list[str]) -> str | None:
    """Chrome passe l'origine de l'extension appelante en argument (« chrome-extension://<id>/ »)."""
    for argument in argv:
        match = re.fullmatch(r"chrome-extension://([a-p]{32})/?", argument)
        if match:
            return match.group(1)
    return None


def answer(message: object, caller_id: str | None, token_file: Path | None = None) -> dict:
    """Réponse à un message de l'extension ; ne lève jamais (l'erreur est rendue dans la réponse)."""
    try:
        if not isinstance(message, dict) or message.get("op") != "handshake":
            raise AuthError("opération inconnue")
        client_nonce = check_nonce(message.get("client_nonce"), "client_nonce")
        server_nonce = check_nonce(message.get("server_nonce"), "server_nonce")
        role = check_role(message.get("role"))
        extension_id = check_extension_id(message.get("extension_id"))
        if extension_id != caller_id:
            raise AuthError("identifiant d'extension différent de l'appelant annoncé par Chrome")
        token = read_token(token_file or token_path())
        expected = server_proof(token, client_nonce, server_nonce, role, extension_id)
        if not same(message.get("server_proof"), expected):
            raise AuthError("le serveur du port 9224 ne prouve pas qu'il connaît le jeton NexusAGY : connexion refusée")
        return {
            "ok": True,
            "client_proof": client_proof(token, client_nonce, server_nonce, role, extension_id),
            "session_key": b64url(session_key(token, client_nonce, server_nonce, role, extension_id)),
        }
    except AuthError as error:
        return {"ok": False, "error": str(error)}


def read_message(stream) -> object:
    header = stream.read(4)
    if len(header) != 4:
        raise AuthError("message natif incomplet")
    (length,) = struct.unpack("<I", header)
    if length > MAX_MESSAGE_BYTES:
        raise AuthError("message natif trop long")
    payload = stream.read(length)
    if len(payload) != length:
        raise AuthError("message natif incomplet")
    try:
        return json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise AuthError("message natif illisible") from None


def write_message(stream, message: dict) -> None:
    payload = json.dumps(message, ensure_ascii=False).encode("utf-8")
    stream.write(struct.pack("<I", len(payload)) + payload)
    stream.flush()


def main() -> int:
    try:
        reply = answer(read_message(sys.stdin.buffer), caller_extension_id(sys.argv[1:]))
    except AuthError as error:
        reply = {"ok": False, "error": str(error)}
    write_message(sys.stdout.buffer, reply)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
