"""Mise à jour par le produit lui-même (contrat Nexus) : état ~/.nexus/status/browser.json, POST /api/update, et
scripts/self-update.ps1 éprouvé pour de vrai (-File) sur une fausse application. Aucun vrai état ni journal touché."""

import json
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "native-host"))

import bridge_update  # noqa: E402
from bridge_security import TOKEN_HEADER, VERSION, token_path  # noqa: E402

HTTP_PORT = 0
STATUS_URL = ""
COMMAND_URL = ""
WS_URL = ""


@pytest.fixture(autouse=True)
def status_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("NEXUS_STATUS_DIR", str(tmp_path / "status"))
    return tmp_path / "status"


def state() -> dict:
    return json.loads(bridge_update.status_path().read_text(encoding="utf-8"))


def test_check_reads_latest_at_most_once_a_day(monkeypatch):
    calls = []
    now = datetime(2026, 10, 26, 10, tzinfo=UTC)
    fetch = lambda: calls.append(1) or "99.0.0"  # noqa: E731
    monkeypatch.setattr(bridge_update, "public_install", lambda root=None: False)
    first = bridge_update.check("2.25.0", now=now, fetch=fetch)
    assert first["product"] == "browser" and first["version"] == "2.25.0" and first["latest"] == "99.0.0"
    assert first["state"] == "idle" and first["checked_at"] == "2026-10-26T10:00:00Z"
    assert "developer checkout" in first["message"]  # un clone ne se met pas à jour lui-même
    bridge_update.check("2.25.0", now=now + timedelta(hours=23), fetch=fetch)
    assert len(calls) == 1
    bridge_update.check("2.25.0", now=now + timedelta(days=1), fetch=fetch)
    assert len(calls) == 2


def test_latest_never_older_than_running_and_failure_kept_in_message():
    status = bridge_update.check("2.25.0", fetch=lambda: "2.24.0")
    assert status["latest"] == "2.25.0"

    def down():
        raise OSError("offline")

    bridge_update.write_status({"checked_at": "2000-01-01T00:00:00Z"})
    status = bridge_update.check("2.25.0", fetch=down)
    assert status["state"] == "idle" and "offline" in status["message"]


def test_restart_after_update_is_done():
    bridge_update.write_status({"version": "2.25.0", "state": "updating", "latest": "2.26.0"})
    status = bridge_update.check("2.26.0", fetch=lambda: "2.26.0")
    assert status["state"] == "done" and status["message"] == "Updated to 2.26.0."


def test_start_only_on_a_public_install_and_only_when_newer(monkeypatch):
    runs = []
    bridge_update.write_status({"latest": "2.26.0"})
    assert bridge_update.start("2.25.0", run=lambda: runs.append(1))[0] == 409  # clone de développement
    monkeypatch.setattr(bridge_update, "public_install", lambda root=None: True)
    code, status = bridge_update.start("2.26.0", run=lambda: runs.append(1))
    assert code == 200 and status["state"] == "idle" and not runs
    code, status = bridge_update.start("2.25.0", run=lambda: runs.append(1))
    assert code == 202 and status["state"] == "updating" and runs == [1]
    assert bridge_update.start("2.25.0", run=lambda: runs.append(1))[0] == 202 and runs == [1]  # déjà en cours

    def refused():
        raise OSError("task missing")

    bridge_update.write_status({"state": "idle"})
    code, status = bridge_update.start("2.25.0", run=refused)
    assert code == 500 and status["state"] == "failed" and "task missing" in status["message"]


def test_public_install_is_the_get_ps1_folder(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    app = tmp_path / "NexusBrowser" / "app"
    app.mkdir(parents=True)
    assert bridge_update.public_install(app) and not bridge_update.public_install(REPO_ROOT)


def test_fetch_latest_reads_the_redirect_without_the_api(monkeypatch):
    class Response:
        headers = {"Location": "https://github.com/pironjulien/NexusBrowser/releases/tag/v2.30.1"}

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    seen = []

    class Opener:
        def open(self, request, timeout):
            seen.append((request.get_method(), request.full_url))
            return Response()

    monkeypatch.setattr(bridge_update.urllib.request, "build_opener", lambda *handlers: Opener())
    assert bridge_update.fetch_latest() == "2.30.1"
    assert seen == [("HEAD", "https://github.com/pironjulien/NexusBrowser/releases/latest")]


def http(method: str) -> tuple[int, dict]:
    request = urllib.request.Request(
        f"http://127.0.0.1:{HTTP_PORT}/api/update",
        data=b"" if method == "POST" else None,
        headers={TOKEN_HEADER: token_path().read_text(encoding="ascii").strip()},
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            return error.code, json.loads(error.read().decode("utf-8"))
        finally:
            error.close()


def test_bridge_routes_need_the_token_and_refuse_a_developer_checkout():
    bridge_update.write_status({"version": VERSION, "latest": "99.0.0"})
    code, body = http("GET")
    assert code == 200 and body["product"] == "browser" and body["latest"] == "99.0.0"
    code, body = http("POST")
    assert code == 409 and body["success"] is False and "git" in body["message"]
    request = urllib.request.Request(f"http://127.0.0.1:{HTTP_PORT}/api/update", headers={TOKEN_HEADER: "faux"})
    with pytest.raises(urllib.error.HTTPError) as refused:
        urllib.request.urlopen(request, timeout=10)
    assert refused.value.code == 401
    refused.value.close()


@pytest.mark.skipif(sys.platform != "win32" or shutil.which("powershell") is None, reason="Windows PowerShell 5.1")
@pytest.mark.parametrize(("get_exit", "expected"), [(0, "done"), (7, "failed")])
def test_self_update_script_writes_its_state(tmp_path, status_dir, get_exit, expected):
    """self-update.ps1 sur une fausse application (get.ps1 qui sort avec un code donné), profil jetable."""
    app = tmp_path / "app"
    (app / "scripts").mkdir(parents=True)
    for name in ("self-update.ps1", "runtime.ps1"):
        shutil.copy(REPO_ROOT / "scripts" / name, app / "scripts" / name)
    (app / "get.ps1").write_text(f"exit {get_exit}\n", encoding="ascii")
    (app / "VERSION").write_text("9.9.9\n", encoding="ascii")
    profile = tmp_path / "profile"
    profile.mkdir()
    status_dir.mkdir(parents=True)
    (status_dir / "browser.json").write_text(json.dumps({"product": "browser", "version": "1.0.0"}), encoding="utf-8")
    env = {**__import__("os").environ, "USERPROFILE": str(profile), "NEXUS_STATUS_DIR": str(status_dir)}
    run = subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(app / "scripts" / "self-update.ps1")],
        capture_output=True,
        text=True,
        timeout=120,
        env=env,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    status = json.loads((status_dir / "browser.json").read_text(encoding="utf-8-sig"))
    assert status["state"] == expected, (run.stdout, run.stderr)
    if expected == "done":
        assert run.returncode == 0 and status["version"] == "9.9.9" and status["message"] == "Updated to 9.9.9."
    else:
        assert run.returncode == 1 and status["version"] == "1.0.0" and "exit code 7" in status["message"]
    assert (profile / ".nexus" / "nexus-browser" / "update.log").exists()  # journal dans le profil jetable
