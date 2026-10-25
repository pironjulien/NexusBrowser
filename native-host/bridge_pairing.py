"""Appairage de l'extension sans hôte natif (protocole « nexus-browser/1 », authentification « paired »).

Quand l'hôte natif com.nexus.browser_auth ne peut pas être déclaré à Chrome (application du Microsoft Store : clé HKCU
virtualisée), l'extension prouve une clé d'appairage au lieu du jeton du pont. Les preuves, la clé de session et la
signature des messages sont exactement celles de bridge_auth : seule la clé change.

1. Un programme local qui connaît le jeton du pont (installeur, application Nexus) demande une offre :
   POST http://127.0.0.1:9225/api/pair. Le pont tire un secret d'appairage de 256 bits, à usage unique, valable
   5 minutes ; une nouvelle offre remplace la précédente. 5 preuves fausses épuisent l'offre.
2. Le secret est remis à l'extension (chrome-extension://<id>/pair.html#<secret>, ou collé dans cette page). Elle
   ouvre une poignée de main « pair » (rôle « pairing ») prouvée avec ce secret, dans les deux sens.
3. Preuve juste : le pont et l'extension dérivent la même clé d'appairage HMAC(secret, "paired", nonces, extension),
   le pont la garde pour cet identifiant d'extension (~/.nexus/nexus-browser/paired-extensions.json, droits
   restreints), l'offre est consommée. Le secret seul, lu plus tard (presse-papiers, historique), ne donne pas la clé.
   L'extension la garde comme clé WebCrypto non extractible : aucun script, pas même le sien, ne peut la relire.
4. Ensuite l'extension s'authentifie en « paired » avec cette clé. L'hôte natif, s'il est installé, reste prioritaire.
"""

from __future__ import annotations

import json
import os
import secrets
import time
from collections.abc import Callable
from pathlib import Path

from bridge_auth import PROTOCOL, AuthError, _digest, b64url, check_extension_id
from bridge_security import harden_token_permissions, token_path

OFFER_TTL_S = 300.0
MAX_ATTEMPTS = 5
PAIRING_ROLE = "pairing"


def paired_path() -> Path:
    return token_path().with_name("paired-extensions.json")


def paired_key(secret: str, client_nonce: str, server_nonce: str, extension_id: str) -> str:
    """Clé d'appairage durable, dérivée du secret à usage unique et de la poignée de main qui l'a consommé."""
    return b64url(_digest(secret.encode("ascii"), "paired", client_nonce, server_nonce, extension_id))


class PairingStore:
    """Offre d'appairage en attente (en mémoire) et clés des extensions appairées (fichier)."""

    def __init__(self, path: Path | None = None, clock: Callable[[], float] = time.monotonic) -> None:
        self.path = path or paired_path()
        self.clock = clock
        self._offer: str | None = None
        self._expires = 0.0
        self._attempts = 0

    # Offre -----------------------------------------------------------------------------------------------------
    def offer(self) -> dict:
        self._offer = secrets.token_urlsafe(32)  # 256 bits, 43 caractères base64url
        self._expires = self.clock() + OFFER_TTL_S
        self._attempts = 0
        return {"secret": self._offer, "expires_in_s": int(OFFER_TTL_S), "page": "pair.html", "protocol": PROTOCOL}

    def pending_secret(self) -> str:
        if self._offer is None:
            raise AuthError("aucun appairage en attente : en demander un nouveau")
        if self.clock() >= self._expires:
            self._offer = None
            raise AuthError("appairage expiré (5 minutes) : en demander un nouveau")
        return self._offer

    def failed(self) -> None:
        self._attempts += 1
        if self._attempts >= MAX_ATTEMPTS:
            self._offer = None

    def complete(self, client_nonce: str, server_nonce: str, extension_id: str) -> None:
        key = paired_key(self.pending_secret(), client_nonce, server_nonce, extension_id)
        self._offer = None  # usage unique, même si l'écriture échoue
        keys = self._read()
        keys[extension_id] = key
        self._write(keys)

    # Clés ------------------------------------------------------------------------------------------------------
    def key_for(self, extension_id: str) -> str:
        key = self._read().get(check_extension_id(extension_id))
        if not isinstance(key, str) or len(key) != 43:
            raise AuthError("extension non appairée à ce pont : l'appairer depuis l'application NexusBrowser")
        return key

    def revoke(self, extension_id: str | None = None) -> int:
        keys = self._read()
        removed = len(keys) if extension_id is None else int(keys.pop(extension_id, None) is not None)
        self._write({} if extension_id is None else keys)
        return removed

    def _read(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError):
            raise AuthError("fichier des extensions appairées illisible") from None
        return data if isinstance(data, dict) else {}

    def _write(self, keys: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{self.path.name}-{secrets.token_hex(8)}.tmp")
        try:
            temporary.write_text(json.dumps(keys, indent=2), encoding="utf-8", newline="\n")
            harden_token_permissions(temporary)
            os.replace(temporary, self.path)
        finally:
            temporary.unlink(missing_ok=True)
