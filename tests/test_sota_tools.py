"""Outils ajoutés le 2026-10-20 (comparaison aux serveurs MCP de navigateur les plus utilisés) : plusieurs actions en un
appel (browser_batch), attente d'un texte ou d'un élément (browser_wait_for), précédent / suivant, page entière."""

import json
import sys
from pathlib import Path

import pytest
from conftest import neutral_trigger_read

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "client"))

from client import mcp_server  # noqa: E402


@pytest.fixture
def bridge(monkeypatch):
    """Faux pont : enregistre les commandes ; find répond selon la file `counts` (dernier nombre gardé)."""
    state = {"calls": [], "counts": [1], "trigger": None}

    def fake(action, params, timeout=20.0):
        if action == "find" and (params or {}).get("limit") == 100 and state["trigger"]:
            return {"count": 1, "candidates": [state["trigger"]]}
        if (read := neutral_trigger_read(action, params)) is not None:
            return read
        state["calls"].append((action, params))
        if action == "find":
            counts = state["counts"]
            return {"count": counts.pop(0) if len(counts) > 1 else counts[0]}
        return {"ok": True}

    monkeypatch.setattr(mcp_server, "call_bridge", fake)
    monkeypatch.setattr(mcp_server, "WAIT_FOR_POLL_S", 0.01)
    return state


def test_navigate_back_and_forward(bridge):
    mcp_server.browser_navigate("back", tab_id=3)
    mcp_server.browser_navigate("forward", tab_id=3)
    mcp_server.browser_navigate("https://example.org/", tab_id=3)
    assert bridge["calls"] == [
        ("navigate", {"history": "back", "tab_id": 3}),
        ("navigate", {"history": "forward", "tab_id": 3}),
        ("navigate", {"url": "https://example.org/", "tab_id": 3}),
    ]


def test_full_page_screenshot_flag_and_element_wins(bridge):
    mcp_server.browser_screenshot(tab_id=3, full_page=True, output_path="C:/x/page.png")
    mcp_server.browser_screenshot(tab_id=3, full_page=True, mark=4, inline=True)
    refused = json.loads(mcp_server.browser_screenshot(tab_id=3, full_page=True, inline=True))
    assert bridge["calls"][0] == ("screenshot", {"output": "C:/x/page.png", "tab_id": 3, "fullPage": True})
    assert bridge["calls"][1] == ("screenshot", {"output": None, "tab_id": 3, "selector": "#4"})
    assert refused["status"] == "error" and "inline" in refused["error"] and len(bridge["calls"]) == 2


def test_wait_for_text_appears(bridge):
    bridge["counts"] = [0, 0, 2]
    result = json.loads(mcp_server.browser_wait_for(text="Envoyé", timeout_ms=2000, tab_id=3))
    assert result["status"] == "success" and result["data"]["count"] == 2
    finds = [params for action, params in bridge["calls"] if action == "find"]
    assert len(finds) == 3 and finds[0]["locator"] == {"text": "Envoyé"} and finds[0]["tab_id"] == 3


def test_wait_for_gone_and_timeout(bridge):
    bridge["counts"] = [1, 0]
    gone = json.loads(mcp_server.browser_wait_for(locator={"text": "Chargement"}, gone=True, tab_id=3))
    assert gone["status"] == "success" and gone["data"]["count"] == 0
    bridge["counts"] = [0]
    late = json.loads(mcp_server.browser_wait_for(text="Jamais", timeout_ms=100, tab_id=3))
    assert late["status"] == "error" and "Timeout after 100 ms" in late["error"]


def test_wait_for_needs_a_target_and_a_tab(bridge):
    assert "Missing text or locator" in json.loads(mcp_server.browser_wait_for(tab_id=3))["error"]
    assert "browser_new_tab" in json.loads(mcp_server.browser_wait_for(text="x", tab_id=None))["error"]  # type: ignore[arg-type]
    assert (
        "timeout_ms=200000 refused"
        in json.loads(mcp_server.browser_wait_for(text="x", timeout_ms=200000, tab_id=3))["error"]
    )


def test_batch_runs_steps_in_order_with_default_tab(bridge):
    result = json.loads(
        mcp_server.browser_batch(
            steps=[
                {"tool": "browser_fill", "args": {"locator": {"label": "Email"}, "value": "a@b.c"}},
                {"tool": "browser_click", "args": {"mark": "2"}},  # validé par le schéma de l'outil : "2" -> 2
                {"tool": "browser_navigate", "args": {"url": "back", "tab_id": 9}},
                {"tool": "browser_list_tabs"},
            ],
            tab_id=3,
        )
    )
    assert result["status"] == "success" and [s["tool"] for s in result["steps"]] == [
        "browser_fill",
        "browser_click",
        "browser_navigate",
        "browser_list_tabs",
    ]
    actions = [(action, params.get("tab_id") if params else None) for action, params in bridge["calls"]]
    assert actions == [("fill", 3), ("click", 3), ("navigate", 9), ("list-tabs", None)]
    assert bridge["calls"][1][1]["mark"] == 2


def test_batch_stops_at_first_error(bridge):
    result = json.loads(
        mcp_server.browser_batch(
            steps=[
                {"tool": "browser_wait_for", "args": {}},
                {"tool": "browser_click", "args": {"mark": 1}},
            ],
            tab_id=3,
        )
    )
    assert result["status"] == "error" and result["stopped_at"] == 0 and len(result["steps"]) == 1
    assert not [call for call in bridge["calls"] if call[0] == "click"]


def test_batch_keeps_the_outward_accord(bridge):
    bridge["trigger"] = {"name": "Envoyer", "role": "button", "tag": "button"}
    result = json.loads(
        mcp_server.browser_batch(
            steps=[
                {"tool": "browser_fill", "args": {"locator": {"label": "Objet"}, "value": "Bonjour"}},
                {"tool": "browser_click", "args": {"locator": {"role": "button", "name": "Envoyer"}, "confirm": True}},
                {"tool": "browser_click", "args": {"mark": 7}},
            ],
            tab_id=3,
        )
    )
    assert result["status"] == "error" and result["stopped_at"] == 1
    assert result["steps"][1]["result"].get("accord_required") is True
    assert [call[0] for call in bridge["calls"]] == ["fill"]


@pytest.mark.parametrize(
    "steps,message",
    [
        ([], "non-empty"),
        ([{"tool": "browser_nope"}], "unknown tool"),
        ([{"tool": "browser_batch", "args": {"steps": []}}], "cannot nest"),
        ([{"tool": "browser_list_tabs"}] * 31, "At most 30"),
        ([{"tool": "browser_click", "args": {"mark": "deux"}}], "Step 0 (browser_click)"),
    ],
)
def test_batch_refusals(bridge, steps, message):
    result = json.loads(mcp_server.browser_batch(steps=steps, tab_id=3))
    assert result["status"] == "error" and message in json.dumps(result)
    assert bridge["calls"] == []


def test_wait_for_never_takes_an_unreadable_page_for_gone(bridge, monkeypatch):
    def dialog(action, params, timeout=20.0):
        return {"dialog": {"type": "alert", "message": "Bloqué"}}

    monkeypatch.setattr(mcp_server, "call_bridge", dialog)
    result = json.loads(mcp_server.browser_wait_for(text="Chargement", gone=True, tab_id=3))
    assert result["status"] == "error" and "not readable" in result["error"] and "Bloqué" in result["error"]


def test_batch_without_tab_and_unexpected_failure(bridge, monkeypatch):
    listed = json.loads(mcp_server.browser_batch(steps=[{"tool": "browser_list_tabs"}]))
    assert listed["status"] == "success"
    missing = json.loads(mcp_server.browser_batch(steps=[{"tool": "browser_reload"}]))
    assert missing["status"] == "error" and missing["stopped_at"] == 0

    def boom(action, params, timeout=20.0):
        raise LookupError("panne imprévue")

    monkeypatch.setattr(mcp_server, "call_bridge", boom)
    crashed = json.loads(mcp_server.browser_batch(steps=[{"tool": "browser_list_tabs"}, {"tool": "browser_list_tabs"}]))
    assert (
        crashed["status"] == "error"
        and crashed["stopped_at"] == 0
        and "panne imprévue" in json.dumps(crashed, ensure_ascii=False)
    )
