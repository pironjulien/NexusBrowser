"""Arrêt d'urgence commun aux agents de Julien (protocole emergency-stop.md commun aux agents de bureau).

Ctrl+Alt+Maj+Échap fige toute action de NexusAGY, NexusClaude, NexusCodex et NexusBrowser (Chrome) pendant 120 s.

- Un seul processus du poste obtient le raccourci (RegisterHotKey, MOD_NOREPEAT) ; les autres réessaient toutes les
  3 s et prennent le relais quand le détenteur s'arrête. Le détenteur bat dans ~/.nexus/stop.owner toutes les 3 s.
- À l'appui : verrou en mémoire d'abord, puis écriture de ~/.nexus/stop (JSON unique à chaque appui grâce au nonce).
- Chaque processus relit ~/.nexus/stop toutes les 0,2 s (fil dédié, même au repos), avant chaque action et entre
  les étapes d'un lot. Une NOUVELLE version de moins de 120 s pose un verrou en horloge monotone pour le temps
  restant. Ni la suppression du fichier ni un saut de l'horloge murale ne le lèvent ; seul le temps le fait, et un
  nouvel appui le réarme sans jamais le raccourcir.
- Les lectures (captures, arbre UI, liste des fenêtres) restent permises ; toute action est refusée.

Les chemins sont des attributs du module (STOP_FILE, OWNER_FILE) : les tests les redirigent vers un dossier
temporaire et n'écrivent jamais le vrai ~/.nexus/stop, qui figerait les autres agents.
"""

from __future__ import annotations

import ctypes
import json
import os
import re
import sys
import threading
import time
from ctypes import wintypes
from pathlib import Path

HOLD_S = 120.0
WATCH_S = 0.2
HEARTBEAT_S = 3.0
OWNER_STALE_S = 3 * HEARTBEAT_S
OWNER_NAME = "NexusBrowser"
HOTKEY_LABEL = "Ctrl+Alt+Maj+Échap"
STOP_FILE = Path.home() / ".nexus" / "stop"
OWNER_FILE = STOP_FILE.with_name("stop.owner")

MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_NOREPEAT = 0x0001, 0x0002, 0x0004, 0x4000
VK_ESCAPE = 0x1B
WM_HOTKEY, WM_TIMER = 0x0312, 0x0113
_HOTKEY_ID = 0x4E41  # « NA »

_LATCH = threading.Lock()
_latched_until = 0.0  # échéance monotone de l'arrêt ; ne recule jamais
_seen_version: tuple | None = None  # (mtime_ns, octets) de la dernière version du fichier prise en compte
_started = threading.Event()
_tried = threading.Event()
_owner = threading.Event()
_failure = 0


class EmergencyStopError(PermissionError):
    """Action refusée : arrêt d'urgence demandé par Julien."""


def _version() -> str:
    try:
        text = (Path(__file__).resolve().parent.parent / "pyproject.toml").read_text(encoding="utf-8")
        found = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
        return found.group(1) if found else "inconnue"
    except OSError:
        return "inconnue"


VERSION = _version()


def _now() -> float:
    return time.monotonic()


def _latch(seconds: float) -> None:
    global _latched_until
    with _LATCH:
        _latched_until = max(_latched_until, _now() + seconds)


def read_file() -> None:
    """Prend en compte une NOUVELLE version du fichier d'arrêt (une seule fois), pour ce qu'il lui reste d'après sa
    date, borné à [0, HOLD_S]. Un fichier illisible ou absent ne change rien : le verrou déjà posé tient."""
    global _seen_version
    path = STOP_FILE
    try:
        info = path.stat()
        version = (info.st_mtime_ns, path.read_bytes())
    except OSError:
        return
    with _LATCH:
        if version == _seen_version:
            return
        _seen_version = version
    left = min(max(HOLD_S - (time.time() - info.st_mtime), 0.0), HOLD_S)
    if left > 0:
        _latch(left)


def remaining_s() -> float:
    """Secondes d'arrêt restantes (0 : aucun arrêt), fichier relu d'abord."""
    read_file()
    return max(_latched_until - _now(), 0.0)


def message(remaining: float | None = None) -> str:
    left = remaining_s() if remaining is None else remaining
    return (
        f"Arrêt d'urgence demandé par Julien ({HOTKEY_LABEL}) : plus aucune action pendant encore {left:.0f} s. "
        "Attendre ses instructions ; ne pas contourner."
    )


def check() -> None:
    """Point de contrôle : lève EmergencyStopError si l'arrêt est actif (avant chaque action et entre les étapes)."""
    left = remaining_s()
    if left > 0:
        raise EmergencyStopError(message(left))


def request() -> None:
    """Annonce l'arrêt aux autres agents : réécrit ~/.nexus/stop avec un contenu unique."""
    STOP_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "by": OWNER_NAME,
        "pid": os.getpid(),
        "at": time.time(),
        "hold_s": HOLD_S,
        "nonce": os.urandom(6).hex(),
    }
    STOP_FILE.write_text(json.dumps(payload), encoding="utf-8")


def pressed() -> None:
    """Raccourci pressé : verrou en mémoire AVANT l'écriture du fichier (qui ne sert qu'à prévenir les autres)."""
    _latch(HOLD_S)
    try:
        request()
    except OSError:
        pass  # l'arrêt reste tenu par ce processus


def heartbeat() -> None:
    beat = json.dumps({"owner": OWNER_NAME, "pid": os.getpid(), "version": VERSION, "ts": time.time()})
    try:
        OWNER_FILE.parent.mkdir(parents=True, exist_ok=True)
        OWNER_FILE.write_text(beat, encoding="utf-8")
    except OSError:
        pass  # battement manqué : les autres verront l'arrêt non garanti, ce qui reste honnête


def owner() -> dict | None:
    """Détenteur vivant du raccourci (battement de moins de OWNER_STALE_S s), quel que soit l'agent ; sinon None."""
    try:
        data = json.loads(OWNER_FILE.read_text(encoding="utf-8"))
        fresh = time.time() - float(data["ts"]) <= OWNER_STALE_S
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return data if fresh and isinstance(data, dict) else None


def owns_hotkey() -> bool:
    return _owner.is_set()


def hotkey_note() -> str:
    """« » si l'arrêt d'urgence est disponible (ce processus ou un autre agent vivant le détient), sinon un avertissement."""
    if owns_hotkey() or not _tried.is_set() or owner() is not None:
        return ""
    return (
        f"Arrêt d'urgence {HOTKEY_LABEL} NON GARANTI : NexusBrowser n'a pas obtenu le raccourci (erreur {_failure}) et "
        "aucun agent à jour ne le détient. Prévenir Julien."
    )


def _watch(until: threading.Event) -> None:
    while not until.wait(WATCH_S):
        try:
            read_file()
        except Exception:  # noqa: BLE001 - ce fil tient l'arrêt d'urgence : il ne doit jamais mourir
            pass


def _loop() -> None:
    global _failure
    if sys.platform != "win32":  # pas de raccourci global hors Windows : le fichier ~/.nexus/stop reste surveillé
        _tried.set()
        return
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.RegisterHotKey.argtypes = (wintypes.HWND, ctypes.c_int, wintypes.UINT, wintypes.UINT)
    user32.RegisterHotKey.restype = wintypes.BOOL
    user32.GetMessageW.argtypes = (ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT)
    user32.GetMessageW.restype = wintypes.BOOL
    user32.SetTimer.argtypes = (wintypes.HWND, ctypes.c_size_t, wintypes.UINT, ctypes.c_void_p)
    user32.SetTimer.restype = ctypes.c_size_t
    modifiers = MOD_CONTROL | MOD_ALT | MOD_SHIFT | MOD_NOREPEAT
    while not user32.RegisterHotKey(None, _HOTKEY_ID, modifiers, VK_ESCAPE):
        if not _tried.is_set():
            _failure = ctypes.get_last_error()
            _tried.set()
        time.sleep(HEARTBEAT_S)  # détenu par un autre agent : relais à son arrêt
    _owner.set()
    _tried.set()
    heartbeat()
    user32.SetTimer(None, 0, int(HEARTBEAT_S * 1000), None)  # WM_TIMER dans la file de ce fil
    msg = wintypes.MSG()
    while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
        if msg.message == WM_HOTKEY and msg.wParam == _HOTKEY_ID:
            pressed()
        elif msg.message == WM_TIMER:
            heartbeat()


def start(timeout_s: float = 1.0) -> bool:
    """Lance la surveillance du fichier et l'écoute du raccourci (une fois par processus serveur)."""
    if not _started.is_set():
        _started.set()
        threading.Thread(target=_watch, args=(threading.Event(),), name="nexus-browser-stop-watch", daemon=True).start()
        threading.Thread(target=_loop, name="nexus-browser-stop-hotkey", daemon=True).start()
    _tried.wait(timeout_s)
    return owns_hotkey()
