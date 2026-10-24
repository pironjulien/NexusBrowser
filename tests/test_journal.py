"""Journal commun des outils Nexus (FORMAT.md), produit « browser » : une ligne par appel d'outil, IA appelante,
domaine enregistrable seul, jamais de contenu de page (adresse complète, texte, valeur saisie, titre), jamais bloquant."""

import asyncio
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "client"))

from client import journal, mcp_server  # noqa: E402

SECRETS = ("motdepasse-777", "Bonjour Alice", "token=abc123", "/compte/42/facture", "Ma banque - Relevé")


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("NEXUS_JOURNAL_HOME", str(tmp_path))
    mcp_server._TAB_DOMAINS.clear()
    monkeypatch.setattr(mcp_server, "_agent_name", lambda: "Codex")
    return tmp_path


def _lines(home: Path, agent: str = "codex") -> list[dict]:
    journal.flush()  # écriture par un fil de fond : attendre la file
    files = list((home / "browser" / agent).glob("*.jsonl"))
    return [json.loads(line) for f in files for line in f.read_text(encoding="utf-8").splitlines()]


def _call(name: str, arguments: dict):
    return asyncio.run(mcp_server.browser_mcp.call_tool(name, arguments))


def test_one_line_per_call_with_registrable_domain_only(home, monkeypatch):
    answers = {
        "create-tab": {"id": 7, "pendingUrl": "https://compte.ma-banque.co.uk/compte/42/facture?token=abc123"},
        "navigate": {"url": "https://mail.google.com/mail/u/0/#inbox?token=abc123", "title": "Ma banque - Relevé"},
        "fill": {"verified": True, "value": "motdepasse-777", "method": "cdp"},
        "content": {"content": "Bonjour Alice, voici votre relevé", "title": "Ma banque - Relevé"},
    }
    monkeypatch.setattr(mcp_server, "call_bridge", lambda action, params, timeout=20.0: answers.get(action, {}))
    _call("browser_new_tab", {"url": "https://compte.ma-banque.co.uk/compte/42/facture?token=abc123"})
    _call("browser_navigate", {"url": "https://mail.google.com/mail/u/0/#inbox?token=abc123", "tab_id": 7})
    _call("browser_fill", {"selector": "#pw", "value": "motdepasse-777", "tab_id": 7})
    _call("browser_content", {"mode": "text", "tab_id": 7})
    lines = _lines(home)
    assert [line["action"] for line in lines] == ["new_tab", "navigate", "fill", "content"]
    assert [line["app"] for line in lines] == ["ma-banque.co.uk", "google.com", "google.com", "google.com"]
    assert lines[2]["technique"] == "cdp" and lines[2]["issue"] == "✓"
    journal.flush()
    raw = "".join(f.read_text(encoding="utf-8") for f in (home / "browser").rglob("*.jsonl"))
    for secret in SECRETS:  # aucun contenu de page, adresse, valeur saisie ni titre
        assert secret not in raw, secret
    for line in lines:
        assert set(line) == {
            "v",
            "agent",
            "ts",
            "outil",
            "appel",
            "app",
            "cadre",
            "action",
            "technique",
            "issue",
            "ms",
            "premier_plan",
            "erreur",
        }
        assert line["v"] == 1 and line["agent"] == "codex" and line["outil"] == mcp_server.VERSION
        assert line["cadre"] is None and line["premier_plan"] is False and isinstance(line["ms"], int)


def test_issues_and_clean_errors(home, monkeypatch):
    replies = iter(
        [
            RuntimeError('Element not found for "Bonjour Alice": #pw'),
            {"verified": False},
            {"trusted_click": None},
            {"trusted_click": True},
        ]
    )

    def bridge(action, params, timeout=20.0):
        reply = next(replies)
        if isinstance(reply, Exception):
            raise reply
        return reply

    monkeypatch.setattr(mcp_server, "call_bridge", bridge)
    _call("browser_fill", {"selector": "#pw", "value": "x", "tab_id": 3})
    _call("browser_fill", {"selector": "#pw", "value": "x", "tab_id": 3})
    _call("browser_hover", {"selector": "#a", "tab_id": 3})  # non relu
    _call("browser_hover", {"selector": "#a", "tab_id": 3})  # relu
    lines = _lines(home)
    assert [line["issue"] for line in lines] == ["✗", "~", "~", "✓"]
    assert lines[0]["erreur"] == "not found"  # catégorie seulement : rien de la page
    assert "Bonjour Alice" not in json.dumps(lines)


def test_refusal_stop_and_agents(home, monkeypatch):
    assert journal.issue({"status": "error", "error": "x", "accord_required": True}, False) == "refus"
    assert journal.issue({"status": "error", "error": "Emergency stop: everything refused"}, False) == "arrêt"
    assert journal.issue({"status": "error", "error": "dialog", "dialogOpened": True}, False) == "~"
    assert journal.issue({"status": "success", "data": {"changed": False}}, False) == "="
    assert journal.issue(None, True) == "✗"
    monkeypatch.setattr(mcp_server, "call_bridge", lambda action, params, timeout=20.0: {})
    monkeypatch.setattr(mcp_server, "_agent_name", lambda: "Nexus")  # session sans IA nommée : rien écrit
    _call("browser_logs", {"tab_id": 1})
    journal.flush()
    assert not (home / "browser").exists() or not list((home / "browser").rglob("*.jsonl"))
    monkeypatch.setattr(mcp_server, "_agent_name", lambda: "Antigravity")
    _call("browser_select_tab", {"tab_id": 1})
    line = _lines(home, "antigravity")[-1]
    assert line["agent"] == "antigravity" and line["premier_plan"] is True


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://www.google.com/search?q=secret", "google.com"),
        ("https://user.github.io/projet", "github.io"),
        ("https://www.bbc.co.uk/news", "bbc.co.uk"),
        ("https://www.service-public.gouv.fr/x", "service-public.gouv.fr"),
        ("http://203.0.113.7/login", "ip"),  # plage réservée à la documentation (RFC 5737)
        ("http://[::1]:8000/", "ip"),
        ("http://localhost:3000/admin", "localhost"),
        ("http://app.localhost/", "localhost"),
        ("http://freebox/", "local"),
        ("data:text/html,<b>Bonjour Alice</b>", "data"),
        ("about:blank", "about"),
        ("https://user:pass@mail.example.com:8443/inbox", "example.com"),
        ("https://example.com%2Fprivate%3Ftoken%3DSECRET.test/", "invalid"),  # chemin encodé dans l'hôte
        ("https://alice。example.com/", "example.com"),  # point idéographique
        ("https://alice%2eexample.com/", "example.com"),  # point encodé
        ("https://alice.co.fr/private", "co.fr"),  # co.fr n'est pas un suffixe public : jamais alice
        ("https://bücher.example.de/", "example.de"),
        ("https://www.münchen.de/", "xn--mnchen-3ya.de"),
        ("https://example.com\\@SYNTHETIC-SECRET.co.uk/", "example.com"),  # antislash = barre (WHATWG)
        ("HTTPS://example.com\\@SYNTHETIC-SECRET.co.uk/", "example.com"),
        ("  https://exa\tmple.com/\n", "example.com"),  # blancs de bord, tabulation retirée
        ("javascript:alert(1)", "javascript"),
        ("", None),
        (None, None),
    ],
)
def test_registrable_domain_never_more_precise(url, expected):
    assert journal.domaine(url) == expected


def test_journal_never_blocks_an_action(home, monkeypatch):
    monkeypatch.setattr(mcp_server, "call_bridge", lambda action, params, timeout=20.0: {"ok": 1})
    monkeypatch.setattr(journal, "_racine", lambda: (_ for _ in ()).throw(OSError("disk full")))
    result = _call("browser_logs", {"tab_id": 1})
    assert '"status": "success"' in mcp_server.json.dumps(mcp_server._answer_of(result))


def test_error_is_a_fixed_category_never_page_text():
    assert journal.erreur_propre("<button#SYNTHETIC_ACCOUNT_42> is not a <select>: x") == "error"
    assert journal.erreur_propre("Element not found for selector #compte-42") == "not found"
    assert journal.erreur_propre("Tab 1782635252 is not driven by any agent") == "tab not owned"
    assert journal.erreur_propre("Timeout after 5000 ms waiting for SYNTHETICPRIVATE") == "timeout"
    assert journal.erreur_propre("Emergency stop: everything refused") == "emergency stop"
    assert journal.erreur_propre("SYNTHETICPRIVATE: safe message") == "error"  # Error.name venu de la page
    assert journal.erreur_propre(None) is None
    for texte in ("SYNTHETICPRIVATE: safe message", "Value user_42@mail.example for field", "Bonjour Alice"):
        assert journal.erreur_propre(texte) in {kind for _, kind in journal._ERROR_KINDS} | {"error"}


def test_page_error_name_never_reaches_the_journal(home, monkeypatch):
    def bridge(action, params, timeout=20.0):
        raise RuntimeError("SYNTHETICPRIVATE: safe message")

    monkeypatch.setattr(mcp_server, "call_bridge", bridge)
    _call("browser_eval", {"script": "throw 1", "tab_id": 4})
    lines = _lines(home)
    assert lines[-1]["issue"] == "✗" and "SYNTHETICPRIVATE" not in json.dumps(lines)


def test_canonical_url_from_the_browser_wins_over_the_raw_argument(home, monkeypatch):
    raw = "https://example.com\\@SYNTHETIC-SECRET.co.uk/"
    monkeypatch.setattr(
        mcp_server,
        "call_bridge",
        lambda action, params, timeout=20.0: {"id": 9, "pendingUrl": "https://example.com/@SYNTHETIC-SECRET.co.uk/"},
    )
    _call("browser_new_tab", {"url": raw})
    lines = _lines(home)
    assert lines[-1]["app"] == "example.com" and "SYNTHETIC" not in json.dumps(lines).upper()


def test_technique_never_copies_page_values(home, monkeypatch):
    monkeypatch.setattr(
        mcp_server, "call_bridge", lambda action, params, timeout=20.0: {"method": "SYNTHETIC_ACCOUNT_42"}
    )
    _call("browser_eval", {"script": "({method: document.title})", "tab_id": 4})
    _call("browser_hover", {"selector": "#a", "tab_id": 4})
    lines = _lines(home)
    assert [line["technique"] for line in lines] == [None, None]
    assert "SYNTHETIC_ACCOUNT_42" not in json.dumps(lines)


def test_dialog_in_data_is_unknown_outcome(home, monkeypatch):
    monkeypatch.setattr(mcp_server, "call_bridge", lambda action, params, timeout=20.0: {"dialogOpened": True})
    _call("browser_eval", {"script": "alert(1)", "tab_id": 4})
    assert _lines(home)[-1]["issue"] == "~"


def test_batch_steps_each_get_a_line_linked_by_the_call(home, monkeypatch):
    replies = {"hover": {"trusted_click": None}, "select-tab": {}}
    monkeypatch.setattr(mcp_server, "call_bridge", lambda action, params, timeout=20.0: replies.get(action, {}))
    _call(
        "browser_batch",
        {
            "tab_id": 4,
            "steps": [
                {"tool": "browser_hover", "args": {"selector": "#a"}},
                {"tool": "browser_select_tab", "args": {}},
            ],
        },
    )
    lines = _lines(home)
    assert [line["action"] for line in lines] == ["hover", "select_tab"]
    assert [line["issue"] for line in lines] == ["~", "✓"]
    assert lines[1]["premier_plan"] is True and lines[0]["appel"] == lines[1]["appel"]


def test_batch_with_a_screenshot_step_reads_its_answer(home, monkeypatch, tmp_path):
    # Régression 2.21 : une étape capture (CallToolResult) faisait échouer le lot.
    monkeypatch.setattr(mcp_server, "_screenshot_dir", lambda: tmp_path)
    monkeypatch.setattr(
        mcp_server, "call_bridge", lambda action, params, timeout=20.0: {"dataUrl": "data:image/png;base64,cG5n"}
    )
    result = mcp_server._answer_of(
        _call("browser_batch", {"tab_id": 4, "steps": [{"tool": "browser_screenshot", "args": {}}]})
    )
    assert result is not None
    assert result["status"] == "success" and result["steps"][0]["status"] == "success"


def test_batch_attaches_the_images_of_its_steps(home, monkeypatch):
    import base64
    import io

    from mcp.types import ImageContent
    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", (800, 600), (240, 240, 240)).save(out, format="PNG")
    png = "data:image/png;base64," + base64.b64encode(out.getvalue()).decode()
    mcp_server._SENT_PRINTS.clear()
    mcp_server._VIEW_SCALES.clear()
    monkeypatch.setattr(
        mcp_server, "call_bridge", lambda action, params, timeout=20.0: {"dataUrl": png, "devicePixelRatio": 1}
    )
    result = _call("browser_batch", {"tab_id": 4, "steps": [{"tool": "browser_screenshot", "args": {"inline": True}}]})
    blocks = getattr(result, "content", None) or []
    assert sum(isinstance(block, ImageContent) for block in blocks) == 1  # l'IA a bien vu l'image
    answer = mcp_server._answer_of(result)
    assert answer is not None and answer["status"] == "success"
    mcp_server._SENT_PRINTS.clear()
    mcp_server._VIEW_SCALES.clear()


@pytest.mark.parametrize(
    "steps",
    [[], [{"tool": "browser_nope", "args": {}}], [{"tool": "browser_batch", "args": {"steps": []}}]],
)
def test_refused_batch_gets_one_line(home, monkeypatch, steps):
    monkeypatch.setattr(mcp_server, "call_bridge", lambda action, params, timeout=20.0: {})
    _call("browser_batch", {"tab_id": 4, "steps": steps})
    lines = _lines(home)
    assert [(line["action"], line["issue"], line["erreur"]) for line in lines] == [("batch", "✗", "invalid request")]


@pytest.mark.parametrize("refused", [{"tool": "browser_nope", "args": {}}, {"tool": "browser_batch", "args": {}}])
def test_step_refused_after_a_success_gets_its_line(home, monkeypatch, refused):
    monkeypatch.setattr(mcp_server, "call_bridge", lambda action, params, timeout=20.0: {"trusted_click": True})
    _call("browser_batch", {"tab_id": 4, "steps": [{"tool": "browser_hover", "args": {"selector": "#a"}}, refused]})
    lines = _lines(home)
    assert [(line["action"], line["issue"], line["erreur"]) for line in lines] == [
        ("hover", "✓", None),
        ("batch", "✗", "invalid request"),
    ]
    assert lines[0]["appel"] == lines[1]["appel"] and "nope" not in json.dumps(lines)


def test_batch_answer_always_keeps_the_structured_result(home, monkeypatch):
    # Un client qui garde l'ancien schéma de sortie ({"result": texte}) rejette une réponse sans structured_content.
    monkeypatch.setattr(mcp_server, "call_bridge", lambda action, params, timeout=20.0: {"trusted_click": True})
    for steps in ([{"tool": "browser_hover", "args": {"selector": "#a"}}], [], [{"tool": "browser_nope"}]):
        result = mcp_server.browser_batch(steps=steps, tab_id=4)
        assert isinstance(result.structured_content, dict) and isinstance(result.structured_content["result"], str)
        assert json.loads(result.structured_content["result"])["status"] in ("success", "error")


def test_lines_queued_are_written_at_normal_exit(tmp_path):
    import subprocess
    import textwrap

    script = textwrap.dedent(
        f"""
        import sys, time
        sys.path.insert(0, {str(REPO_ROOT / "client")!r})
        import journal
        started = []
        def slow(nom, ligne):
            started.append(1)
            time.sleep(0.4)
            open({str(tmp_path / "finished")!r}, "w").write("ok")
        journal._write = slow
        journal.ecrire("codex", {{"action": "x"}})
        while not started:
            time.sleep(0.01)
        """
    )
    done = subprocess.run([sys.executable, "-I", "-B", "-c", script], timeout=30, check=False)
    assert done.returncode == 0 and (tmp_path / "finished").exists()


def test_slow_disk_never_delays_the_tool(home, monkeypatch):
    import time as clock

    monkeypatch.setattr(mcp_server, "call_bridge", lambda action, params, timeout=20.0: {})
    monkeypatch.setattr(journal, "_write", lambda nom, ligne: clock.sleep(0.5))
    started = clock.monotonic()
    _call("browser_logs", {"tab_id": 1})
    assert clock.monotonic() - started < 0.3
    journal.flush()
