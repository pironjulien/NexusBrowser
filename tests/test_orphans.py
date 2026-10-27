"""Revue d'Antigravity du 17/10 (partie 2) côté pont, client et serveur MCP : sessions vivantes et onglets orphelins
(2.1), monde de la page pour Runtime.evaluate (2.2), valeurs de cookies des seules origines locales (2.3). Vrai pont sur
ports éphémères, extension simulée, vrais processus clients (redémarrage simulé d'un serveur MCP). La reprise des
onglets elle-même est tenue par l'extension : tests/browser.test.cjs (« 2.1 orphelins »)."""

import asyncio
import json
import os
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest
from websockets import connect

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "native-host"))
sys.path.insert(0, str(REPO_ROOT / "client"))
sys.path.insert(0, str(REPO_ROOT / "tests"))

import bridge_client  # noqa: E402
import bridge_server  # noqa: E402
from bridge_security import (  # noqa: E402
    AGENT_HEADER,
    CLIENT_HEADER,
    PID_HEADER,
    TOKEN_HEADER,
    check_pid,
    process_running,
    token_path,
)
from test_bridge_auth import ORIGIN, Extension  # noqa: E402

from client import bridge_client as package_client  # noqa: E402
from client import mcp_server  # noqa: E402

HTTP_PORT = 0
STATUS_URL = ""
COMMAND_URL = ""
WS_URL = ""

# Processus client réel : identité de serveur MCP (set_identity, processus annoncé), une commande au pont de test,
# puis attente (session vivante) ou fin (session morte, comme un serveur MCP redémarré).
CHILD = r"""
import sys
sys.path.insert(0, sys.argv[1])
import bridge_client
bridge_client.API_URL = sys.argv[2]
me = bridge_client.set_identity(sys.argv[3])
print(me["id"], flush=True)
bridge_client.call_bridge("list-tabs", {}, 5.0, retry=False)
print("ok", flush=True)
if sys.argv[4] == "vivant":
    sys.stdin.readline()
"""


@pytest.fixture(autouse=True)
def fresh_sessions(monkeypatch):
    """Chaque test part d'un pont qui ne connaît aucune session."""
    monkeypatch.setattr(bridge_server, "client_processes", {})


def command(action: str, params: dict, headers: dict, timeout: float = 5.0) -> tuple[int, dict]:
    request = urllib.request.Request(
        COMMAND_URL,
        data=json.dumps({"action": action, "params": params, "timeout": timeout}).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            TOKEN_HEADER: token_path().read_text(encoding="ascii").strip(),
            **headers,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout + 10) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        with error:
            return error.code, json.loads(error.read().decode("utf-8"))


def identity_headers(agent: str, client_id: str, pid: int | None = None) -> dict:
    headers = {AGENT_HEADER: agent, CLIENT_HEADER: client_id}
    if pid is not None:
        headers[PID_HEADER] = str(pid)
    return headers


def dead_pid() -> int:
    process = subprocess.Popen([sys.executable, "-B", "-c", "pass"])
    process.wait(timeout=30)
    return process.pid


async def answer(extension: Extension, seen: list[dict]) -> None:
    """Extension simulée : note chaque commande reçue (avec « gone ») et répond aussitôt."""
    while True:
        received = await extension.receive()
        seen.append(received)
        await extension.send({"requestId": received["requestId"], "success": True, "data": {"ok": 1}})


def with_extension(scenario) -> list[dict]:
    seen: list[dict] = []

    async def run():
        async with connect(WS_URL, origin=ORIGIN) as websocket:
            extension = Extension(websocket)
            await extension.authenticate()
            responder = asyncio.ensure_future(answer(extension, seen))
            try:
                await asyncio.to_thread(scenario)
            finally:
                responder.cancel()

    asyncio.run(asyncio.wait_for(run(), 60))
    return seen


def test_process_liveness_is_proven_never_guessed():
    assert process_running(os.getpid())
    assert not process_running(dead_pid())
    assert check_pid("1234") == 1234
    for bad in (None, "", "0", "-5", "12a", "99999999999", 12):
        assert check_pid(bad) is None, bad


def test_restarted_mcp_server_learns_its_dead_session_never_a_live_one_nor_another_agent():
    """Redémarrage simulé avec de vrais processus : l'ancien serveur MCP (processus terminé) est signalé MORT à la
    nouvelle session du même agent ; une session vivante du même agent et la session morte d'un AUTRE agent jamais."""
    children: list[subprocess.Popen] = []

    def child(agent: str, mode: str) -> tuple[subprocess.Popen, str]:
        process = subprocess.Popen(
            [sys.executable, "-B", "-c", CHILD, str(REPO_ROOT / "client"), COMMAND_URL, agent, mode],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
        )
        children.append(process)
        assert process.stdout is not None
        client_id = process.stdout.readline().strip()
        assert process.stdout.readline().strip() == "ok"
        return process, client_id

    results: dict = {}

    def scenario():
        old, old_id = child("Claude", "mort")
        old.wait(timeout=30)
        live, live_id = child("Claude", "vivant")
        codex, codex_id = child("Codex", "mort")
        codex.wait(timeout=30)
        results.update(old=old_id, live=live_id, codex_id=codex_id)
        # Nouvelle session de Claude (serveur MCP relancé) : premier battement.
        results["fresh"] = command(
            "heartbeat", {"reclaim": True}, identity_headers("Claude", "claude-nouvelle-1", os.getpid())
        )
        results["codex_beat"] = command("heartbeat", {}, identity_headers("Codex", "codex-nouvelle-1", os.getpid()))
        assert live.stdin is not None
        live.stdin.write("\n")
        live.stdin.flush()
        live.wait(timeout=30)
        results["after"] = command("list-tabs", {}, identity_headers("Claude", "claude-nouvelle-1", os.getpid()))

    try:
        seen = with_extension(scenario)
    finally:
        for process in children:
            if process.poll() is None:
                process.kill()
    assert results["fresh"][0] == 200 and results["codex_beat"][0] == 200
    by_client = {(m["client"]["id"], m["action"]): m for m in seen}
    # Les processus clients annoncent leur processus : identités de serveur MCP, chacune la sienne.
    assert {results["old"], results["live"], results["codex_id"]} <= {m["client"]["id"] for m in seen}
    beat = by_client[("claude-nouvelle-1", "heartbeat")]
    assert beat["params"] == {"reclaim": True}
    assert beat["gone"] == [results["old"]]  # ni la session vivante, ni celle de Codex
    assert by_client[("codex-nouvelle-1", "heartbeat")]["gone"] == [results["codex_id"]]
    # La session vivante qui s'arrête à son tour devient morte, elle aussi.
    assert sorted(by_client[("claude-nouvelle-1", "list_tabs")]["gone"]) == sorted([results["old"], results["live"]])
    # La première session ne connaissait encore aucune session morte.
    assert "gone" not in by_client[(results["old"], "list_tabs")]


def test_session_without_pid_is_never_reported_dead():
    def scenario():
        assert command("list-tabs", {}, identity_headers("CLI", "cli-local"))[0] == 200
        assert command("list-tabs", {}, identity_headers("CLI", "cli-autre", os.getpid()))[0] == 200

    seen = with_extension(scenario)
    assert all("gone" not in message for message in seen)
    assert bridge_server.client_processes[("CLI", "cli-local")] is None


def test_mcp_session_announces_its_process_the_cli_does_not(monkeypatch):
    sent: list[dict] = []

    def urlopen(request, timeout=None):
        sent.append({k.lower(): v for k, v in request.header_items()})
        raise urllib.error.URLError(ConnectionRefusedError())

    monkeypatch.setattr(package_client.urllib.request, "urlopen", urlopen)
    first = package_client.identity()
    with pytest.raises(ConnectionError):
        package_client.call_bridge("list-tabs", {}, 1.0, retry=False)
    assert sent[-1][PID_HEADER.lower()] == str(os.getpid())  # serveur MCP importé : set_identity
    monkeypatch.setattr(package_client, "_session_pid", None)  # identité stable (CLI)
    with pytest.raises(ConnectionError):
        package_client.call_bridge("list-tabs", {}, 1.0, retry=False)
    assert PID_HEADER.lower() not in sent[-1]
    assert first == package_client.identity()


def test_heartbeat_never_starts_bridge_or_chrome_and_reclaims_once(monkeypatch):
    calls: list[tuple] = []
    started: list[str] = []
    monkeypatch.setattr(bridge_client, "ensure_bridge_running", lambda: started.append("pont") or True)
    monkeypatch.setattr(bridge_client, "ensure_chrome_running", lambda timeout=6.0: started.append("chrome") or True)

    def urlopen(request, timeout=None):
        calls.append(json.loads(request.data.decode("utf-8"))["params"])
        raise urllib.error.URLError(ConnectionRefusedError())

    monkeypatch.setattr(bridge_client.urllib.request, "urlopen", urlopen)
    with pytest.raises(ConnectionError):
        bridge_client.heartbeat(reclaim=True)
    assert calls == [{"reclaim": True}] and started == []
    assert bridge_client.is_read_only_action("heartbeat")  # permis pendant l'arrêt d'urgence

    beats: list[bool] = []
    done = threading.Event()

    def fake_heartbeat(reclaim=False):
        beats.append(reclaim)
        if len(beats) == 1:
            raise ConnectionError("pont arrêté")  # échec : la reprise est retentée au battement suivant
        if len(beats) >= 4:
            done.set()
        return {"reclaimed": [7] if reclaim else []}

    monkeypatch.setattr(bridge_client, "heartbeat", fake_heartbeat)
    stop = threading.Event()
    thread = bridge_client.start_heartbeat(interval_s=0.01, stop=stop)
    try:
        assert done.wait(5)
    finally:
        stop.set()
        thread.join(5)
    assert not thread.is_alive()
    assert beats[:4] == [True, True, False, False]
    assert round(bridge_client.SESSION_DEAD_S) == 97 and round(bridge_client.HEARTBEAT_S) == 37


def test_mcp_server_starts_its_heartbeat_and_documents_orphans():
    source = (REPO_ROOT / "client" / "mcp_server.py").read_text(encoding="utf-8")
    main = source[source.index('if __name__ == "__main__":') :]
    assert "start_heartbeat()" in main
    assert '"orphan"' in (mcp_server.browser_list_tabs.__doc__ or "")
    assert "without user_asked" in (mcp_server.browser_adopt_tab.__doc__ or "")


def test_cdp_send_page_world_only_on_explicit_request(monkeypatch):
    sent: list[dict] = []
    monkeypatch.setattr(mcp_server, "call_bridge", lambda action, params, timeout=20.0: sent.append(params) or {})
    mcp_server.browser_cdp_send("Runtime.evaluate", {"expression": "1"}, tab_id=3)
    mcp_server.browser_cdp_send("Runtime.evaluate", {"expression": "window.__INITIAL_STATE__"}, tab_id=3, world="page")
    assert "world" not in sent[0]
    assert sent[1] == {
        "method": "Runtime.evaluate",
        "commandParams": {"expression": "window.__INITIAL_STATE__"},
        "tab_id": 3,
        "world": "page",
    }
    schema = {tool.name: tool for tool in asyncio.run(mcp_server.browser_mcp.list_tools())}[
        "browser_cdp_send"
    ].input_schema
    assert schema["properties"]["world"]["enum"] == ["isolated", "page"]
    assert schema["properties"]["world"]["default"] == "isolated"
    assert "PAGE WORLD" in (mcp_server.browser_cdp_send.__doc__ or "")


def test_cookie_values_only_on_explicit_request(monkeypatch):
    sent: list[dict] = []
    monkeypatch.setattr(mcp_server, "call_bridge", lambda action, params, timeout=20.0: sent.append(params) or {})
    mcp_server.browser_get_cookies(tab_id=4)
    mcp_server.browser_get_cookies(tab_id=4, urls=["http://localhost:8000/"], include_values=True)
    assert sent == [{"tab_id": 4}, {"tab_id": 4, "urls": ["http://localhost:8000/"], "includeValues": True}]
    assert "local development origin" in (mcp_server.browser_get_cookies.__doc__ or "")
