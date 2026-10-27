"""Revue croisée du pont Chrome (2.5.0) : un onglet par agent, secrets (cookies, téléversements), délais de transport,
jeton lu sans sous-processus. Le Chrome de Julien est partagé par l'agent, Claude et Codex : chacun lance SON
processus MCP (client/mcp_server.py) ; tab_id explicite à chaque commande, propriété tenue par l'extension."""

import json
import sys
import urllib.error
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from conftest import neutral_trigger_read

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "client"))
sys.path.insert(0, str(REPO_ROOT / "native-host"))

import bridge_client  # noqa: E402
import bridge_security  # noqa: E402

from client import emergency_stop as package_stop  # noqa: E402
from client import mcp_server  # noqa: E402


@pytest.fixture
def bridge(monkeypatch):
    """Pont simulé : chaque create-tab ouvre un nouvel onglet (11, 12...) ; toutes les commandes sont enregistrées."""
    sent: list[tuple[str, dict, float]] = []
    next_tab = iter(range(11, 100))

    def fake(action, params, timeout=20.0):
        if (read := neutral_trigger_read(action, params)) is not None:  # lecture du déclencheur : rien de sortant
            return read
        sent.append((action, dict(params or {}), timeout))
        if action == "create-tab":
            return {"id": next(next_tab), "url": (params or {}).get("url")}
        return {"ok": True}

    monkeypatch.setattr(mcp_server, "call_bridge", fake)
    return sent


# -----------------------------------------------------------------------------
# 1. Un onglet par agent : tab_id explicite à chaque commande, propriété tenue par l'extension (tests Node)
# -----------------------------------------------------------------------------
def test_each_command_carries_the_tab_id_given_by_the_agent(bridge):
    created = json.loads(mcp_server.browser_new_tab("https://a.invalid"))["data"]["id"]
    mcp_server.browser_click(selector="#payer", tab_id=created)
    mcp_server.browser_fill(selector="#q", value="b", tab_id=created)
    mcp_server.browser_eval("1", tab_id=created)
    mcp_server.browser_handle_dialog(accept=False, tab_id=created)
    mcp_server.browser_upload(files=["C:/Dev/rapport.pdf"], tab_id=created)
    assert [(action, params.get("tab_id")) for action, params, _ in bridge] == [
        ("create-tab", None),
        ("click", 11),
        ("fill", 11),
        ("eval", 11),
        ("handle-dialog", 11),
        ("upload", 11),
    ]


def test_tab_free_tools_stay_available(bridge):
    assert json.loads(mcp_server.browser_list_tabs())["status"] == "success"
    assert json.loads(mcp_server.browser_active_tab())["status"] == "success"
    assert json.loads(mcp_server.browser_group_tabs([]))["status"] == "error"  # aucun onglet : rien envoyé
    assert [action for action, _, _ in bridge] == ["list-tabs", "active-tab"]


def test_tool_texts_no_longer_promise_a_current_tab():
    for tool in (mcp_server.browser_close_tab, mcp_server.browser_reload, mcp_server.browser_navigate):
        assert "onglet courant" not in (tool.__doc__ or "")
    instructions = mcp_server.browser_mcp.instructions or ""
    assert "browser_new_tab" in instructions and "browser_adopt_tab" in instructions
    public = (REPO_ROOT / "skills" / "nexus-browser" / "SKILL.md").read_text(encoding="utf-8")
    assert "lastAgentTabId" not in public and "One tab per agent session" in public and "browser_adopt_tab" in public
    assert "Julien" not in public  # compétence publique (extension Gemini CLI, plugin Antigravity) : personne de nommé
    personal = REPO_ROOT / "perso" / "nexus-browser" / "SKILL.md"  # dépôt privé seulement
    if personal.exists():
        text = personal.read_text(encoding="utf-8")
        assert "lastAgentTabId" not in text and "Un onglet par agent" in text and "browser_adopt_tab" in text
        assert "sidepanel" not in text
        # include_values (2.7.1) : seulement décrit avec sa limite aux origines locales de développement.
        assert "include_values=True` seulement pour une origine locale de développement" in text


def test_stop_allowed_actions_mirror_the_read_only_list():
    """Lectures permises pendant l'arrêt : même liste dans l'extension (noms reçus) et dans le pont."""
    import re

    import bridge_server

    source = (REPO_ROOT / "extension" / "background.js").read_text(encoding="utf-8")
    declared = re.search(r"const STOP_ALLOWED_ACTIONS = new Set\(\[(.*?)\]\);", source, re.S)
    assert declared
    extension = set(re.findall(r'"([^"]+)"', declared.group(1))) - {"emergency_stop"}
    from_bridge = {bridge_server.normalize_action(action) for action in bridge_security.READ_ONLY_ACTIONS}
    assert from_bridge <= extension
    assert extension - from_bridge <= {"active_tab", "content", "logs", "pdf"}  # alias reçus tels quels


# -----------------------------------------------------------------------------
# 3. Secrets : cookies, téléversements
# -----------------------------------------------------------------------------
def test_cookies_without_values_and_never_a_read(bridge):
    mcp_server.browser_get_cookies(tab_id=1)
    assert bridge[0][1] == {"tab_id": 1}
    for action in ("get-cookies", "cookies", "get_cookies"):
        assert not bridge_client.is_read_only_action(action)
    package_stop.pressed()
    assert "Emergency stop" in json.loads(mcp_server.browser_get_cookies(tab_id=1))["error"]
    assert len(bridge) == 1


def test_cookies_are_never_resent_after_a_timeout(monkeypatch):
    calls = []

    def urlopen(request, timeout=None):
        calls.append(json.loads(request.data.decode("utf-8"))["action"])
        raise TimeoutError("timed out")

    monkeypatch.setattr(bridge_client.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(bridge_client, "ensure_bridge_running", lambda: True)
    with pytest.raises(ConnectionError, match="not resent"):
        bridge_client.call_bridge("get-cookies", {"tab_id": 1}, 1.0)
    assert calls == ["get-cookies"]


@pytest.fixture
def fake_home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    onedrive = tmp_path / "OneDrive - Perso"
    for directory in (".nexus/nexus-browser", ".nexusagy", ".ssh", ".codex", ".claude", "Docs"):
        (home / directory).mkdir(parents=True)
    (onedrive / "Documents" / "NexusSecure").mkdir(parents=True)
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("OneDrive", str(onedrive))
    monkeypatch.setenv("APPDATA", str(home / "AppData" / "Roaming"))
    monkeypatch.setenv("LOCALAPPDATA", str(home / "AppData" / "Local"))
    return home, onedrive


def test_upload_refuses_secret_folders_before_sending(fake_home, monkeypatch):
    home, onedrive = fake_home
    reached = []

    def urlopen(request, timeout=None):
        reached.append(json.loads(request.data.decode("utf-8"))["params"]["files"])
        raise urllib.error.URLError(ConnectionRefusedError())

    monkeypatch.setattr(bridge_client.urllib.request, "urlopen", urlopen)
    for module in (bridge_client, sys.modules["client.bridge_client"]):
        monkeypatch.setattr(module, "ensure_bridge_running", lambda: False)
    refused = [
        home / ".nexus" / "nexus-browser" / "bridge-token",
        home / ".nexusagy" / "bridge-token",
        Path(str(home / ".NEXUSAGY" / "BRIDGE-TOKEN")),  # casse différente, même fichier sous Windows
        home / ".ssh" / "id_ed25519",
        home / ".codex" / "auth.json",
        home / ".claude" / ".credentials.json",
        home / "Docs" / ".." / ".ssh" / "config",  # chemin résolu avant comparaison
        onedrive / "Documents" / "NexusSecure" / "cles.json",
        home / ".ssh",
    ]
    for path in refused:
        payload = json.loads(mcp_server.browser_upload(files=[str(home / "Docs" / "ok.pdf"), str(path)], tab_id=1))
        assert payload["status"] == "error", path
        assert "Upload refused" in payload["error"]
    assert reached == []
    # Contrôle indépendant du nom d'action : tout paramètre « files » est vérifié (plus d'alias à recopier).
    for action in ("upload", "upload_file", "set-files", "anything"):
        with pytest.raises(PermissionError):
            bridge_client.call_bridge(action, {"files": [str(home / ".ssh" / "id")], "tab_id": 1})
    assert bridge_security.is_upload_action("navigate", {"files": []})
    assert not bridge_security.is_upload_action("navigate", {"url": "https://example.invalid"})
    # Un fichier ordinaire part bien au pont (refus de connexion simulé ensuite).
    allowed = str(home / "Docs" / "ok.pdf")
    assert json.loads(mcp_server.browser_upload(files=[allowed], tab_id=1))["status"] == "error"
    assert reached == [[allowed]]


# -----------------------------------------------------------------------------
# -----------------------------------------------------------------------------
# 6. Délais de transport : attente demandée + 5 s, plafonnée à 115 s
# -----------------------------------------------------------------------------
def test_transport_timeout_follows_requested_wait(bridge):
    mcp_server.browser_wait_load(timeout_ms=60000, tab_id=1)
    mcp_server.browser_wait_network_idle(timeout_ms=112000, tab_id=1)
    mcp_server.browser_click(selector="a", timeout_ms=30000, tab_id=1)
    mcp_server.browser_hover(selector="a", timeout_ms=40000, tab_id=1)
    mcp_server.browser_fill(selector="a", value="x", timeout_ms=50000, tab_id=1)
    mcp_server.browser_check(selector="a", timeout_ms=70000, tab_id=1)
    mcp_server.browser_wait_download(timeout_ms=90000, tab_id=1)
    mcp_server.browser_wait_load(timeout_ms=1000, tab_id=1)  # jamais sous le délai ordinaire (20 s)
    assert [timeout for _, _, timeout in bridge] == [65.0, 115.0, 35.0, 45.0, 55.0, 75.0, 95.0, 20.0]
    waits: list[tuple[Callable[..., str], dict[str, Any]]] = [
        (mcp_server.browser_wait_load, {}),
        (mcp_server.browser_wait_network_idle, {}),
        (mcp_server.browser_wait_download, {}),
        (mcp_server.browser_click, {"selector": "a"}),
    ]
    for tool, kwargs in waits:
        payload = json.loads(tool(timeout_ms=200000, tab_id=1, **kwargs))
        assert payload["status"] == "error" and "at most 115000 ms" in payload["error"]
    assert len(bridge) == 8  # rien envoyé pour les attentes refusées


# -----------------------------------------------------------------------------
# 7 et 9. Jeton lu seulement côté client, aucun repli silencieux
# -----------------------------------------------------------------------------
def test_client_reads_token_without_any_subprocess(tmp_path, monkeypatch):
    token_file = tmp_path / "bridge-token"
    token = bridge_security.load_or_create_token(token_file)  # création : droits réglés une fois
    monkeypatch.setenv("NEXUS_BROWSER_TOKEN_FILE", str(token_file))

    def forbidden(*args, **kwargs):
        raise AssertionError("sous-processus lancé pour une commande")

    for name in ("run", "Popen", "check_output", "call"):
        monkeypatch.setattr(bridge_security.subprocess, name, forbidden)
    for _ in range(3):
        assert bridge_client.authentication_headers()[bridge_security.TOKEN_HEADER] == token
    assert bridge_security.load_or_create_token(token_file) == token  # jeton existant : relu, pas retouché


def test_missing_token_is_a_clear_error_not_an_empty_header(tmp_path, monkeypatch):
    monkeypatch.setenv("NEXUS_BROWSER_TOKEN_FILE", str(tmp_path / "absent"))
    monkeypatch.setattr(bridge_client, "ensure_bridge_running", lambda: False)
    monkeypatch.setattr(bridge_client.urllib.request, "urlopen", lambda *a, **k: pytest.fail("envoyé sans jeton"))
    with pytest.raises(ConnectionError, match="token missing"):
        bridge_client.call_bridge("click", {"tab_id": 1}, 1.0)
    source = (REPO_ROOT / "client" / "bridge_client.py").read_text(encoding="utf-8")
    assert "except ImportError" not in source and "X-Nexus-Token" not in source


def test_chrome_found_in_user_install_and_app_paths(tmp_path, monkeypatch):
    user_chrome = tmp_path / "Local" / "Google" / "Chrome" / "Application" / "chrome.exe"
    user_chrome.parent.mkdir(parents=True)
    user_chrome.write_bytes(b"")
    for variable in ("ProgramFiles", "ProgramFiles(x86)"):
        monkeypatch.setenv(variable, str(tmp_path / "absent"))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "Local"))
    monkeypatch.setattr(bridge_client, "_registered_chrome", lambda: [])
    monkeypatch.setattr(bridge_client, "FIXED_CHROME_PATHS", [])  # le test ne dépend pas du Chrome du poste
    assert bridge_client.get_chrome_executable() == user_chrome
    registered = tmp_path / "Ailleurs" / "chrome.exe"
    registered.parent.mkdir()
    registered.write_bytes(b"")
    monkeypatch.setattr(bridge_client, "_registered_chrome", lambda: [registered])
    assert bridge_client.get_chrome_executable() == registered


def test_versions_bumped_for_changed_tools():
    manifest = json.loads((REPO_ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["version"] == bridge_security.VERSION == "2.31.3"
