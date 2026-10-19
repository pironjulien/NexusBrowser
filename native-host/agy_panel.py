"""Panneau Antigravity de Chrome : lien entre le pont et Nexus Relay (accord Claude-Antigravity du 18/10/2026).

L'utilisateur tape une demande dans le panneau latéral ; l'extension l'envoie au pont par la liaison signée (événement
« agy_ask ») ; le pont la dépose dans la boîte de Nexus Relay, de « julien » à Antigravity (le sidecar d'Antigravity le
réveille aussitôt) ; Antigravity agit sur l'onglet avec ses outils nexus-browser et répond par reply ; le pont relève
la réponse dans la boîte « julien » et la remet au panneau (commande « agy_panel_update », réservée au pont), puis la
passe en lu. Rien n'est gardé en mémoire du pont : la boîte du relais est la seule file (pas de « premier qui lit »).

Le relais est un autre projet (autre environnement Python) : appelé par `python -m nexus_relay.panel`, JSON sur
l'entrée et la sortie. Sans Nexus Relay installé, le panneau le dit clairement ; le reste du pont n'en dépend pas.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any

RELAY_TIMEOUT_S = 20.0
MAX_TEXT = 6000


def relay_python() -> Path:
    """Python de Nexus Relay (~/.nexus/nexus-relay/venv), surchargeable par NEXUS_RELAY_PYTHON (tests)."""
    override = os.environ.get("NEXUS_RELAY_PYTHON")
    if override:
        return Path(override)
    return Path.home() / ".nexus" / "nexus-relay" / "venv" / "Scripts" / "python.exe"


def julien_inbox() -> Path:
    """Boîte « julien » du relais (même règle que nexus_relay.paths.relay_home)."""
    override = os.environ.get("NEXUS_RELAY_HOME")
    root = Path(override) if override else Path.home() / ".nexus" / "relay"
    return root / "inbox" / "julien"


class RelayUnavailable(RuntimeError):
    """Nexus Relay absent ou en erreur : message clair pour le panneau."""


class RelayNotLaunched(RelayUnavailable):
    """Relais absent ou impossible à lancer : il n'a rien dit de cette requête (une reprise a pu être déposée avant)."""


class RelayCrashed(RelayUnavailable):
    """Le relais s'est arrêté sans réponse JSON (ex. son environnement en cours de réinstallation : module absent)."""


RETRY_AFTER_S = 2.0


async def _relay(command: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Un appel au relais ; un arrêt sans réponse (environnement réinstallé à ce moment-là, vu le 18/10) est retenté
    une fois, et sinon remonté avec la vraie erreur, jamais masqué."""
    try:
        return await _relay_once(command, payload)
    except RelayCrashed:
        await asyncio.sleep(RETRY_AFTER_S)
        return await _relay_once(command, payload)


async def _relay_once(command: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    python = relay_python()
    if not python.exists():
        raise RelayNotLaunched(
            f"Nexus Relay n'est pas installé sur ce poste ({python} absent) : lancer son install.ps1."
        )
    env = {**os.environ, "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1"}
    try:
        process = await asyncio.create_subprocess_exec(
            str(python),
            "-m",
            "nexus_relay.panel",
            command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except OSError as error:  # droits, antivirus, exécutable verrouillé : dit au panneau, jamais une exception perdue
        raise RelayNotLaunched(f"Nexus Relay impossible à lancer ({command}) : {error}") from None
    raw = json.dumps(payload or {}, ensure_ascii=False).encode("utf-8")
    try:
        out, err = await asyncio.wait_for(process.communicate(raw), RELAY_TIMEOUT_S)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()
        raise RelayCrashed(f"Nexus Relay ne répond pas ({command}, {RELAY_TIMEOUT_S:.0f} s).") from None
    text = out.decode("utf-8", "replace").strip()
    try:
        result = json.loads(text) if text else None
    except json.JSONDecodeError:
        result = None
    if result is None:
        tail = err.decode("utf-8", "replace").strip().splitlines()[-1:] or ["aucune sortie"]
        raise RelayCrashed(f"Nexus Relay en erreur ({command}, code {process.returncode}) : {tail[0][:300]}")
    if not isinstance(result, dict):
        raise RelayCrashed(f"Nexus Relay : réponse inattendue ({command}).")
    if result.get("error"):
        raise RelayUnavailable(str(result["error"]))  # refus explicite du relais : définitif
    if process.returncode != 0:
        tail = err.decode("utf-8", "replace").strip().splitlines()[-1:] or ["sans message"]
        raise RelayCrashed(f"Nexus Relay terminé en échec ({command}, code {process.returncode}) : {tail[0][:300]}")
    return result


def check_ask(data: dict[str, Any]) -> tuple[str, str, dict[str, Any] | None]:
    """Valide l'événement « agy_ask » venu de l'extension : (localId, texte, onglet)."""
    local_id = data.get("localId")
    text = data.get("text")
    if not isinstance(local_id, str) or not re.fullmatch(r"[A-Za-z0-9-]{8,64}", local_id):
        raise ValueError("localId invalide")
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
        raise ValueError(f"demande vide ou trop longue ({MAX_TEXT} caractères au plus)")
    tab = data.get("tab")
    if isinstance(tab, dict):
        tab_id = tab.get("id")
        tab = {
            "id": tab_id if isinstance(tab_id, int) and not isinstance(tab_id, bool) else None,
            "title": str(tab.get("title") or "")[:300],
            "url": str(tab.get("url") or "")[:600],
        }
    else:
        tab = None
    return local_id, text.strip(), tab


def check_instance(value: Any) -> str | None:
    """Identité d'instance Chrome annoncée par l'extension, ou None."""
    return value if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9-]{8,64}", value) else None


async def post(text: str, tab: dict[str, Any] | None, request_id: str, instance: str | None = None) -> tuple[str, bool]:
    """Dépose la demande (idempotent par request_id : une reprise ne dépose rien de neuf, même après un dépôt
    interrompu) ; rend l'id du message du relais et si le sidecar d'Antigravity bat."""
    payload: dict[str, Any] = {"text": text, "tab": tab, "request_id": request_id}
    if instance:
        payload["instance"] = instance
    result = await _relay("post", payload)
    message_id = result.get("id")
    if not isinstance(message_id, str):
        raise RelayUnavailable("Nexus Relay : identifiant de message absent.")
    return message_id, result.get("sidecar_active") is True


def has_mail() -> bool:
    """Lecture du dossier seulement : le relais n'est appelé que quand une réponse attend."""
    folder = julien_inbox()
    try:
        return any(folder.glob("*.json"))
    except OSError:
        return False


async def collect() -> list[dict[str, Any]]:
    messages = (await _relay("collect")).get("messages")
    return [m for m in messages if isinstance(m, dict)] if isinstance(messages, list) else []


async def ack(ids: list[str]) -> int:
    return int((await _relay("ack", {"ids": ids})).get("acked") or 0)
