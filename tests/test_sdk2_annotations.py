"""2.8 : SDK MCP 2.x (MCPServer), annotations de chaque outil, et textes honnêtes sur browser_eval (accès complet à la
page) et sur les valeurs masquées (mots de passe, codes, cartes)."""

import asyncio
import importlib.metadata
import inspect
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "client"))
sys.path.insert(0, str(REPO_ROOT / "native-host"))

import bridge_security  # noqa: E402
from mcp.server.mcpserver import MCPServer  # noqa: E402

from client import mcp_server  # noqa: E402

PERSONAL_SKILL = REPO_ROOT / "perso" / "nexus-browser" / "SKILL.md"  # dépôt privé seulement


def _tools() -> dict:
    return {tool.name: tool for tool in asyncio.run(mcp_server.browser_mcp.list_tools())}


def test_server_runs_on_mcp_sdk_2():
    major = int(importlib.metadata.version("mcp").split(".")[0])
    assert major == 2
    assert isinstance(mcp_server.browser_mcp, MCPServer)
    assert mcp_server.VERSION == (REPO_ROOT / "VERSION").read_text(encoding="utf-8").strip()
    assert "fastmcp" not in (REPO_ROOT / "client" / "mcp_server.py").read_text(encoding="utf-8").lower()


def test_every_tool_has_its_four_annotations():
    tools = _tools()
    assert len(tools) == 49
    for name, tool in tools.items():
        hints = tool.annotations
        assert hints is not None, name
        for field in ("read_only_hint", "destructive_hint", "idempotent_hint", "open_world_hint"):
            assert isinstance(getattr(hints, field), bool), f"{name}.{field}"
        assert not (hints.read_only_hint and hints.destructive_hint), name
        assert hints.title, name
    assert len({tool.annotations.title for tool in tools.values()}) == len(tools)
    # Annotations publiées au client sous leurs noms MCP (camelCase).
    published = tools["browser_click"].model_dump(by_alias=True)["annotations"]
    assert published == {
        "title": "Click",
        "readOnlyHint": False,
        "destructiveHint": True,
        "idempotentHint": False,
        "openWorldHint": True,
    }


def test_annotations_match_what_each_tool_does():
    tools = _tools()
    read_only = {name for name, tool in tools.items() if tool.annotations.read_only_hint}
    destructive = {name for name, tool in tools.items() if tool.annotations.destructive_hint}
    assert {
        "browser_content",
        "browser_axtree",
        "browser_screenshot",
        "browser_find",
        "browser_interactive_map",
        "browser_network_response",
        "browser_export",
        "browser_list_tabs",
        "browser_get_cookies",
    } <= read_only
    # Vraies sessions de Julien : un clic, une touche, une case, un script peuvent envoyer, supprimer ou valider.
    assert {
        "browser_click",
        "browser_fill",
        "browser_fill_form",
        "browser_press_key",
        "browser_check",
        "browser_handle_dialog",
        "browser_eval",
        "browser_cdp_send",
        "browser_drag_and_drop",
        "browser_upload",
        "browser_close_tab",
    } <= destructive
    assert not {"browser_hover", "browser_scroll", "browser_navigate", "browser_new_tab"} & (read_only | destructive)
    local = {name for name, tool in tools.items() if not tool.annotations.open_world_hint}
    assert {"browser_list_tabs", "browser_active_tab", "browser_group_tabs", "browser_release_tab"} <= local
    assert "browser_navigate" not in local and "browser_eval" not in local


def test_read_only_hint_never_claims_an_action_the_bridge_blocks(monkeypatch):
    """Chaque outil dit « lecture seule » envoie au pont une commande de sa liste des lectures (permises pendant
    l'arrêt d'urgence) ; exceptions assumées, qui ne modifient rien mais restent bloquées par l'arrêt : get-cookies, et
    la liste des outils WebMCP (getTools lu par cdp-send, que le pont compte parmi les actions)."""
    sent: list[str] = []
    monkeypatch.setattr(mcp_server, "call_bridge", lambda action, params, timeout=20.0: sent.append(action) or {})
    monkeypatch.setattr(mcp_server, "_default_capture_path", lambda prefix: None)
    samples = {
        "tab_id": 1,
        "locator": {"role": "button"},
        "output_path": None,
        "request_id": "1",
        "url": "https://example.invalid/",
        "gone": True,  # browser_wait_for : répond dès la première lecture (aucun élément)
    }
    for name, tool in _tools().items():
        if not tool.annotations.read_only_hint:
            continue
        function = getattr(mcp_server, name)
        required = [
            p.name
            for p in inspect.signature(function).parameters.values()
            if p.default is inspect.Parameter.empty and p.name not in samples
        ]
        assert not required, f"{name} : paramètre obligatoire sans exemple {required}"
        accepted = inspect.signature(function).parameters
        sent.clear()
        function(**{key: value for key, value in samples.items() if key in accepted})
        assert len(sent) == 1, name
        if (name, sent[0]) not in {("browser_get_cookies", "get-cookies"), ("browser_webmcp_tools", "cdp-send")}:
            assert bridge_security.is_read_only_action(sent[0]), f"{name} -> {sent[0]}"


def test_eval_is_documented_as_full_page_access():
    """Audit du 18/10 : la promesse « cookies étanches hors localhost » était fausse pour browser_eval et
    Runtime.evaluate. Dit tel quel partout où un agent le lit (outil, instructions, skill, README)."""
    eval_doc = mcp_server.browser_eval.__doc__ or ""
    assert "FULL PAGE ACCESS" in eval_doc and "document.cookie" in eval_doc and "localStorage" in eval_doc
    cdp_doc = mcp_server.browser_cdp_send.__doc__ or ""
    assert "FULL ACCESS" in cdp_doc and "scriptToEvaluateOnLoad is refused" in cdp_doc
    instructions = mcp_server.browser_mcp.instructions or ""
    assert "full access to the page" in instructions and "Password" in instructions
    if PERSONAL_SKILL.exists():
        text = PERSONAL_SKILL.read_text(encoding="utf-8")
        assert "accès complet à la page" in text and "[masked value]" in text
    public = (REPO_ROOT / "skills" / "nexus-browser" / "SKILL.md").read_text(encoding="utf-8")
    assert "full page access with no masking" in public
    readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
    assert "full access to the page" in readme and "[masked value]" in readme
    install = (REPO_ROOT / "install.ps1").read_text(encoding="utf-8")
    # Copiée dans le plugin d'Antigravity : la personnelle si elle existe, sinon la publique.
    assert r"perso\nexus-browser\SKILL.md" in install and r"skills\nexus-browser\SKILL.md" in install


def test_masked_values_are_announced_to_the_agent(monkeypatch):
    for tool in (mcp_server.browser_content, mcp_server.browser_fill):
        assert "[masked value]" in (tool.__doc__ or ""), tool.__name__
    # Le serveur transmet la réponse de l'extension telle quelle : le marqueur arrive à l'agent, jamais retiré.
    monkeypatch.setattr(
        mcp_server,
        "call_bridge",
        lambda action, params, timeout=20.0: {"verified": True, "value": "[masked value]"},
    )
    reply = json.loads(mcp_server.browser_fill(selector="#pw", value="secret", tab_id=2))
    assert reply == {"status": "success", "data": {"verified": True, "value": "[masked value]"}}


def test_every_tool_name_fits_antigravity_once_prefixed():
    # Antigravity publie chaque outil sous mcp_<plugin>_<serveur>_<outil> et rejette tout nom hors ^[a-zA-Z0-9_-]{1,64}$
    # (l'outil disparaît alors en silence : browser_export_youtube_transcript faisait 65 caractères).
    prefix = "mcp_nexus-browser_nexus-browser_"
    too_long = [name for name in _tools() if not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", prefix + name)]
    assert too_long == []
