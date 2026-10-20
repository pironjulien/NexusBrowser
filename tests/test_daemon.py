"""Démon partagé (--http) : une identité par session MCP (ses onglets), agent par URL, jeton exigé, sessions battues."""

import asyncio
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
from contextlib import AsyncExitStack
from pathlib import Path
from types import SimpleNamespace

import pytest
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.shared._httpx_utils import create_mcp_http_client

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "native-host"))

from bridge_security import AGENT_HEADER, CLIENT_HEADER, PID_HEADER  # noqa: E402

from client import bridge_client, mcp_server  # noqa: E402

TOKEN = "b" * 40


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_session_identity_is_sent_without_process(monkeypatch):
    """En démon, la commande porte l'identité de la session MCP et aucun processus (le démon vit pour toutes)."""
    sent: list[dict] = []

    def urlopen(request, timeout=None):
        sent.append({k.lower(): v for k, v in request.header_items()})
        raise urllib.error.URLError(ConnectionRefusedError())

    monkeypatch.setattr(bridge_client.urllib.request, "urlopen", urlopen)
    ident = bridge_client.session_identity("Codex", "0123456789abcdef0123456789abcdef")
    assert ident == {"agent": "Codex", "id": "codex-0123456789abcdef01234567"}
    token = bridge_client._SESSION_IDENTITY.set(ident)
    try:
        with pytest.raises(ConnectionError):
            bridge_client.call_bridge("list-tabs", {}, 1.0, retry=False)
        assert bridge_client.identity() == ident
    finally:
        bridge_client._SESSION_IDENTITY.reset(token)
    assert sent[-1][AGENT_HEADER.lower()] == "Codex"
    assert sent[-1][CLIENT_HEADER.lower()] == ident["id"]
    assert PID_HEADER.lower() not in sent[-1]
    assert bridge_client.identity()["id"] != ident["id"]  # hors requête : identité du processus


def test_bind_session_sets_identity_per_request():
    seen: list[dict] = []

    async def call_next(ctx):
        seen.append(bridge_client.identity())
        return None

    def ctx(agent: str, session: str):
        request = SimpleNamespace(headers={"mcp-session-id": session}, query_params={"agent": agent})
        return SimpleNamespace(request=request)

    asyncio.run(mcp_server._bind_session(ctx("claude", "a" * 32), call_next))
    asyncio.run(mcp_server._bind_session(ctx("antigravity", "b" * 32), call_next))
    assert [s["agent"] for s in seen] == ["Claude", "Antigravity"]
    assert seen[0]["id"] != seen[1]["id"]
    assert mcp_server._SESSION_AGENTS["a" * 32] == "Claude"


def test_bind_session_without_mcp_session_keeps_the_agent():
    """Protocole 2026-07-28 sans état (Claude Code) : pas d'en-tête mcp-session-id, l'agent de l'URL reste le sien."""
    seen: list[dict] = []

    async def call_next(ctx):
        seen.append(bridge_client.identity())
        return None

    def ctx(agent: str, method: str = "tools/call"):
        request = SimpleNamespace(headers={}, query_params={"agent": agent})
        return SimpleNamespace(request=request, method=method)

    for call in (ctx("claude"), ctx("claude"), ctx("codex"), ctx("claude", "initialize")):
        asyncio.run(mcp_server._bind_session(call, call_next))
    assert [s["agent"] for s in seen[:3]] == ["Claude", "Claude", "Codex"]
    assert seen[0]["id"] == seen[1]["id"] != seen[2]["id"]  # stable par agent, distincte entre agents
    assert seen[3]["id"] == mcp_server.CLIENT_IDENTITY["id"]  # initialize d'un client à sessions : processus
    assert {"Claude", "Codex"} <= set(mcp_server._STATELESS_SESSIONS)


def test_session_heartbeats_reclaim_once_and_drop_closed(monkeypatch):
    beats: list[tuple[str, bool]] = []
    monkeypatch.setattr(
        bridge_client, "heartbeat", lambda reclaim: beats.append((bridge_client.identity()["id"], reclaim))
    )
    live = {"s1": bridge_client.session_identity("Claude", "1" * 32)}
    stop = threading.Event()
    bridge_client.start_session_heartbeats(lambda: dict(live), interval_s=0.05, stop=stop)
    time.sleep(0.2)
    live["s2"] = bridge_client.session_identity("Codex", "2" * 32)
    time.sleep(0.2)
    del live["s1"]
    count = len(beats)
    time.sleep(0.2)
    stop.set()
    one, two = "claude-" + "1" * 24, "codex-" + "2" * 24
    assert (one, True) in beats and (two, True) in beats  # première fois : reprise des orphelins
    assert [r for i, r in beats if i == one].count(True) == 1
    assert all(i != one for i, _ in beats[count + 1 :])  # session fermée : plus battue


def test_daemon_token_agent_and_two_sessions(tmp_path):
    port = _free_port()
    env = {**os.environ, "NEXUS_MCP_TOKEN": TOKEN, "HOME": str(tmp_path), "USERPROFILE": str(tmp_path)}
    proc = subprocess.Popen(
        [sys.executable, "-B", str(REPO_ROOT / "client" / "mcp_server.py"), "--http", str(port)],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    try:
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                socket.create_connection(("127.0.0.1", port), 0.5).close()
                break
            except OSError:
                time.sleep(0.2)

        async def tools(agent: str, token: str = TOKEN) -> set[str]:
            async with AsyncExitStack() as stack:
                client = await stack.enter_async_context(
                    create_mcp_http_client(headers={"Authorization": f"Bearer {token}"})
                )
                url = f"http://127.0.0.1:{port}/mcp" + (f"?agent={agent}" if agent else "")
                read, write = await stack.enter_async_context(streamable_http_client(url, http_client=client))
                session = await stack.enter_async_context(ClientSession(read, write))
                await session.initialize()
                return {t.name for t in (await session.list_tools()).tools}

        async def check() -> None:
            both = await asyncio.wait_for(asyncio.gather(tools("claude"), tools("codex")), 60)
            assert all("browser_new_tab" in t for t in both)
            for bad in (("", TOKEN), ("claude", "x" * 40)):
                with pytest.raises(Exception):  # noqa: B017 - 400 (agent) ou 401 (jeton) en erreur de transport
                    await asyncio.wait_for(tools(*bad), 30)

        asyncio.run(check())
    finally:
        proc.terminate()
        _, err = proc.communicate(timeout=10)
        assert b"Traceback" not in err, err.decode(errors="replace")[-2000:]
