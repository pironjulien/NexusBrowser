"""Tests boîte noire du moteur unifié C# (.NET 10) de NexusBrowser (native/NexusBrowser.csproj -> NexusBrowser.exe).

Vérifie :
1. L'étanchéité OneDrive : Directory.Build.props déporte bin/ et obj/ sous %LOCALAPPDATA%\\NexusBrowser\\build\\.
2. L'autotest intégré (NexusBrowser.exe --selftest).
3. L'interopérabilité cryptographique exacte (nexus-browser/1) entre Python (bridge_auth.py) et C# (--auth-host).
4. Le pont C# (--bridge) en sous-processus réel face au client WebSocket et HTTP Python.
5. Le serveur MCP C# (--mcp) en stdio (server/discover 2026-07-28, tools/list des 49 outils, tools/call).
"""

from __future__ import annotations

import asyncio
import functools
import json
import os
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import pytest
from websockets import connect
from websockets.typing import Origin

REPO_ROOT = Path(__file__).resolve().parent.parent
NATIVE_DIR = REPO_ROOT / "native"
sys.path.insert(0, str(REPO_ROOT / "native-host"))

from bridge_auth import (  # noqa: E402
    PROTOCOL,
    Channel,
    b64url,
    client_proof,
    new_nonce,
    server_proof,
    session_key,
)
from bridge_security import (  # noqa: E402
    AGENT_HEADER,
    CLIENT_HEADER,
    TOKEN_HEADER,
    load_or_create_token,
)

EXTENSION_ID = (
    json.loads((REPO_ROOT / "native-host/bridge_config.json").read_text(encoding="utf-8"))["allowed_origins"][0]
    .split("//")[1]
    .strip("/")
)
ORIGIN = Origin(f"chrome-extension://{EXTENSION_ID}")


@functools.lru_cache(maxsize=1)
def _published_exe() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    exe = Path(local_app_data) / "NexusBrowser" / "build" / "tests" / "native" / "NexusBrowser.exe"
    subprocess.run(
        [
            "dotnet",
            "publish",
            str(NATIVE_DIR / "NexusBrowser.csproj"),
            "-c",
            "Release",
            "-o",
            str(exe.parent),
            "--nologo",
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=120,
    )
    return exe


def _free_port_pair() -> int:
    """Trouve un port libre p tel que p et p + 1 soient disponibles sur 127.0.0.1."""
    for _ in range(50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s1:
            s1.bind(("127.0.0.1", 0))
            port = s1.getsockname()[1]
        try:
            with (
                socket.socket(socket.AF_INET, socket.SOCK_STREAM) as a,
                socket.socket(socket.AF_INET, socket.SOCK_STREAM) as b,
            ):
                a.bind(("127.0.0.1", port))
                b.bind(("127.0.0.1", port + 1))
                return port
        except OSError:
            continue
    raise RuntimeError("Unable to allocate consecutive ephemeral port pair")


def test_onedrive_isolation_and_build_props() -> None:
    props = (NATIVE_DIR / "Directory.Build.props").read_text(encoding="utf-8")
    assert "LocalApplicationData" in props
    assert r"NexusBrowser\build\bin" in props
    assert r"NexusBrowser\build\obj" in props
    assert not (NATIVE_DIR / "bin").exists()
    assert not (NATIVE_DIR / "obj").exists()


def test_csharp_selftest_passes() -> None:
    exe = _published_exe()
    res = subprocess.run(
        [str(exe), "--selftest"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
    )
    assert res.returncode == 0, f"stdout={res.stdout}\nstderr={res.stderr}"
    assert "OK: NexusBrowser C# unified engine selftest passed" in res.stdout
    assert not (NATIVE_DIR / "bin").exists()
    assert not (NATIVE_DIR / "obj").exists()


@pytest.mark.skipif(sys.platform != "win32", reason="Interactive Windows shell broker")
def test_chrome_startup_survives_caller_kill_on_job_close() -> None:
    """The real startup branch launches an invisible fixture, never the user's Chrome."""
    output = Path(os.environ["LOCALAPPDATA"]) / "NexusBrowser/build/tests/lifetime"
    subprocess.run(
        [
            "dotnet",
            "publish",
            str(REPO_ROOT / "tests/native_lifetime/LifetimeFixture.csproj"),
            "-c",
            "Release",
            "-o",
            str(output),
            "--nologo",
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=120,
    )
    result = subprocess.run(
        [str(output / "LifetimeFixture.exe"), "--test"], capture_output=True, text=True, encoding="utf-8", timeout=45
    )
    assert result.returncode == 0, f"stdout={result.stdout}\nstderr={result.stderr}"
    assert [json.loads(line) for line in result.stdout.splitlines()] == [
        {
            "ok": True,
            "broker": broker,
            "caller_in_job": True,
            "child_in_caller_job": not broker,
            "survived_job_close": broker,
            "child_normal_exit": broker,
        }
        for broker in (False, True)
    ]
    assert not (REPO_ROOT / "tests/native_lifetime/bin").exists()
    assert not (REPO_ROOT / "tests/native_lifetime/obj").exists()


def test_csharp_auth_host_interoperates_with_python_bridge_auth(tmp_path: Path) -> None:
    exe = _published_exe()
    token_file = tmp_path / "bridge-token"
    token = load_or_create_token(token_file)

    c_nonce = new_nonce()
    s_nonce = new_nonce()
    role = "service_worker"
    s_proof = server_proof(token, c_nonce, s_nonce, role, EXTENSION_ID)

    msg = {
        "op": "handshake",
        "client_nonce": c_nonce,
        "server_nonce": s_nonce,
        "role": role,
        "extension_id": EXTENSION_ID,
        "server_proof": s_proof,
    }
    raw_msg = json.dumps(msg).encode("utf-8")
    framed_in = struct.pack("<I", len(raw_msg)) + raw_msg

    res = subprocess.run(
        [
            str(exe),
            "--auth-host",
            "--token-file",
            str(token_file),
            f"chrome-extension://{EXTENSION_ID}/",
        ],
        input=framed_in,
        capture_output=True,
        timeout=15,
    )
    assert res.returncode == 0
    (length,) = struct.unpack("<I", res.stdout[:4])
    reply = json.loads(res.stdout[4 : 4 + length].decode("utf-8"))
    assert reply == {
        "ok": True,
        "client_proof": client_proof(token, c_nonce, s_nonce, role, EXTENSION_ID),
        "session_key": b64url(session_key(token, c_nonce, s_nonce, role, EXTENSION_ID)),
    }


@pytest.mark.skipif(sys.platform != "win32", reason="Chrome native messaging through Windows cmd.exe")
def test_chrome_cmd_console_preserves_native_message_streams(tmp_path: Path) -> None:
    """Chrome's cmd wrapper has a console: a WinExe must retain its redirected streams."""
    exe = _published_exe()
    incoming = tmp_path / "message.in"
    outgoing = tmp_path / "message.out"
    raw = json.dumps({"op": "unsupported"}).encode("utf-8")
    incoming.write_bytes(struct.pack("<I", len(raw)) + raw)
    command = f'""{exe}" chrome-extension://{EXTENSION_ID}/ --parent-window=0 < "{incoming}" > "{outgoing}""'
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = subprocess.SW_HIDE
    process = subprocess.Popen(
        f"{os.environ.get('COMSPEC', 'cmd.exe')} /d /s /c {command}",
        startupinfo=startup,
        creationflags=subprocess.CREATE_NEW_CONSOLE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        stdout, stderr = process.communicate(timeout=15)
    except subprocess.TimeoutExpired:
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(process.pid)], capture_output=True, check=False)
        process.communicate()
        raise
    assert process.returncode == 0, (stdout, stderr)
    reply = outgoing.read_bytes()
    length = struct.unpack("<I", reply[:4])[0]
    assert len(reply) == length + 4
    assert json.loads(reply[4:]) == {"ok": False, "error": "opération inconnue"}


def test_csharp_bridge_server_and_mcp_stdio(tmp_path: Path) -> None:
    exe = _published_exe()
    token_file = tmp_path / "bridge-token"
    token = load_or_create_token(token_file)
    ws_port = _free_port_pair()
    http_port = ws_port + 1

    env = {
        **os.environ,
        "NEXUS_BROWSER_TOKEN_FILE": str(token_file),
        "NEXUS_BROWSER_HTTP_PORT": str(http_port),
        "NEXUS_JOURNAL_HOME": str(tmp_path / "journal"),
        "NEXUS_SHARED_HOME": str(tmp_path / "shared"),
    }

    bridge_proc = subprocess.Popen(
        [
            str(exe),
            "--bridge",
            "--port",
            str(ws_port),
            "--token-file",
            str(token_file),
            "--log-file",
            str(tmp_path / "bridge.log"),
        ],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )

    try:
        status_url = f"http://127.0.0.1:{http_port}/api/status"
        command_url = f"http://127.0.0.1:{http_port}/api/command"
        deadline = time.monotonic() + 15.0
        while time.monotonic() < deadline:
            try:
                req = urllib.request.Request(status_url, headers={TOKEN_HEADER: token})
                with urllib.request.urlopen(req, timeout=1.0) as resp:
                    status = json.loads(resp.read().decode("utf-8"))
                    if status.get("status") == "online":
                        assert isinstance(status["chrome_running"], bool)
                        break
            except Exception:
                time.sleep(0.1)
        else:
            raise AssertionError("C# bridge server did not become ready in time")

        async def run_scenario() -> None:
            async with connect(f"ws://127.0.0.1:{ws_port}", origin=ORIGIN) as ws:
                c_nonce = new_nonce()
                await ws.send(
                    json.dumps(
                        {
                            "type": "auth_hello",
                            "protocol": PROTOCOL,
                            "client_nonce": c_nonce,
                            "role": "service_worker",
                            "extension_id": EXTENSION_ID,
                        }
                    )
                )
                challenge = json.loads(await ws.recv())
                s_nonce = challenge["server_nonce"]
                assert challenge["server_proof"] == server_proof(
                    token, c_nonce, s_nonce, "service_worker", EXTENSION_ID
                )
                await ws.send(
                    json.dumps(
                        {
                            "type": "auth_proof",
                            "client_proof": client_proof(token, c_nonce, s_nonce, "service_worker", EXTENSION_ID),
                        }
                    )
                )
                chan = Channel(session_key(token, c_nonce, s_nonce, "service_worker", EXTENSION_ID), "c2s", "s2c")
                ok_msg = json.loads(chan.open(json.loads(await ws.recv())))
                assert ok_msg == {"type": "auth_ok"}

                async def ext_responder() -> None:
                    while True:
                        raw = await ws.recv()
                        cmd = json.loads(chan.open(json.loads(raw)))
                        req_id = cmd["requestId"]
                        action = cmd["action"]
                        data: Any = {"ok": True}
                        if action == "list_tabs":
                            data = [
                                {
                                    "id": 7,
                                    "url": "https://julienpiron.fr",
                                    "title": "Julien",
                                    "active": True,
                                    "mine": True,
                                    "state": "mine",
                                }
                            ]
                        reply = chan.seal(json.dumps({"requestId": req_id, "success": True, "data": data}))
                        await ws.send(json.dumps(reply))

                responder_task = asyncio.ensure_future(ext_responder())
                try:
                    # 1. Refus de téléversement depuis un dossier de secrets (HTTP 403)
                    secret_path = str(Path.home() / ".ssh" / "id_ed25519")
                    upload_req = urllib.request.Request(
                        command_url,
                        data=json.dumps(
                            {"action": "upload", "params": {"files": [secret_path], "tab_id": 7}, "timeout": 5.0}
                        ).encode("utf-8"),
                        headers={
                            "Content-Type": "application/json",
                            TOKEN_HEADER: token,
                            AGENT_HEADER: "Claude",
                            CLIENT_HEADER: "claude-test1234",
                        },
                    )
                    try:
                        urllib.request.urlopen(upload_req, timeout=5.0)
                        raise AssertionError("Expected HTTPError 403")
                    except urllib.error.HTTPError as err:
                        assert err.code == 403
                        err.close()

                    # 2. Appel MCP stdio vers NexusBrowser.exe --mcp
                    mcp_lines = "\n".join(
                        [
                            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "server/discover"}),
                            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
                            json.dumps(
                                {
                                    "jsonrpc": "2.0",
                                    "id": 3,
                                    "method": "tools/call",
                                    "params": {"name": "browser_list_tabs", "arguments": {}},
                                }
                            ),
                        ]
                    )
                    mcp_res = await asyncio.to_thread(
                        subprocess.run,
                        [str(exe), "--mcp", "--agent", "Claude", "--token-file", str(token_file)],
                        input=mcp_lines + "\n",
                        capture_output=True,
                        text=True,
                        encoding="utf-8",
                        env=env,
                        timeout=20,
                    )
                    assert mcp_res.returncode == 0, mcp_res.stderr
                    out_lines = [json.loads(line) for line in mcp_res.stdout.splitlines() if line.strip()]
                    assert len(out_lines) == 3
                    assert out_lines[0]["result"]["protocolVersion"] == "2026-07-28"
                    assert len(out_lines[1]["result"]["tools"]) == 49
                    assert out_lines[2]["result"]["isError"] is False
                    assert out_lines[2]["result"]["structuredContent"]["data"][0]["id"] == 7
                finally:
                    responder_task.cancel()

        asyncio.run(asyncio.wait_for(run_scenario(), 30.0))
    finally:
        bridge_proc.terminate()
        try:
            bridge_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            bridge_proc.kill()
