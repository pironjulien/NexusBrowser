"""Durcissement 2026-10-15 (pont Chrome) : arrêt d'urgence commun, renvois sûrs du pont, captures écrites sur disque."""

import base64
import io
import json
import os
import sys
import threading
import time
import urllib.error
from email.message import Message
from pathlib import Path
from unittest.mock import patch

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "client"))

import bridge_client  # noqa: E402
import emergency_stop  # noqa: E402

from client import emergency_stop as package_stop  # noqa: E402
from client import mcp_server  # noqa: E402


def _write_stop(path: Path, age_s: float = 0.0) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"by": "Test", "nonce": os.urandom(4).hex()}), encoding="utf-8")
    if age_s:
        stamp = time.time() - age_s
        os.utime(path, (stamp, stamp))


def test_stop_files_are_redirected_in_tests():
    real = Path.home() / ".nexus" / "stop"
    for module in (emergency_stop, package_stop):
        assert module.STOP_FILE != real
        assert module.OWNER_FILE != real.with_name("stop.owner")


def test_old_stop_file_is_ignored():
    _write_stop(emergency_stop.STOP_FILE, age_s=200)
    assert emergency_stop.remaining_s() == 0
    emergency_stop.check()


def test_deleting_the_stop_file_does_not_lift_the_stop():
    _write_stop(emergency_stop.STOP_FILE)
    assert emergency_stop.remaining_s() > 0
    emergency_stop.STOP_FILE.unlink()
    assert emergency_stop.remaining_s() > 100
    with pytest.raises(emergency_stop.EmergencyStopError):
        emergency_stop.check()


def test_hotkey_press_writes_shared_stop_and_heartbeat():
    emergency_stop.pressed()
    data = json.loads(emergency_stop.STOP_FILE.read_text(encoding="utf-8"))
    assert data["by"] == "NexusBrowser"
    assert data["pid"] == os.getpid()
    assert data["hold_s"] == 120
    assert set(data) == {"by", "pid", "at", "hold_s", "nonce"}
    assert emergency_stop.remaining_s() > 119
    first_nonce = data["nonce"]
    emergency_stop.request()
    assert json.loads(emergency_stop.STOP_FILE.read_text(encoding="utf-8"))["nonce"] != first_nonce

    emergency_stop.heartbeat()
    beat = json.loads(emergency_stop.OWNER_FILE.read_text(encoding="utf-8"))
    assert set(beat) == {"owner", "pid", "version", "ts"}
    assert beat["owner"] == "NexusBrowser"
    owner = emergency_stop.owner()
    assert owner is not None and owner["pid"] == os.getpid()


def test_watch_thread_latches_stop_while_idle():
    until = threading.Event()
    with patch.object(emergency_stop, "WATCH_S", 0.01):
        watcher = threading.Thread(target=emergency_stop._watch, args=(until,), daemon=True)
        watcher.start()
        try:
            _write_stop(emergency_stop.STOP_FILE)
            deadline = time.monotonic() + 2
            while emergency_stop._latched_until == 0.0 and time.monotonic() < deadline:
                time.sleep(0.01)
        finally:
            until.set()
            watcher.join(timeout=2)
    assert emergency_stop._latched_until > 0
    emergency_stop.STOP_FILE.unlink()
    assert emergency_stop.remaining_s() > 0


def test_browser_actions_blocked_reads_allowed_during_stop(monkeypatch):
    package_stop.pressed()
    seen = []
    monkeypatch.setattr(mcp_server, "call_bridge", lambda action, params, timeout=20.0: seen.append(action) or [])
    result = json.loads(mcp_server.browser_click(selector="button", tab_id=1))
    assert result["status"] == "error"
    assert "Arrêt d'urgence" in result["error"]
    # Toutes les actions souris réelles (CDP) sont refusées de même, avant d'atteindre le pont.
    for blocked in (
        mcp_server.browser_click(selector="button", tab_id=1, click_count=2),
        mcp_server.browser_click(selector="button", tab_id=1, button="right"),
        mcp_server.browser_hover(selector="button", tab_id=1),
        mcp_server.browser_click_mark(mark=1, tab_id=1),
        mcp_server.browser_semantic_click(role="button", name="OK", tab_id=1),
        mcp_server.browser_drag_and_drop(from_selector="#a", to_selector="#b", tab_id=1),
    ):
        assert json.loads(blocked)["status"] == "error"
    assert json.loads(mcp_server.browser_list_tabs())["status"] == "success"
    assert seen == ["list-tabs"]


def test_browser_click_forwards_button_and_click_count(monkeypatch):
    sent = []
    monkeypatch.setattr(
        mcp_server, "call_bridge", lambda action, params, timeout=20.0: sent.append((action, params)) or {"ok": 1}
    )
    assert json.loads(mcp_server.browser_click(selector="#a", tab_id=3, button="right", click_count=2))["status"] == (
        "success"
    )
    action, params = sent[0]
    assert action == "click"
    assert params["button"] == "right"
    assert params["clickCount"] == 2
    assert params["selector"] == "#a"


def _count_urlopen(monkeypatch, error):
    calls = []

    def urlopen(request, timeout=None):
        calls.append(json.loads(request.data.decode("utf-8"))["action"])
        raise error

    monkeypatch.setattr(bridge_client.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(bridge_client, "ensure_bridge_running", lambda: True)
    return calls


def test_timed_out_action_is_never_resent(monkeypatch):
    calls = _count_urlopen(monkeypatch, TimeoutError("timed out"))
    for action in ("click", "fill", "navigate", "eval", "press-key", "close-tab"):
        with pytest.raises(ConnectionError, match="pas renvoyée"):
            bridge_client.call_bridge(action, {}, 1.0)
    assert calls == ["click", "fill", "navigate", "eval", "press-key", "close-tab"]


def test_timed_out_read_is_retried_once(monkeypatch):
    calls = _count_urlopen(monkeypatch, TimeoutError("timed out"))
    with pytest.raises(ConnectionError):
        bridge_client.call_bridge("list-tabs", {}, 1.0)
    assert calls == ["list-tabs", "list-tabs"]


def test_undelivered_action_is_retried(monkeypatch):
    calls = _count_urlopen(monkeypatch, urllib.error.URLError(ConnectionRefusedError()))
    with pytest.raises(ConnectionError):
        bridge_client.call_bridge("click", {}, 1.0)
    assert calls == ["click", "click"]


def test_launch_chrome_without_load_extension(monkeypatch):
    launched = []
    monkeypatch.setattr(bridge_client, "get_chrome_executable", lambda: Path("C:/Chrome/chrome.exe"))
    monkeypatch.setattr(bridge_client.subprocess, "Popen", lambda args, **kwargs: launched.append(args))
    assert bridge_client.launch_chrome() is True
    assert launched[0][1:] == bridge_client.chrome_launch_args()
    assert not any("--load-extension" in arg for arg in launched[0])


def test_chrome_extra_args_are_opt_in_and_filtered(monkeypatch):
    monkeypatch.delenv(bridge_client.EXTRA_ARGS_VARIABLE, raising=False)
    assert bridge_client.chrome_launch_args() == ["--profile-directory=Default"]
    monkeypatch.setenv(
        bridge_client.EXTRA_ARGS_VARIABLE,
        "--lang=en-US  https://example.com --load-extension=C:/x --Remote-Debugging-Port=9222 -x --user-data-dir=C:/y --",
    )
    assert bridge_client.chrome_launch_args() == ["--profile-directory=Default", "--lang=en-US"]


def test_chrome_extra_args_whitelist_keeps_julien_flags_only():
    julien = (
        "--lang=fr-FR --accept-lang=fr-FR,fr,en-US,en --variations-override-country=us "
        "--disable-features=GlicCountryFiltering,GlicLocaleFiltering,GlicUseSessionCountryForFiltering"
    )
    assert bridge_client.chrome_extra_args(julien) == julien.split()
    assert bridge_client.chrome_extra_args("--force-dark-mode") == ["--force-dark-mode"]
    refused = (
        "--disable-web-security --disable-site-isolation-trials --allow-running-insecure-content "
        "--disable-features=IsolateOrigins,site-per-process --disable-features=GlicX,IsolateOrigins "
        "--lang=fr;calc --force-dark-mode=1 --lang --variations-override-country=usa --enable-features=Glic "
        "--LANG=fr --proxy-server=http://x:1 --host-resolver-rules=MAP"
    )
    assert bridge_client.chrome_extra_args(refused) == []


def test_extension_not_connected_is_reported_clearly(monkeypatch):
    body = json.dumps({"success": False, "error": "No Chrome browser extension connected to Nexus Browser Bridge."})

    def urlopen(request, timeout=None):
        raise urllib.error.HTTPError(bridge_client.API_URL, 503, "unavailable", Message(), io.BytesIO(body.encode()))

    monkeypatch.setattr(bridge_client.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(bridge_client, "ensure_chrome_running", lambda timeout=6.0: False)
    monkeypatch.setattr(bridge_client, "is_chrome_running", lambda: True)
    with pytest.raises(RuntimeError, match="chrome://extensions"):
        bridge_client.call_bridge("click", {}, 1.0)


PNG = "data:image/png;base64," + base64.b64encode(b"png-bytes").decode()


@pytest.fixture
def capture_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(mcp_server, "_screenshot_dir", lambda: tmp_path)
    return tmp_path


@pytest.mark.parametrize(
    "tool,key", [("browser_screenshot", "dataUrl"), ("browser_vision_inspect", "screenshotDataUrl")]
)
def test_browser_captures_are_written_to_disk_by_default(monkeypatch, capture_dir, tool, key):
    monkeypatch.setattr(mcp_server, "call_bridge", lambda action, params, timeout=20.0: {key: PNG, "markers": []})
    result = json.loads(getattr(mcp_server, tool)(tab_id=1))
    assert result["status"] == "success"
    assert key not in result["data"]
    written = Path(result["data"]["output_path"])
    assert written.parent == capture_dir.resolve()
    assert written.read_bytes() == b"png-bytes"


@pytest.mark.parametrize(
    "tool,key", [("browser_screenshot", "dataUrl"), ("browser_vision_inspect", "screenshotDataUrl")]
)
def test_browser_captures_inline_on_request(monkeypatch, capture_dir, tool, key):
    monkeypatch.setattr(mcp_server, "call_bridge", lambda action, params, timeout=20.0: {key: PNG})
    result = json.loads(getattr(mcp_server, tool)(tab_id=1, inline=True))
    assert result["data"][key] == PNG
    assert list(capture_dir.iterdir()) == []


def test_new_browser_tools_reach_the_extension(monkeypatch):
    sent = []
    monkeypatch.setattr(
        mcp_server, "call_bridge", lambda action, params, timeout=20.0: sent.append((action, params)) or {}
    )
    mcp_server.browser_handle_dialog(accept=False, prompt_text="oui", tab_id=4)
    mcp_server.browser_type_keys("abc", tab_id=4)
    mcp_server.browser_download_status(limit=3)
    assert sent == [
        ("handle-dialog", {"accept": False, "promptText": "oui", "tab_id": 4}),
        ("type-keys", {"text": "abc", "tab_id": 4}),
        ("download-status", {"limit": 3}),
    ]
