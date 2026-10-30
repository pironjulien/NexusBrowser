"""Black-box regressions for the native MCP engine, against a disposable bridge.

The process under test executes the C# tool handlers and guardrails. The bridge is
an HTTP boundary stub: no real browser, user token, service or journal is touched.
"""

from __future__ import annotations

import base64
import io
import json
import os
import queue
import re
import socket
import subprocess
import threading
import urllib.error
import urllib.request
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest
from PIL import Image
from test_native_csharp import _free_port_pair, _published_exe


class NativeSession:
    def __init__(self, process: subprocess.Popen[str]) -> None:
        self.process = process
        self.responses: queue.Queue[dict[str, Any]] = queue.Queue()
        self.identifier = 0

        def read() -> None:
            assert process.stdout is not None
            for line in process.stdout:
                if line.strip():
                    self.responses.put(json.loads(line))

        self.reader = threading.Thread(target=read, daemon=True)
        self.reader.start()

    def call(self, name: str, **arguments: Any) -> dict[str, Any]:
        self.identifier += 1
        assert self.process.stdin is not None
        self.process.stdin.write(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": self.identifier,
                    "method": "tools/call",
                    "params": {"name": name, "arguments": arguments},
                }
            )
            + "\n"
        )
        self.process.stdin.flush()
        response = self.responses.get(timeout=15)
        assert response["id"] == self.identifier
        assert "error" not in response, response
        return response["result"]


def payload(result: dict[str, Any]) -> dict[str, Any]:
    return json.loads(result["content"][0]["text"])


def accord(result: dict[str, Any]) -> str:
    answer = payload(result)
    assert answer["accord_required"] is True, answer
    found = re.search(r'accord="([a-f0-9]+)"', answer["error"])
    assert found, answer
    return found[1]


@contextmanager
def native_session(tmp_path: Path, answer: Any):
    commands: list[dict[str, Any]] = []
    credential = "p" * 64

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:
            pass

        def do_POST(self) -> None:
            assert self.headers.get("X-Nexus-Browser-Token") == credential
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if request["action"] == "heartbeat":
                data = {}
            else:
                commands.append(request)
                data = answer(request["action"], request["params"])
            status = 200
            response: dict[str, Any] = {"success": True, "data": data}
            if isinstance(data, Exception):
                status = 400
                response = {"success": False, "error": str(data)}
            encoded = json.dumps(response).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            try:
                self.wfile.write(encoded)
            except (BrokenPipeError, ConnectionResetError):
                pass  # A cancelled native request closes its HTTP connection.

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    token_path = tmp_path / "bridge-token"
    token_path.write_text(credential, encoding="ascii")
    env = {
        **os.environ,
        "NEXUS_BROWSER_HTTP_PORT": str(server.server_port),
        "NEXUS_BROWSER_TOKEN_FILE": str(token_path),
        "NEXUS_JOURNAL_HOME": str(tmp_path / "journal"),
        "NEXUS_SHARED_HOME": str(tmp_path / "shared"),
        "USERPROFILE": str(tmp_path / "home"),
    }
    process = subprocess.Popen(
        [str(_published_exe()), "--mcp", "--agent", "Codex"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        env=env,
    )
    try:
        yield NativeSession(process), commands
    finally:
        if process.stdin is not None:
            process.stdin.close()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        for stream in (process.stdout, process.stderr):
            if stream is not None:
                stream.close()
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def trigger(**overrides: Any) -> dict[str, Any]:
    return {
        "result": {
            "value": {
                "success": True,
                "label": "Send",
                "clickable": True,
                "form": True,
                "fields": [{"label": "Message", "type": "text", "value": "Hello"}],
                "recipients": ["recipient@example.test"],
                "tabUrl": "https://example.test/send?token=never-shown",
                **overrides,
            }
        }
    }


@pytest.mark.parametrize(
    ("name", "arguments"),
    [
        ("browser_click", {"selector": "button"}),
        ("browser_fill", {"selector": "input", "value": "Hello", "keys": ["Enter"]}),
        ("browser_press_key", {"key": "Control+Enter"}),
        ("browser_type_keys", {"text": "Hello\n"}),
        ("browser_drag_and_drop", {"from_selector": "#slider", "to_selector": "#end"}),
    ],
)
def test_outward_gestures_are_read_then_refused(tmp_path, name, arguments):
    with native_session(tmp_path, lambda _action, _params: trigger()) as (client, commands):
        result = client.call(name, tab_id=7, **arguments)
        accord(result)
        assert all(command["action"] == "cdp-send" for command in commands)
        assert "never-shown" not in payload(result)["error"]


def test_accord_is_bound_single_use_and_restored_for_an_unsent_gesture(tmp_path):
    recipient = "first@example.test"
    covered = False

    def respond(action, _params):
        if action == "cdp-send":
            return trigger(recipients=[recipient])
        return RuntimeError("Element is covered. Nothing was sent.") if covered else {"method": "cdp"}

    with native_session(tmp_path, respond) as (client, commands):
        token = accord(client.call("browser_click", tab_id=7, selector="button"))
        recipient = "changed@example.test"
        changed = client.call("browser_click", tab_id=7, selector="button", confirm=True, accord=token)
        assert "action changed" in payload(changed)["error"]
        assert not any(c["action"] == "click" for c in commands)
        token = accord(changed)
        covered = True
        blocked = client.call("browser_click", tab_id=7, selector="button", confirm=True, accord=token)
        assert payload(blocked)["accord_kept"] is True
        covered = False
        accepted = client.call("browser_click", tab_id=7, selector="button", confirm=True, accord=token)
        assert accepted["isError"] is False
        accord(client.call("browser_click", tab_id=7, selector="button", confirm=True, accord=token))
        assert sum(c["action"] == "click" for c in commands) == 2


def test_unreadable_trigger_does_not_send_and_neutral_click_stays_available(tmp_path):
    readable = False

    def respond(action, _params):
        if action == "cdp-send":
            return trigger(label="Next") if readable else {"exceptionDetails": {"text": "unreachable"}}
        return {"method": "cdp"}

    with native_session(tmp_path, respond) as (client, commands):
        failed = client.call("browser_click", tab_id=7, selector="button")
        assert failed["isError"] is True
        assert "trigger could not be read" in payload(failed)["error"]
        assert not any(c["action"] == "click" for c in commands)
        readable = True
        assert client.call("browser_click", tab_id=7, selector="button")["isError"] is False


def test_cancelled_request_never_sends_a_gesture_after_a_late_probe(tmp_path):
    reading = threading.Event()
    release = threading.Event()

    def respond(_action, _params):
        reading.set()
        release.wait(timeout=5)
        return trigger(label="Next")

    try:
        with native_session(tmp_path, respond) as (client, commands):
            assert client.process.stdin is not None
            client.process.stdin.write(
                json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "tools/call",
                        "params": {"name": "browser_click", "arguments": {"tab_id": 7, "selector": "button"}},
                    }
                )
                + "\n"
            )
            client.process.stdin.flush()
            assert reading.wait(timeout=5)
            client.process.stdin.write(
                '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}\n'
            )
            client.process.stdin.flush()
            response = client.responses.get(timeout=3)
            assert response["id"] == 1
            assert response["result"]["isError"] is True
            release.set()
            assert all(command["action"] == "cdp-send" for command in commands)
    finally:
        release.set()


def test_fill_form_validates_before_gestures_and_reads_final_values(tmp_path):
    later_field_filled = False

    def respond(action, params):
        nonlocal later_field_filled
        if action == "fill":
            later_field_filled |= params["mark"] == 2
            return {"verified": True}
        assert action == "field-state"
        return {"verified": not (params["mark"] == 1 and later_field_filled), "value": "changed"}

    with native_session(tmp_path, respond) as (client, commands):
        invalid = client.call("browser_fill_form", tab_id=7, fields=[{"mark": 1, "value": "a"}, {"mark": 2}])
        assert invalid["isError"] is True
        assert commands == []
        failed = client.call(
            "browser_fill_form", tab_id=7, fields=[{"mark": 1, "value": "a"}, {"mark": 2, "value": "b"}]
        )
        data = payload(failed)["data"]
        assert failed["isError"] is True
        assert data["all_verified"] is False
        assert data["fields"][0]["final_verified"] is False
        assert data["fields"][1]["final_verified"] is True
        assert [c["action"] for c in commands] == [
            "fill",
            "field-state",
            "fill",
            "field-state",
            "field-state",
            "field-state",
        ]


def test_fill_form_stops_after_unverified_gesture(tmp_path):
    def respond(action, _params):
        return {"verified": action != "fill"}

    with native_session(tmp_path, respond) as (client, commands):
        result = client.call(
            "browser_fill_form", tab_id=7, fields=[{"mark": 1, "value": "a"}, {"mark": 2, "value": "b"}]
        )
        assert result["isError"] is True
        assert sum(c["action"] == "fill" for c in commands) == 1


def test_data_schema_rejects_wrong_shape_without_losing_answer(tmp_path):
    data: Any = []
    with native_session(tmp_path, lambda _action, _params: data) as (client, _commands):
        good = client.call("browser_list_tabs")
        assert good["structuredContent"]["data"] == []
        data = {"tabs": []}
        wrong = client.call("browser_list_tabs")
        assert wrong["isError"] is True
        assert "output schema" in payload(wrong)["error"]
        assert payload(wrong)["data"] == data
        assert "structuredContent" not in wrong
        stopped = client.call(
            "browser_batch",
            steps=[{"tool": "browser_list_tabs", "args": {}}, {"tool": "browser_close_tab", "args": {"tab_id": 7}}],
        )
        assert stopped["isError"] is True
        assert payload(stopped)["stopped_at"] == 0


def test_webmcp_uses_isolated_probe_checks_schema_and_requires_accord(tmp_path):
    called = False

    def respond(action, params):
        nonlocal called
        assert action == "cdp-send"
        expression = params["commandParams"]["expression"]
        spec = json.loads(expression.rsplit(")(", 1)[1][:-1])
        definition = {
            "name": "send_email",
            "origin": "https://example.test",
            "annotations": {"readOnlyHint": True},
            "inputSchema": {"type": "object", "required": ["to"], "properties": {"to": {"type": "string"}}},
            "key": "stable-definition",
        }
        page = {"supported": True, "url": "https://example.test/mail"}
        if "key" in spec:
            called = True
            return {"result": {"value": {**page, "success": True, "output": '{"sent":true}'}}}
        return {"result": {"value": {**page, "tool": definition}}}

    with native_session(tmp_path, respond) as (client, _commands):
        invalid = client.call("browser_webmcp_call", tab_id=7, tool="send_email", input={"to": 42})
        assert invalid["isError"] is True
        assert "inputSchema" in payload(invalid)["error"]
        assert called is False
        args = {"tab_id": 7, "tool": "send_email", "input": {"to": "recipient@example.test"}}
        token = accord(client.call("browser_webmcp_call", **args))
        assert called is False
        completed = client.call("browser_webmcp_call", **args, confirm=True, accord=token)
        assert completed["isError"] is False
        assert payload(completed)["data"]["output"] == {"sent": True}
        assert called is True


def test_capture_inline_is_resized_attached_deduplicated_and_zoomable(tmp_path):
    stream = io.BytesIO()
    Image.new("RGB", (4000, 1800), "white").save(stream, format="PNG")
    data_url = "data:image/png;base64," + base64.b64encode(stream.getvalue()).decode()

    def respond(action, _params):
        assert action == "screenshot"
        return {"dataUrl": data_url, "devicePixelRatio": 1, "zoom": 1}

    with native_session(tmp_path, respond) as (client, commands):
        first = client.call("browser_screenshot", tab_id=7, inline=True)
        block = first["content"][1]
        assert block["type"] == "image"
        assert block["mimeType"] == "image/webp"
        encoded = base64.b64decode(block["data"])
        assert len(encoded) <= 500_000
        with Image.open(io.BytesIO(encoded)) as image:
            assert max(image.size) <= 2000
            assert image.width * image.height <= 2_560_000
        again = client.call("browser_screenshot", tab_id=7, inline=True)
        assert len(again["content"]) == 1
        assert payload(again)["data"]["image"]["unchanged"] is True
        assert len(client.call("browser_screenshot", tab_id=7, inline=True, force=True)["content"]) == 2
        zoomed = client.call("browser_screenshot", tab_id=7, inline=True, region=[0, 0, 100, 100])
        assert zoomed["isError"] is False
        assert commands[-1]["params"]["region"]["width"] == 200


def test_gsuite_binary_is_written_without_base64_in_answer(tmp_path):
    def respond(action, _params):
        assert action == "export-gsuite"
        return {
            "binary": True,
            "base64": base64.b64encode(b"export bytes").decode(),
            "filename": "report.docx",
            "extension": "docx",
        }

    with native_session(tmp_path, respond) as (client, _commands):
        result = client.call("browser_export_gsuite", tab_id=7)
        assert result["isError"] is False
        data = payload(result)["data"]
        assert "base64" not in data
        destination = Path(data["output_path"])
        assert destination.read_bytes() == b"export bytes"
        assert destination.is_relative_to(tmp_path)


def test_download_timestamp_keeps_all_64_bits(tmp_path):
    since = 1_793_307_654_321
    with native_session(tmp_path, lambda _action, _params: {}) as (client, commands):
        result = client.call("browser_wait_download", tab_id=7, since_ms=since)
        assert result["isError"] is False
        assert commands[0]["params"]["since"] == since


def test_native_bridge_update_refuses_developer_checkout_honestly(tmp_path):
    token = "b" * 64
    token_file = tmp_path / "token"
    token_file.write_text(token)
    port = _free_port_pair()
    env = {**os.environ, "NEXUS_STATUS_DIR": str(tmp_path / "status"), "NEXUS_SHARED_HOME": str(tmp_path / "shared")}
    process = subprocess.Popen(
        [
            str(_published_exe()),
            "--bridge",
            "--port",
            str(port),
            "--token-file",
            str(token_file),
            "--log-file",
            str(tmp_path / "bridge.log"),
        ],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    endpoint = f"http://127.0.0.1:{port + 1}/api/update"
    headers = {"X-Nexus-Browser-Token": token}
    try:
        # The native banner is emitted after both listeners are bound. Probing
        # before bind can self-connect when client and server ephemeral ports
        # coincide: the client then receives its own HTTP request as a response.
        ready: queue.Queue[bytes] = queue.Queue()
        output = process.stdout
        assert output is not None
        threading.Thread(target=lambda: ready.put(output.readline()), daemon=True).start()
        assert ready.get(timeout=10).startswith(b"===")
        with urllib.request.urlopen(urllib.request.Request(endpoint, headers=headers), timeout=3) as response:
            assert json.load(response)["product"] == "browser"
        with pytest.raises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(urllib.request.Request(endpoint, data=b"{}", headers=headers), timeout=3)
        assert error.value.code == 409
        refused = json.load(error.value)
        error.value.close()
        assert refused["success"] is False
        assert "Developer checkout" in refused["message"]
        assert json.loads((tmp_path / "status" / "browser.json").read_text())["state"] == "idle"
    finally:
        process.terminate()
        process.wait(timeout=5)
        if process.stderr is not None:
            process.stderr.close()
        if process.stdout is not None:
            process.stdout.close()


def test_http_health_and_sessions_cannot_be_claimed_by_another_agent(tmp_path):
    token = "d" * 64
    env = {
        **os.environ,
        "NEXUS_MCP_TOKEN": token,
        "NEXUS_SHARED_HOME": str(tmp_path / "shared"),
        "NEXUS_BROWSER_SESSION_IDLE_SECONDS": "0.25",
    }
    # Reserve a disposable port only for this process; no user daemon is stopped.
    import socket

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    process = subprocess.Popen(
        [str(_published_exe()), "--http", str(port)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE
    )
    base = f"http://127.0.0.1:{port}"

    def request(path, data=None, session=None):
        headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}
        if session:
            headers["mcp-session-id"] = session
        return urllib.request.urlopen(urllib.request.Request(base + path, data=data, headers=headers), timeout=3)

    try:
        import time

        deadline = time.monotonic() + 10
        while True:
            try:
                with urllib.request.urlopen(base + "/health", timeout=1) as response:
                    health = json.load(response)
                break
            except (urllib.error.URLError, TimeoutError):
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.05)
        assert health["status"] == "ok"
        assert health["service"] == "nexus-browser"
        assert health["runtime"] == "native"
        initialize = json.dumps(
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}}
        ).encode()
        with request("/mcp?agent=codex", initialize) as response:
            session = response.headers["mcp-session-id"]
        discover = b'{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
        with pytest.raises(urllib.error.HTTPError) as error:
            request("/mcp?agent=claude", discover, session)
        assert error.value.code == 404
        error.value.close()
        with request("/mcp?agent=codex", discover, session) as response:
            assert len(json.load(response)["result"]["tools"]) == 49
        time.sleep(0.35)  # The configured idle lease has elapsed, without refreshing it by polling.
        with pytest.raises(urllib.error.HTTPError) as expired:
            request("/mcp?agent=codex", discover, session)
        assert expired.value.code == 404
        expired.value.close()
    finally:
        process.terminate()
        process.wait(timeout=5)
        if process.stderr is not None:
            process.stderr.close()


def test_duplicate_http_port_exits_with_a_diagnostic_instead_of_crashing(tmp_path):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        port = listener.getsockname()[1]
        env = {**os.environ, "NEXUS_MCP_TOKEN": "x" * 64, "USERPROFILE": str(tmp_path)}
        result = subprocess.run(
            [str(_published_exe()), "--http", str(port)],
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=10,
        )
    assert result.returncode == 1
    assert result.stderr.startswith("NexusBrowser:")
    assert "Unhandled exception" not in result.stderr
    log = tmp_path / ".nexus" / "nexus-browser" / "engine.log"
    assert "SocketException" in log.read_text(encoding="utf-8")


def test_isolated_missing_extension_is_not_replayed_or_used_to_open_chrome(tmp_path):
    with native_session(
        tmp_path,
        lambda _action, _params: RuntimeError("No Chrome browser extension connected to the NexusBrowser bridge."),
    ) as (client, commands):
        result = client.call("browser_new_tab", url="about:blank")
        assert result["isError"] is True
        assert "no action was sent" in payload(result)["error"]
        assert [command["action"] for command in commands] == ["create-tab"]
