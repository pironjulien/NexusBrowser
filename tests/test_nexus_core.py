import asyncio
import json
import re
import socket
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pytest
from websockets import connect
from websockets.exceptions import ConnectionClosedError
from websockets.typing import Origin

REPO_ROOT = Path(__file__).resolve().parent.parent
NATIVE_HOST_DIR = REPO_ROOT / "native-host"
sys.path.insert(0, str(NATIVE_HOST_DIR))

from bridge_security import (  # noqa: E402
    TOKEN_HEADER,
    VERSION,
    harden_token_permissions,
    load_or_create_token,
    rotate_token,
)

STATUS_URL = "http://127.0.0.1:9225/api/status"
COMMAND_URL = "http://127.0.0.1:9225/api/command"
HTTP_PORT = 0
WS_URL = ""


def request(url, *, token=None, origin=None, data=None):
    headers = {}
    if token:
        headers[TOKEN_HEADER] = token
    if origin:
        headers["Origin"] = origin
    if data is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(data).encode("utf-8")
    return urllib.request.Request(url, headers=headers, data=data)


def test_manifest_is_minimal_and_origins_are_explicit():
    extension = json.loads((REPO_ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))
    bridge_config = json.loads((NATIVE_HOST_DIR / "bridge_config.json").read_text(encoding="utf-8"))
    assert extension["manifest_version"] == 3
    assert set(extension["permissions"]) == {
        "debugger",
        "tabs",
        "webNavigation",  # panneau Antigravity : navigation de Julien sur un onglet adopté → onglet rendu
        "tabGroups",
        "scripting",
        "alarms",
        "downloads",
        "offscreen",
        "sidePanel",
        "storage",
        "nativeMessaging",  # hôte natif com.nexus.browser_auth : preuves du pont, jamais le jeton
    }
    assert bridge_config["allowed_origins"]
    assert all(re.fullmatch(r"chrome-extension://[a-p]{32}/", origin) for origin in bridge_config["allowed_origins"])


def test_extension_id_is_fixed_by_its_public_key():
    """Identifiant fixe, le même sur tous les PC et quel que soit le dossier chargé : tiré de la clé publique « key »
    du manifeste (SHA-256 de la clé DER, 32 premiers chiffres hexadécimaux écrits a à p). Seule cette origine ouvre le
    pont et l'hôte natif."""
    import base64
    import hashlib

    extension = json.loads((REPO_ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))
    digest = hashlib.sha256(base64.b64decode(extension["key"])).hexdigest()[:32]
    extension_id = "".join(chr(ord("a") + int(c, 16)) for c in digest)
    bridge_config = json.loads((NATIVE_HOST_DIR / "bridge_config.json").read_text(encoding="utf-8"))
    assert bridge_config["allowed_origins"] == [f"chrome-extension://{extension_id}/"]


def test_install_registers_the_three_agents_under_their_own_name():
    script = (REPO_ROOT / "install.ps1").read_text(encoding="utf-8")
    # Démon partagé : chaque client le joint par URL avec son agent (?agent=…), plus par NEXUS_BROWSER_AGENT.
    for agent in ("Antigravity",):  # Claude et Codex : par leurs plugins (catalogues « nexus »)
        assert f"Get-Url '{agent}'" in script
    assert "?agent=" in script and "nexus-browser.json" in script
    # Migration : l'ancien pont de NexusAGY (mêmes ports) et son hôte natif sont retirés.
    assert "Unregister-ScheduledTask -TaskName 'NexusAGY Browser Bridge'" in script
    assert "com.nexusagy.bridge_auth" in script


def test_versions_are_aligned():
    project_text = (REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    declared = re.search(r'^version\s*=\s*"([^"]+)"', project_text, re.MULTILINE)
    assert declared
    project_version = declared.group(1)
    extension = json.loads((REPO_ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))
    plugin = json.loads((REPO_ROOT / "plugins" / "nexus-browser" / "plugin.json").read_text(encoding="utf-8"))
    version_file = (REPO_ROOT / "VERSION").read_text(encoding="utf-8").strip()
    assert project_version == extension["version"] == plugin["version"] == VERSION == version_file


def test_no_utf8_bom_in_sources():
    for pattern in ("*.json", "*.py", "*.js", "*.ps1"):
        for file in REPO_ROOT.rglob(pattern):
            excluded = {".git", ".pytest_cache", ".ruff_cache", ".venv", "__pycache__"}
            if excluded.isdisjoint(file.parts):
                assert not file.read_bytes().startswith(b"\xef\xbb\xbf"), f"UTF-8 BOM detected in {file}"


def test_token_is_strong_and_stable(tmp_path):
    token_file = tmp_path / "bridge-token"
    first = load_or_create_token(token_file)
    second = load_or_create_token(token_file)
    assert first == second
    assert len(first) >= 43
    assert token_file.read_text(encoding="ascii").strip() == first


def test_token_rotation_replaces_the_credential(tmp_path):
    token_file = tmp_path / "bridge-token"
    first = load_or_create_token(token_file)
    second = rotate_token(token_file)
    assert second != first
    assert load_or_create_token(token_file) == second


def test_token_permission_hardening_is_idempotent(tmp_path):
    token_file = tmp_path / "bridge-token"
    token_file.write_text("x" * 64, encoding="ascii")
    harden_token_permissions(token_file)
    harden_token_permissions(token_file)


def raw_http_request(request_bytes):
    with socket.create_connection(("127.0.0.1", HTTP_PORT), timeout=3) as connection:
        connection.sendall(request_bytes)
        connection.shutdown(socket.SHUT_WR)
        response = b""
        while chunk := connection.recv(4096):
            response += chunk
    return response


def test_bridge_rejects_invalid_content_length_cleanly():
    token = load_or_create_token()
    response = raw_http_request(
        b"POST /api/command HTTP/1.1\r\n"
        + f"{TOKEN_HEADER}: {token}\r\n".encode("ascii")
        + b"Content-Length: invalid\r\n\r\n"
    )
    assert response.startswith(b"HTTP/1.1 400 Bad Request")
    assert b"Invalid Content-Length" in response


def test_bridge_rejects_wrong_method_with_allow_header():
    token = load_or_create_token()
    response = raw_http_request(
        b"GET /api/command HTTP/1.1\r\n" + f"{TOKEN_HEADER}: {token}\r\n".encode("ascii") + b"\r\n"
    )
    assert response.startswith(b"HTTP/1.1 405 Method Not Allowed")
    assert b"Allow: POST" in response


def test_bridge_rejects_unauthenticated_http():
    with pytest.raises(urllib.error.HTTPError) as error:
        urllib.request.urlopen(request(STATUS_URL), timeout=3)
    try:
        assert error.value.code == 401
        assert not error.value.headers.get("Access-Control-Allow-Origin")
    finally:
        error.value.close()


def test_bridge_rejects_web_origins_even_with_token():
    with pytest.raises(urllib.error.HTTPError) as error:
        urllib.request.urlopen(
            request(STATUS_URL, token=load_or_create_token(), origin="https://example.invalid"), timeout=3
        )
    try:
        assert error.value.code == 403
        assert not error.value.headers.get("Access-Control-Allow-Origin")
    finally:
        error.value.close()


def test_authenticated_bridge_status():
    token = load_or_create_token()
    with urllib.request.urlopen(request(STATUS_URL, token=token), timeout=3) as response:
        status = json.loads(response.read().decode("utf-8"))
    assert status["status"] == "online"
    assert status["version"] == VERSION
    assert status["connected_clients"] >= 0


def test_bridge_rejects_untrusted_websocket_origin():
    async def connect_from_web_page():
        async with connect(WS_URL, origin=Origin("https://example.invalid")) as websocket:
            await websocket.recv()

    with pytest.raises(ConnectionClosedError) as error:
        asyncio.run(connect_from_web_page())
    assert error.value.rcvd is not None
    assert error.value.rcvd.code == 1008


def test_mcp_server_tools_registered():
    from client.mcp_server import listed_tool_names, mcp

    tool_names = set(listed_tool_names(mcp))
    expected = {
        "browser_list_tabs",
        "browser_screenshot",
        "browser_click",
        "browser_hover",
        "browser_new_tab",
        "browser_close_tab",
        "browser_reload",
        "browser_group_tabs",
        "browser_wait_network_idle",
        "browser_get_cookies",
        "browser_cdp_send",
        "browser_interactive_map",
        "browser_drag_and_drop",
        "browser_eval",
        "browser_adopt_tab",
        "browser_release_tab",
        "browser_network_record",
        "browser_network_stop",
    }
    assert expected <= tool_names


def test_http_incomplete_headers_timeout(monkeypatch):
    import bridge_server

    monkeypatch.setattr(bridge_server, "HTTP_READ_TIMEOUT", 0.1)
    with socket.create_connection(("127.0.0.1", HTTP_PORT), timeout=3) as connection:
        connection.sendall(b"GET /api/status HTTP/1.1\r\n")
        assert connection.recv(4096).startswith(b"HTTP/1.1 408")


def test_http_authentication_precedes_body_read():
    response = raw_http_request(b"POST /api/command HTTP/1.1\r\nContent-Length: 100\r\n\r\n")
    assert response.startswith(b"HTTP/1.1 401")


def test_http_incomplete_body_is_explicit():
    response = raw_http_request(
        f"POST /api/command HTTP/1.1\r\n{TOKEN_HEADER}: {load_or_create_token()}\r\nContent-Length: 100\r\n\r\nx".encode()
    )
    assert response.startswith(b"HTTP/1.1 400")


@pytest.mark.parametrize(
    "action,key", [("screenshot", "dataUrl"), ("pdf", "pdfBase64"), ("vision-inspect", "screenshotDataUrl")]
)
def test_mcp_writes_requested_artifact(monkeypatch, tmp_path, action, key):
    import base64

    from client import mcp_server

    content = b"artifact-test-bytes"
    encoded = base64.b64encode(content).decode()
    if key != "pdfBase64":
        encoded = "data:image/png;base64," + encoded
    monkeypatch.setattr(mcp_server, "call_bridge", lambda *args: {key: encoded})
    output = tmp_path / "artifact"
    result = json.loads(mcp_server._call_bridge(action, {"output": str(output)}))
    assert result["status"] == "success"
    assert output.read_bytes() == content
    assert result["data"]["output_path"] == str(output.resolve())
    assert key not in result["data"]


def test_mcp_interactive_map_serialization(monkeypatch):
    from client import mcp_server

    fake_data = {"count": 1, "elements": [{"mark": 1, "tag": "button", "box_2d": [10, 20, 30, 40]}]}
    monkeypatch.setattr(mcp_server, "call_bridge", lambda action, params, timeout=20.0: fake_data)
    result = json.loads(mcp_server.browser_interactive_map(tab_id=1))
    assert result["status"] == "success"
    assert result["data"]["count"] == 1
    assert result["data"]["elements"][0]["mark"] == 1


def test_mcp_drag_and_drop_serialization(monkeypatch):
    from client import mcp_server

    fake_data = {"success": True, "from": {"x": 10, "y": 20}, "to": {"x": 30, "y": 40}, "steps": 12}
    from conftest import neutral_trigger_read

    def fake(action, params, timeout=20.0):
        read = neutral_trigger_read(action, params)  # lecture du déclencheur (accord) : rien de sortant
        return fake_data if read is None else read

    monkeypatch.setattr(mcp_server, "call_bridge", fake)
    result = json.loads(mcp_server.browser_drag_and_drop(from_mark=1, to_mark=2, tab_id=1))
    assert result["status"] == "success"
    assert result["data"]["success"] is True
