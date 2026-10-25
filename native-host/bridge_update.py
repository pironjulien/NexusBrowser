"""Mise à jour de NexusBrowser par lui-même (contrat commun des produits Nexus) et son état pour l'application Nexus.

État : ~/.nexus/status/browser.json, écrit par le pont (et par scripts/self-update.ps1 pendant la mise à jour) :
  {"product": "browser", "version", "latest", "state": "idle|checking|updating|done|failed", "checked_at", "message"}
« latest » vient de la redirection de github.com/pironjulien/NexusBrowser/releases/latest (en-tête Location, sans
l'API GitHub), lue au plus une fois par jour.

Déclenchement : POST /api/update sur le pont (jeton du pont), réponse immédiate 202. Le pont lance la tâche
« Nexus Browser Update » (sans déclencheur, déclarée par install.ps1 sur une installation publique seulement), qui
exécute scripts/self-update.ps1 hors du pont : elle survit à l'arrêt du pont pendant l'installation, et hors du
conteneur d'une application du Microsoft Store, puisque c'est le pont qui la lance. Seule une installation publique
(%LOCALAPPDATA%\\NexusBrowser\\app, posée par get.ps1) se met à jour ainsi : un dépôt cloné se met à jour par git.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import UTC, datetime, timedelta
from pathlib import Path

PRODUCT = "browser"
LATEST_URL = "https://github.com/pironjulien/NexusBrowser/releases/latest"
UPDATE_TASK = "Nexus Browser Update"
CHECK_EVERY = timedelta(days=1)
STATES = ("idle", "checking", "updating", "done", "failed")
_TAG = re.compile(r"/releases/tag/v?(\d+\.\d+\.\d+)$")


def status_path() -> Path:
    override = os.environ.get("NEXUS_STATUS_DIR")
    return (Path(override) if override else Path.home() / ".nexus" / "status") / f"{PRODUCT}.json"


def repository_root() -> Path:
    return Path(__file__).resolve().parent.parent


def public_install(root: Path | None = None) -> bool:
    """Installation posée par get.ps1 (seule à se mettre à jour elle-même) ; un clone de développement, non."""
    local = os.environ.get("LOCALAPPDATA")
    if not local:
        return False
    expected = Path(local) / "NexusBrowser" / "app"
    try:
        return (root or repository_root()).resolve() == expected.resolve()
    except OSError:
        return False


def read_status(path: Path | None = None) -> dict:
    try:
        data = json.loads((path or status_path()).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def write_status(fields: dict, path: Path | None = None) -> dict:
    """Fusionne les champs dans l'état et l'écrit d'un coup (fichier temporaire puis remplacement)."""
    path = path or status_path()
    status = {"product": PRODUCT, **read_status(path), **fields}
    if status.get("state") not in STATES:
        status["state"] = "idle"
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}-{secrets.token_hex(6)}.tmp")
    try:
        temporary.write_text(json.dumps(status, indent=2), encoding="utf-8", newline="\n")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return status


def _version_key(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.split("."))


def newer(latest: str | None, version: str) -> bool:
    try:
        return bool(latest) and _version_key(latest) > _version_key(version)  # type: ignore[arg-type]
    except ValueError:
        return False


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001 - signature de urllib
        return None


def fetch_latest(timeout: float = 10.0) -> str:
    """Dernière version publiée, lue dans la redirection de releases/latest (sans l'API GitHub ni son quota)."""
    request = urllib.request.Request(LATEST_URL, method="HEAD", headers={"User-Agent": "NexusBrowser-update"})
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=timeout) as response:
            location = response.headers.get("Location", "")
    except urllib.error.HTTPError as error:
        location = error.headers.get("Location", "") if error.headers else ""
        error.close()
    match = _TAG.search(location or "")
    if not match:
        raise RuntimeError("latest release not found on github.com")
    return match.group(1)


def check(version: str, force: bool = False, now: datetime | None = None, fetch=fetch_latest) -> dict:
    """État au démarrage du pont : version en cours, dernière version (au plus une lecture par jour)."""
    now = now or datetime.now(UTC)
    status = read_status()
    fields: dict = {"version": version}
    if status.get("state") in ("checking", "updating") and status.get("version") != version:
        # Pont redémarré par l'installation : la mise à jour est faite (self-update.ps1 écrit lui-même un échec).
        fields.update(state="done", message=f"Updated to {version}.")
    elif status.get("state") in ("checking", "updating"):
        fields.update(state="idle", message="")
    try:
        checked = datetime.fromisoformat(str(status.get("checked_at")))
    except ValueError:
        checked = None
    if force or checked is None or now - checked >= CHECK_EVERY:
        try:
            fields["latest"] = fetch()
            fields["checked_at"] = now.isoformat(timespec="seconds").replace("+00:00", "Z")
        except (OSError, RuntimeError) as error:
            fields["message"] = f"Update check failed: {error}"
    latest = fields.get("latest", status.get("latest"))
    if latest and not newer(latest, version):
        fields["latest"] = version  # jamais plus ancienne que la version en cours
    elif newer(latest, version) and fields.get("state", status.get("state")) in ("idle", None):
        if public_install():
            fields["message"] = f"Version {latest} is available: POST /api/update installs it."
        else:
            fields["message"] = f"Version {latest} is available: this is a developer checkout, update it with git."
    return write_status(fields)


def start(version: str, run=None) -> tuple[int, dict]:
    """POST /api/update : (code HTTP, état). 202 si la tâche de mise à jour est lancée."""
    status = read_status()
    if status.get("state") == "updating":
        return 202, status
    if not public_install():
        return 409, write_status(
            {"version": version, "message": "Developer checkout: update it with git (no self-update)."}
        )
    if not newer(status.get("latest"), version):
        return 200, write_status({"version": version, "state": "idle", "message": f"{version} is the latest version."})
    status = write_status({"version": version, "state": "updating", "message": f"Updating to {status['latest']}..."})
    try:
        (run or _run_task)()
    except (OSError, subprocess.CalledProcessError) as error:
        return 500, write_status({"state": "failed", "message": f"Update task not started: {error}"})
    return 202, status


def _run_task() -> None:
    flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    subprocess.run(["schtasks", "/Run", "/TN", UPDATE_TASK], check=True, capture_output=True, creationflags=flags)
