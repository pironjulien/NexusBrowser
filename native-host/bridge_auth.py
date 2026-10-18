"""Authentification mutuelle du WebSocket local NexusBrowser (protocole « nexus-browser/1 »).

Le jeton partagé (~/.nexus/nexus-browser/bridge-token) n'est jamais envoyé : chaque côté prouve qu'il le connaît par un HMAC-SHA256
sur les deux nonces de la connexion (32 octets aléatoires chacun) et le rôle annoncé. Les deux nonces étant neufs à
chaque connexion, une preuve enregistrée ne sert à rien sur une autre (rejeu). Une clé de session dérivée des mêmes
éléments signe ensuite chaque message (numéro d'ordre strictement croissant par sens) : un programme placé entre
l'extension et le pont ne peut ni injecter, ni modifier, ni rejouer une commande.

  extension → pont : {"type": "auth_hello", "protocol", "client_nonce", "role", "extension_id"}
  pont → extension : {"type": "auth_challenge", "server_nonce", "server_proof"}
  extension → pont : {"type": "auth_proof", "client_proof"}   (seulement si server_proof est juste)
  ensuite, dans les deux sens : {"seq": n, "body": "<json>", "mac": HMAC(clé de session, sens, n, body)}
  premier message signé du pont : {"type": "auth_ok"}

Partagé par le pont (bridge_server.py) et l'hôte natif de l'extension (auth_host.py), qui calcule les preuves pour
l'extension : le jeton ne quitte jamais ce poste ni ce fichier, et n'entre jamais dans Chrome.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets

PROTOCOL = "nexus-browser/1"
ROLES = ("service_worker", "offscreen")
NONCE_BYTES = 32
_B64URL = re.compile(r"[A-Za-z0-9_-]+")
_EXTENSION_ID = re.compile(r"[a-p]{32}")


class AuthError(Exception):
    """Poignée de main ou message signé refusé."""


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def new_nonce() -> str:
    return b64url(secrets.token_bytes(NONCE_BYTES))


def check_nonce(value: object, name: str) -> str:
    if not isinstance(value, str) or len(value) != 43 or not _B64URL.fullmatch(value):
        raise AuthError(f"{name} invalide")
    return value


def check_role(value: object) -> str:
    if value not in ROLES:
        raise AuthError("rôle inconnu")
    return value  # type: ignore[return-value]


def check_extension_id(value: object) -> str:
    if not isinstance(value, str) or not _EXTENSION_ID.fullmatch(value):
        raise AuthError("identifiant d'extension invalide")
    return value


def _digest(key: bytes, *parts: str) -> bytes:
    return hmac.new(key, "\n".join((PROTOCOL, *parts)).encode("utf-8"), hashlib.sha256).digest()


def _key(token: str) -> bytes:
    return token.encode("ascii")


def server_proof(token: str, client_nonce: str, server_nonce: str, role: str, extension_id: str) -> str:
    return b64url(_digest(_key(token), "server", client_nonce, server_nonce, role, extension_id))


def client_proof(token: str, client_nonce: str, server_nonce: str, role: str, extension_id: str) -> str:
    return b64url(_digest(_key(token), "client", client_nonce, server_nonce, role, extension_id))


def session_key(token: str, client_nonce: str, server_nonce: str, role: str, extension_id: str) -> bytes:
    return _digest(_key(token), "session", client_nonce, server_nonce, role, extension_id)


def frame_mac(key: bytes, direction: str, seq: int, body: str) -> str:
    return b64url(_digest(key, direction, str(seq), body))


def same(a: object, b: str) -> bool:
    """Comparaison à temps constant d'une valeur reçue (de type quelconque) et d'une valeur attendue."""
    return isinstance(a, str) and hmac.compare_digest(a.encode("ascii", "replace"), b.encode("ascii"))


class Channel:
    """Messages signés d'une connexion authentifiée : numéros d'ordre stricts, signature vérifiée à temps constant."""

    def __init__(self, key: bytes, send_direction: str, receive_direction: str) -> None:
        self.key, self.send_direction, self.receive_direction = key, send_direction, receive_direction
        self.sent = 0
        self.received = 0

    def seal(self, body: str) -> dict:
        self.sent += 1
        return {"seq": self.sent, "body": body, "mac": frame_mac(self.key, self.send_direction, self.sent, body)}

    def open(self, frame: object) -> str:
        if not isinstance(frame, dict) or set(frame) != {"seq", "body", "mac"}:
            raise AuthError("message non signé")
        seq, body = frame["seq"], frame["body"]
        if type(seq) is not int or not isinstance(body, str):
            raise AuthError("message signé mal formé")
        if seq != self.received + 1:
            raise AuthError(f"numéro d'ordre {seq} inattendu (attendu {self.received + 1}) : rejeu ou perte")
        if not same(frame["mac"], frame_mac(self.key, self.receive_direction, seq, body)):
            raise AuthError("signature du message fausse")
        self.received = seq
        return body
