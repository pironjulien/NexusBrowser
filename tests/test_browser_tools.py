"""Outils MCP navigateur du 2026-10-15 : localisateurs par rôle et libellé, frappe de confiance, réseau,
téléchargements, et garde-fous de la validation réelle (test.ps1 -Full)."""

import importlib.util
import json
import re
import sys
from pathlib import Path

import pytest
from conftest import neutral_trigger_read

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "client"))

import bridge_client  # noqa: E402
import browser_cli  # noqa: E402

from client import emergency_stop as package_stop  # noqa: E402
from client import mcp_server  # noqa: E402

LOCATOR = {"role": "button", "name": "Valider", "exact": True}


@pytest.fixture
def sent(monkeypatch):
    calls = []

    def fake(action, params, timeout=20.0):
        if (read := neutral_trigger_read(action, params)) is not None:  # lecture du déclencheur : rien de sortant
            return read
        calls.append((action, params, timeout))
        return {"ok": True}

    monkeypatch.setattr(mcp_server, "call_bridge", fake)
    return calls


def test_locator_reaches_every_targeting_tool(sent):
    mcp_server.browser_click(locator=LOCATOR, tab_id=1)
    mcp_server.browser_hover(locator=LOCATOR, tab_id=1)
    mcp_server.browser_semantic_click(locator=LOCATOR, tab_id=1)
    mcp_server.browser_fill(locator={"label": "Email"}, value="a@b.c", tab_id=1)
    mcp_server.browser_semantic_fill(locator={"placeholder": "Rechercher"}, value="x", tab_id=1)
    mcp_server.browser_select_option(locator={"label": "Formule"}, value="pro", tab_id=1)
    mcp_server.browser_check(locator={"role": "checkbox", "name": "J'accepte"}, tab_id=1)
    mcp_server.browser_type_keys("abc", locator={"label": "Code"}, tab_id=1)
    mcp_server.browser_drag_and_drop(from_locator={"text": "A"}, to_locator={"testId": "zone"}, tab_id=1)
    actions = [action for action, _, _ in sent]
    assert actions == [
        "click",
        "hover",
        "semantic-click",
        "fill",
        "semantic-fill",
        "select-option",
        "check",
        "type-keys",
        "drag-and-drop",
    ]
    assert sent[0][1]["locator"] == LOCATOR
    assert sent[3][1]["locator"] == {"label": "Email"}
    assert sent[6][1] == {
        "checked": True,
        "tab_id": 1,
        "timeoutMs": 1200,
        "locator": {"role": "checkbox", "name": "J'accepte"},
    }
    assert sent[8][1]["from_locator"] == {"text": "A"} and sent[8][1]["to_locator"] == {"testId": "zone"}
    # Sans localisateur : aucun champ vide transmis (ciblage historique inchangé).
    mcp_server.browser_click(selector="#a", tab_id=1)
    assert "locator" not in sent[-1][1]


def test_trusted_typing_options_are_forwarded(sent):
    mcp_server.browser_fill(
        selector="#q", value="bonjour", replace=False, keys=["Enter"], per_key=True, mode="trusted", tab_id=2
    )
    action, params, _ = sent[0]
    assert action == "fill"
    assert params["replace"] is False
    assert params["keys"] == ["Enter"]
    assert params["perKey"] is True
    assert params["mode"] == "trusted"
    mcp_server.browser_semantic_fill(label="Email", value="x", exact=True, keys=["Tab"], tab_id=2)
    assert sent[1][1] == {"label": "Email", "value": "x", "tab_id": 2, "mode": "auto", "exact": True, "keys": ["Tab"]}


def test_find_network_and_download_tools(sent):
    mcp_server.browser_find({"role": "link", "name": "Accueil"}, limit=5, tab_id=3)
    mcp_server.browser_network_requests(tab_id=3, filter="/api", status="4xx", include_headers=True)
    mcp_server.browser_network_response("9468.4", tab_id=3, max_bytes=1024)
    mcp_server.browser_wait_download(tab_id=3, timeout_ms=12000)
    assert sent[0][:2] == ("find", {"locator": {"role": "link", "name": "Accueil"}, "limit": 5, "tab_id": 3})
    assert sent[1][0] == "network-requests"
    assert sent[1][1]["filter"] == "/api" and sent[1][1]["status"] == "4xx" and sent[1][1]["includeHeaders"] is True
    assert sent[2][:2] == (
        "network-response",
        {"request_id": "9468.4", "tab_id": 3, "maxBytes": 1024, "includeBinary": False},
    )
    action, params, timeout = sent[3]
    assert action == "wait-download" and params == {"tab_id": 3, "timeoutMs": 12000}
    assert timeout > 12  # le pont attend plus longtemps que le téléchargement


def test_reads_stay_allowed_and_actions_blocked_during_emergency_stop(sent):
    package_stop.pressed()
    for blocked in (
        mcp_server.browser_fill(locator={"label": "Email"}, value="x", tab_id=1),
        mcp_server.browser_check(locator={"role": "checkbox"}, tab_id=1),
        mcp_server.browser_press_key("Control+A", tab_id=1),
        mcp_server.browser_select_option(locator={"label": "Formule"}, value="pro", tab_id=1),
    ):
        assert json.loads(blocked)["status"] == "error"
    for allowed in (
        mcp_server.browser_find({"role": "button"}, tab_id=1),
        mcp_server.browser_network_requests(tab_id=1),
        mcp_server.browser_network_response("1", tab_id=1),
        mcp_server.browser_wait_download(tab_id=1, timeout_ms=100),
    ):
        assert json.loads(allowed)["status"] == "success"
    assert [action for action, _, _ in sent] == ["find", "network-requests", "network-response", "wait-download"]


def test_new_reads_are_read_only_for_safe_retries():
    for action in ("find", "network-requests", "network_response", "wait-download"):
        assert bridge_client.is_read_only_action(action)
    for action in ("fill", "type", "check", "uncheck", "press-key", "download-erase"):
        assert not bridge_client.is_read_only_action(action)


def test_cli_locator_parsing():
    assert browser_cli.parse_locator('{"role": "button", "name": "OK"}') == {"role": "button", "name": "OK"}
    assert browser_cli.parse_locator(None) is None
    with pytest.raises(ValueError):
        browser_cli.parse_locator('["role"]')


# -----------------------------------------------------------------------------
# Validation réelle : jamais de faux vert sans Chrome ni extension à jour
# -----------------------------------------------------------------------------
@pytest.fixture
def live_module():
    spec = importlib.util.spec_from_file_location(
        "live_browser_validation", REPO_ROOT / "tests" / "live_browser_validation.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_full_live_preflight_fails_clearly_without_bridge(live_module, monkeypatch):
    def unreachable(*args, **kwargs):
        raise ConnectionError("Impossible de joindre le pont NexusBrowser")

    monkeypatch.setattr(live_module.bridge_client, "call_bridge", unreachable)
    with pytest.raises(SystemExit) as failure:
        live_module.preflight()
    assert "ÉCHEC" in str(failure.value) and "injoignable" in str(failure.value)


def test_full_live_preflight_requires_reloaded_extension(live_module, monkeypatch):
    expected = json.loads((REPO_ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))["version"]
    calls = []

    def old_extension(action, params, timeout, retry=True):
        calls.append((action, retry))
        return {"status": "pong", "version": "0.0.1"}

    monkeypatch.setattr(live_module.bridge_client, "call_bridge", old_extension)
    with pytest.raises(SystemExit) as failure:
        live_module.preflight()
    assert "Recharger l'extension" in str(failure.value)
    assert calls == [("ping", False)]  # sans relance automatique de Chrome
    source = (REPO_ROOT / "extension" / "background.js").read_text(encoding="utf-8")
    declared = re.search(r"const AGY_FEATURES = \[(.*?)\];", source, re.S)
    assert declared
    features = re.findall(r'"([^"]+)"', declared.group(1))
    assert features  # le code de l'extension annonce bien ses fonctions
    # Nouveau numéro de version mais ancien service worker (mesuré le 15/10) : refusé, jamais de faux vert.
    monkeypatch.setattr(live_module.bridge_client, "call_bridge", lambda *a, **k: {"version": expected})
    with pytest.raises(SystemExit) as stale:
        live_module.preflight()
    assert "ancien service worker" in str(stale.value)
    monkeypatch.setattr(
        live_module.bridge_client, "call_bridge", lambda *a, **k: {"version": expected, "features": features}
    )
    live_module.preflight()


def test_full_live_fixture_serves_cross_origin_frames_and_download(live_module):
    import urllib.request

    fixture = live_module.FullFixture()
    try:
        page = urllib.request.urlopen(fixture.url, timeout=5).read().decode("utf-8")
        assert f"http://localhost:{fixture.frame_port}/frame?name=A" in page
        assert f"http://127.0.0.1:{fixture.frame_port}/frame?name=B" in page
        frame = urllib.request.urlopen(f"http://127.0.0.1:{fixture.frame_port}/frame?name=B", timeout=5).read()
        assert b"Action B" in frame
        with urllib.request.urlopen(
            f"http://127.0.0.1:{fixture.main_port}/download/{fixture.token}.txt", timeout=5
        ) as r:
            assert "attachment" in r.headers["Content-Disposition"]
            assert r.read().decode("utf-8") == fixture.download_content
        with urllib.request.urlopen(f"http://127.0.0.1:{fixture.main_port}/api/data", timeout=5) as r:
            assert "secret-cookie-value" in r.headers["Set-Cookie"]
    finally:
        fixture.close()


def test_test_ps1_full_runs_both_live_modes():
    script = (REPO_ROOT / "test.ps1").read_text(encoding="utf-8")
    assert "param([switch]$Full)" in script
    assert '"--mouse", "--full-live"' in script
    live = (REPO_ROOT / "tests" / "live_browser_validation.py").read_text(encoding="utf-8")
    assert '"--full-live"' in live and "preflight()" in live


def test_new_tab_groups_under_the_agent_name(monkeypatch):
    """Chaque agent (Antigravity, Claude, Codex) range ses onglets dans le groupe à son nom (NEXUS_BROWSER_AGENT)."""
    sent = []
    monkeypatch.setattr(
        mcp_server, "call_bridge", lambda action, params, timeout=20.0: sent.append((action, params)) or {"tabId": 7}
    )
    import inspect

    # Omis : le nom de l'agent de la session en cours (celui du processus en stdio, de la session MCP en démon).
    assert inspect.signature(mcp_server.browser_new_tab).parameters["group"].default is None
    assert inspect.signature(mcp_server.browser_group_tabs).parameters["title"].default is None
    mcp_server.browser_new_tab(url="https://example.com")
    assert sent[-1][1]["group"] == mcp_server.AGENT_NAME
    mcp_server.browser_new_tab(url="https://example.com", group="")
    assert "group" not in sent[-1][1]
    mcp_server.browser_new_tab(url="https://example.com", group="Claude")
    assert sent[-1] == (
        "create-tab",
        {"url": "https://example.com", "background": True, "active": False, "group": "Claude"},
    )
