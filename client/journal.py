"""Journal commun des outils Nexus (NexusHarness/shared/journal/FORMAT.md), produit « browser » : une ligne par appel
d'outil dans %LOCALAPPDATA%\\NexusJournal\\browser\\<agent>\\<AAAA-MM>.jsonl, en plus des journaux du pont. Jamais de
contenu de page : ni adresse complète (seulement le domaine enregistrable), ni texte lu ou tapé, ni valeur, ni titre,
ni image. Jamais d'exception vers l'outil : un journal ne bloque pas une action."""

from __future__ import annotations

import atexit
import ipaddress
import json
import os
import queue
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

AGENTS = {"claude": "claude", "codex": "codex", "antigravity": "antigravity"}
# Cause d'erreur : une catégorie d'un vocabulaire fixe, jamais un morceau du message. La page contrôle une partie des
# erreurs (Error.name et message d'une exception de page, sélecteurs, valeurs) : un filtre sur le texte en laisserait
# passer (relevé par Codex le 24/10). Premier motif trouvé dans le message, sinon « error ». Plus strict que la
# référence (début du message), pour la même raison.
_ERROR_KINDS = (
    ("emergency stop", "emergency stop"),
    ("accord", "accord required"),
    ("dialog", "dialog open"),
    ("timeout|timed out", "timeout"),
    ("covered|obscured|intercept", "element covered"),
    ("not visible|hidden", "element not visible"),
    ("not driven|not owned|owned by|another agent|another session", "tab not owned"),
    ("not found|no element|no match|not resolved", "not found"),
    ("tab closed|closed during|no tab", "tab closed"),
    ("debugger|detached|cdp attach", "debugger unavailable"),
    ("refused|forbidden|not allowed|protected|guardrail|sensitive", "refused"),
    ("bridge|extension|disconnected|connection|not connected", "bridge unavailable"),
    ("net::|navigation", "navigation failed"),
    ("too large", "too large"),
    ("invalid|missing|unknown|must be|needs|cannot|unreadable|empty|expected|at most", "invalid request"),
    ("unavailable", "unavailable"),
    ("exception|evaluat|threw|webmcp|error", "page error"),
)
_ERROR_PATTERNS = tuple((re.compile(motif), kind) for motif, kind in _ERROR_KINDS)
# Suffixes publics à deux niveaux connus exactement (liste officielle des suffixes publics, extrait) : on garde alors
# trois niveaux (bbc.co.uk, service-public.gouv.fr). Partout ailleurs deux niveaux seulement : jamais plus précis que
# le domaine enregistrable (alice.co.fr donne co.fr, user.github.io donne github.io : moins précis, jamais révélateur).
_PUBLIC_SECOND_LEVELS = frozenset(
    {
        "co.uk",
        "org.uk",
        "ac.uk",
        "gov.uk",
        "me.uk",
        "ltd.uk",
        "plc.uk",
        "net.uk",
        "nhs.uk",
        "police.uk",
        "gouv.fr",
        "asso.fr",
        "com.fr",
        "nom.fr",
        "tm.fr",
        "com.au",
        "net.au",
        "org.au",
        "edu.au",
        "gov.au",
        "co.nz",
        "org.nz",
        "govt.nz",
        "co.jp",
        "ne.jp",
        "or.jp",
        "ac.jp",
        "go.jp",
        "com.br",
        "net.br",
        "org.br",
        "gov.br",
        "com.cn",
        "net.cn",
        "org.cn",
        "gov.cn",
        "co.in",
        "net.in",
        "org.in",
        "gov.in",
        "co.kr",
        "or.kr",
        "co.za",
        "org.za",
        "com.mx",
        "org.mx",
        "gob.mx",
        "com.tr",
        "gov.tr",
        "com.ar",
        "com.sg",
        "gov.sg",
        "com.hk",
        "gov.hk",
        "co.il",
        "org.il",
        "co.id",
        "or.id",
        "go.id",
        "com.tw",
        "gov.tw",
        "co.th",
        "ac.th",
        "go.th",
        "com.my",
        "gov.my",
        "com.ua",
        "gov.ua",
        "com.pl",
        "gov.pl",
        "gc.ca",
        "gov.it",
    }
)
_HOST = re.compile(r"^[a-z0-9-]+(?:\.[a-z0-9-]+)*$")
_EDGE = "".join(map(chr, range(0x21)))  # contrôles C0 et espace, retirés en bord d'adresse
_DOTS = str.maketrans({"。": ".", "．": ".", "｡": "."})


def _racine() -> Path:
    base = os.environ.get("NEXUS_JOURNAL_HOME") or os.path.join(
        os.environ.get("LOCALAPPDATA", str(Path.home())), "NexusJournal"
    )
    return Path(base) / "browser"


def erreur_propre(texte: Any) -> str | None:
    """Catégorie de l'erreur (vocabulaire fixe _ERROR_KINDS), jamais le texte du message."""
    if not texte:
        return None
    message = str(texte).lower()
    return next((kind for pattern, kind in _ERROR_PATTERNS if pattern.search(message)), "error")


def domaine(url: Any) -> str | None:
    """Domaine enregistrable d'une adresse (google.com, bbc.co.uk), jamais l'adresse complète ; schéma seul pour
    about:, data:, file: (« data ») ; « ip » pour une adresse IP, « localhost » pour la machine."""
    if not isinstance(url, str) or not url.strip():
        return None
    # Découpage comme le navigateur (WHATWG) : blancs et caractères de contrôle de bord retirés, tabulations et sauts de
    # ligne supprimés, et pour http(s) l'antislash vaut une barre (https://a.com\@b.co.uk : hôte a.com, jamais b).
    url = re.sub(r"[\t\n\r]", "", url.strip(_EDGE))
    if re.match(r"(?i)https?:", url):
        url = url.replace("\\", "/")
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if parts.scheme not in ("http", "https"):
        return parts.scheme if re.fullmatch(r"[a-z][a-z0-9+.-]{0,15}", parts.scheme or "") else None
    # Hôte canonique comme le navigateur (WHATWG) : décodé (%2e), points idéographiques ramenés à « . », minuscules,
    # IDNA (xn--). Tout ce qui n'est pas alors un nom d'hôte valide (chemin, ?, =, % restants) : « invalid ».
    try:
        host = unquote(parts.hostname or "").translate(_DOTS).rstrip(".").lower()
        host = host.encode("idna").decode("ascii") if host and not host.isascii() else host
    except (UnicodeError, ValueError):
        return "invalid"
    if not host:
        return None
    try:
        ipaddress.ip_address(host)
        return "ip"
    except ValueError:
        pass
    if not _HOST.match(host):
        return "invalid"
    labels = [label for label in host.split(".") if label]
    if "localhost" in labels:
        return "localhost"
    if len(labels) <= 1:
        return "local"  # nom de machine du réseau local : jamais écrit tel quel
    if len(labels) >= 3 and ".".join(labels[-2:]) in _PUBLIC_SECOND_LEVELS:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def issue(answer: dict | None, failed: bool) -> str:
    """Issue de l'appel au format commun, lue dans la réponse de l'outil (status, verified...)."""
    if failed or not isinstance(answer, dict):
        return "✗"
    error = str(answer.get("error") or "")
    if answer.get("status") == "error":
        if answer.get("accord_required"):
            return "refus"
        if "emergency stop" in error.lower():
            return "arrêt"
        if answer.get("dialogOpened"):
            return "~"
        return "✗"
    data: dict[str, Any] = answer["data"] if isinstance(answer.get("data"), dict) else {}
    if data.get("dialogOpened"):  # boîte ouverte par la page pendant l'action : effet inconnu
        return "~"
    if data.get("changed") is False or data.get("already"):
        return "="
    if data.get("verified") is False or ("trusted_click" in data and data["trusted_click"] is not True):
        return "~"
    return "✓"


# Écriture hors de la boucle du démon partagé : file bornée vidée par un fil de fond. Un disque lent ne retarde ni
# l'outil ni les autres sessions (relevé par Codex le 24/10) ; file pleine : la ligne est perdue, jamais l'action.
QUEUE_MAX = 1000
_queue: queue.Queue = queue.Queue(maxsize=QUEUE_MAX)
_writer_lock = threading.Lock()
_writer: threading.Thread | None = None


def _write(nom: str, ligne: dict[str, Any]) -> None:
    try:
        chemin = _racine() / nom / f"{datetime.now(timezone.utc):%Y-%m}.jsonl"
        chemin.parent.mkdir(parents=True, exist_ok=True)
        with chemin.open("a", encoding="utf-8") as f:
            f.write(json.dumps({"v": 1, "agent": nom, **ligne}) + "\n")  # échappé : aucune erreur d'encodage
    except Exception:  # noqa: BLE001 - journal : jamais bloquant
        pass


def _drain() -> None:
    while True:
        nom, ligne = _queue.get()
        try:
            _write(nom, ligne)
        finally:
            _queue.task_done()


def ecrire(agent: str, ligne: dict[str, Any]) -> None:
    """Met une ligne en file ; agent inconnu (session sans IA nommée) : rien. Jamais d'exception vers l'outil."""
    global _writer
    try:
        nom = AGENTS.get(str(agent or "").lower())
        if not nom:
            return
        if _writer is None:
            with _writer_lock:
                if _writer is None:
                    _writer = threading.Thread(target=_drain, name="nexus-journal", daemon=True)
                    _writer.start()
        _queue.put_nowait((nom, ligne))
    except Exception:  # noqa: BLE001 - journal : jamais bloquant (file pleine comprise)
        pass


def flush(timeout: float | None = None) -> None:
    """Attend que la file soit écrite (tests ; arrêt propre, borné par timeout)."""
    if _writer is None:
        return
    if timeout is None:
        _queue.join()
        return
    deadline = time.monotonic() + timeout
    while _queue.unfinished_tasks and time.monotonic() < deadline:
        time.sleep(0.01)


# Arrêt normal du serveur : les lignes déjà acceptées en file sont écrites (1,618 s au plus, relevé par Codex le 24/10).
SHUTDOWN_DRAIN_S = 1.618
atexit.register(flush, SHUTDOWN_DRAIN_S)
