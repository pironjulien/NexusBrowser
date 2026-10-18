"""Revue de Claude du 17/10 (partie C) côté pont et serveur MCP : identité de chaque client transmise à l'extension
dans le canal signé (jamais lue dans les paramètres), tab_id obligatoire, téléversement contrôlé par le pont lui-même
(chemins normalisés), plus aucune valeur de cookie. Vrai pont sur ports éphémères, extension simulée."""

import asyncio
import inspect
import json
import os
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
import bridge_security  # noqa: E402
from bridge_security import AGENT_HEADER, CLIENT_HEADER, TOKEN_HEADER, token_path  # noqa: E402
from test_bridge_auth import ORIGIN, Extension  # noqa: E402

from client import bridge_client as package_client  # noqa: E402
from client import mcp_server  # noqa: E402

HTTP_PORT = 0
STATUS_URL = ""
COMMAND_URL = ""
WS_URL = ""


def command(action: str, params: dict, identity: dict | None, timeout: float = 5.0) -> tuple[int, dict]:
    headers = {"Content-Type": "application/json", TOKEN_HEADER: token_path().read_text(encoding="ascii").strip()}
    if identity:
        headers.update({AGENT_HEADER: identity["agent"], CLIENT_HEADER: identity["id"]})
    request = urllib.request.Request(
        COMMAND_URL,
        data=json.dumps({"action": action, "params": params, "timeout": timeout}).encode("utf-8"),
        headers=headers,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout + 10) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        with error:
            return error.code, json.loads(error.read().decode("utf-8"))


AGENT_A = {"agent": "Claude", "id": "claude-aaaa1111"}
AGENT_B = {"agent": "Codex", "id": "codex-bbbb2222"}


def test_each_client_identity_reaches_the_extension_in_the_signed_channel():
    """L'extension tient la propriété des onglets avec CETTE identité : deux agents (ou deux sessions) ne se
    confondent jamais, et un paramètre « client » glissé dans la commande ne remplace pas celle du pont."""
    seen: list[dict] = []

    async def scenario():
        async with connect(WS_URL, origin=ORIGIN) as websocket:
            extension = Extension(websocket)
            await extension.authenticate()
            for identity in (AGENT_A, AGENT_B):
                spoofed = {"tab_id": 7, "client": AGENT_B, "__client": AGENT_B}
                result: dict = {}

                def run(identity=identity, spoofed=spoofed, result=result):
                    result["reply"] = command("click", spoofed, identity)

                thread = threading.Thread(target=run, daemon=True)
                thread.start()
                received = await asyncio.wait_for(extension.receive(), 5)
                seen.append(received)
                await extension.send({"requestId": received["requestId"], "success": True, "data": {"ok": 1}})
                await asyncio.to_thread(thread.join, 10)
                assert result["reply"][0] == 200

    asyncio.run(asyncio.wait_for(scenario(), 30))
    assert [message["client"] for message in seen] == [AGENT_A, AGENT_B]
    assert all(set(message) == {"requestId", "action", "params", "client"} for message in seen)


def test_mcp_processes_have_distinct_identities_and_send_them(monkeypatch):
    sent: list[dict] = []

    def urlopen(request, timeout=None):
        sent.append({k.lower(): v for k, v in request.header_items()})
        raise urllib.error.URLError(ConnectionRefusedError())

    monkeypatch.setattr(package_client.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(bridge_client, "ensure_bridge_running", lambda: False)
    first = package_client.identity()
    assert first["agent"] == mcp_server.AGENT_NAME and first["id"] == mcp_server.CLIENT_IDENTITY["id"]
    with pytest.raises(ConnectionError):
        package_client.call_bridge("click", {"tab_id": 3}, 1.0, retry=False)
    assert sent[0][AGENT_HEADER.lower()] == first["agent"] and sent[0][CLIENT_HEADER.lower()] == first["id"]
    other = package_client.set_identity(mcp_server.AGENT_NAME)  # une autre conversation du même agent
    try:
        assert other["id"] != first["id"]
    finally:
        package_client.set_identity(first["agent"], first["id"])
    with pytest.raises(ValueError):
        package_client.set_identity("Claude", "x")


def test_page_tools_require_tab_id_no_last_tab_fallback(monkeypatch):
    """Revue C2 : plus de repli « dernier onglet » côté MCP ; tab_id obligatoire dans le schéma de chaque outil."""
    sent = []
    monkeypatch.setattr(
        mcp_server, "call_bridge", lambda action, params, timeout=20.0: sent.append(action) or {"id": 5}
    )
    assert not hasattr(mcp_server, "AGENT_TAB") and not hasattr(mcp_server, "AgentTab")
    tools = {tool.name: tool for tool in asyncio.run(mcp_server.browser_mcp.list_tools())}
    tab_free = {
        "browser_list_tabs",
        "browser_active_tab",
        "browser_new_tab",
        "browser_download_status",
        "browser_group_tabs",
    }
    for name, tool in tools.items():
        if name in tab_free:
            continue
        assert "tab_id" in tool.input_schema.get("required", []), name
    assert "tab_ids" in tools["browser_group_tabs"].input_schema["required"]
    with pytest.raises(TypeError):
        mcp_server.browser_click(selector="#a")  # type: ignore[call-arg]
    mcp_server.browser_new_tab("https://a.invalid")
    assert json.loads(mcp_server.browser_click(selector="#a", tab_id=None))["error"].startswith("tab_id manquant")  # type: ignore[arg-type]
    assert sent == ["create-tab"]
    assert {"browser_adopt_tab", "browser_release_tab", "browser_network_record", "browser_network_stop"} <= set(tools)
    assert not {"browser_sidepanel_requests", "browser_sidepanel_reply"} & set(tools)
    assert "julien_asked" in inspect.signature(mcp_server.browser_adopt_tab).parameters
    assert inspect.signature(mcp_server.browser_adopt_tab).parameters["julien_asked"].default is False


def test_cookie_values_never_requested_by_default(monkeypatch):
    """Valeurs de cookies : jamais par défaut ; include_values (2.7.1) seulement pour une origine locale, refus tenu par
    l'extension (tests/browser.test.cjs, « 2.3 cookies »)."""
    sent = []
    monkeypatch.setattr(mcp_server, "call_bridge", lambda action, params, timeout=20.0: sent.append(params) or {})
    assert inspect.signature(mcp_server.browser_get_cookies).parameters["include_values"].default is False
    mcp_server.browser_get_cookies(tab_id=4)
    assert sent == [{"tab_id": 4}]


# -----------------------------------------------------------------------------
# Téléversement (revue C6) : contrôle dans le PONT, chemins normalisés
# -----------------------------------------------------------------------------
@pytest.fixture
def fake_home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    onedrive = tmp_path / "OneDrive - Perso"
    for directory in (
        ".nexus/nexus-browser",
        ".gemini/antigravity",
        ".android",
        ".ssh",
        ".config/gcloud",
        "AppData/Roaming/gcloud",
        "AppData/Local/Google/Chrome/User Data/Default",
        "Docs",
    ):
        (home / directory).mkdir(parents=True)
    for file in (
        ".android/adbkey",
        ".git-credentials",
        ".ssh/id_ed25519",
        "Docs/ok.pdf",
        "AppData/Local/Google/Chrome/User Data/Default/Login Data",
        ".gemini/antigravity/oauth.json",
    ):
        (home / file).write_text("x", encoding="utf-8")
    (onedrive / "Documents" / "NexusSecure").mkdir(parents=True)
    (onedrive / "Documents" / "NexusSecure" / "cles.json").write_text("{}", encoding="utf-8")
    for name, value in (("USERPROFILE", home), ("HOME", home), ("OneDrive", onedrive)):
        monkeypatch.setenv(name, str(value))
    monkeypatch.setenv("APPDATA", str(home / "AppData" / "Roaming"))
    monkeypatch.setenv("LOCALAPPDATA", str(home / "AppData" / "Local"))
    return home, onedrive


def _secret_paths(home: Path, onedrive: Path) -> list[str]:
    import _winapi

    drive, rest = os.path.splitdrive(str(home))
    letter = drive.rstrip(":")
    junction = home / "Docs" / "raccourci"
    _winapi.CreateJunction(str(home / ".ssh"), str(junction))  # jonction (sans droits d'administrateur)
    return [
        str(home / ".gemini" / "antigravity" / "oauth.json"),
        str(home / ".android" / "adbkey"),
        str(home / ".git-credentials"),
        str(home / ".config" / "gcloud"),
        str(home / "AppData" / "Roaming" / "gcloud"),
        str(home / "AppData" / "Local" / "Google" / "Chrome" / "User Data" / "Default" / "Login Data"),
        str(onedrive / "Documents" / "NexusSecure" / "cles.json"),
        "\\\\?\\" + str(home / ".ssh" / "id_ed25519"),
        "\\\\.\\" + str(home / ".ssh" / "id_ed25519"),
        f"\\\\localhost\\{letter}$" + rest + "\\.ssh\\id_ed25519",
        f"\\\\127.0.0.1\\{letter.lower()}$" + rest + "\\.SSH\\ID_ED25519",
        f"\\\\?\\UNC\\localhost\\{letter}$" + rest + "\\.ssh\\id_ed25519",
        str(junction / "id_ed25519"),  # lien résolu
        str(home / ".ssh.") + "\\id_ed25519",  # point final ignoré par Windows
        str(home / "Docs" / ".." / ".ssh" / "id_ed25519").replace("\\", "/"),
    ]


@pytest.mark.skipif(sys.platform != "win32", reason="chemins Windows")
def test_upload_refused_by_the_bridge_itself_for_every_spelling(fake_home):
    home, onedrive = fake_home
    for path in _secret_paths(home, onedrive):
        # Un client HTTP qui contourne bridge_client est arrêté au pont (aucune extension n'est même consultée).
        status, payload = command("upload", {"files": [path], "tab_id": 1}, AGENT_A)
        assert status == 403 and "Téléversement refusé" in payload["error"], path
        refusal = bridge_security.upload_refusal([str(home / "Docs" / "ok.pdf"), path])
        assert refusal and "Téléversement refusé" in refusal, path
    assert bridge_security.upload_refusal([str(home / "Docs" / "ok.pdf")]) is None
    status, payload = command("upload", {"files": [str(home / "Docs" / "ok.pdf")], "tab_id": 1}, AGENT_A)
    assert status == 400 and "No Chrome browser extension connected" in payload["error"]  # passé au contrôle
    assert bridge_security.upload_refusal([]) and bridge_security.upload_refusal("C:/x")  # liste invalide


def test_default_cli_identity_is_accepted_by_the_bridge():
    """L'identité par défaut de la CLI doit passer le contrôle du pont (« cli » faisait 3 caractères : refusée)."""
    import bridge_client
    import bridge_security

    default = bridge_client.identity()
    assert bridge_security.check_identity(default["agent"], default["id"]) is not None
