"""browser_fill_form (panneau Antigravity plus rapide, 18/10) : un formulaire en un appel, sans rien perdre des
garanties des outils d'un champ. Cas adversariaux des relectures de Codex (panneau-agy-vitesse-codex-revue*.md) :
boîte de dialogue, valeur refusée, option remise par la page, champ changé ou remplacé, cible réévaluée."""

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "client"))

from client import mcp_server  # noqa: E402


class Page:
    """Faux pont : un formulaire en mémoire indexé par mark, des gestes qui le modifient, field-state qui le relit."""

    def __init__(self):
        self.fields: dict[int, object] = {}
        self.calls: list[tuple[str, dict]] = []
        self.after: dict[int, tuple[int, object]] = {}  # effet de bord d'un geste : {mark: (autre mark, valeur)}
        self.refuse: set[int] = set()  # la page remet le champ à vide
        self.dialog_on: int | None = None
        self.replaces: dict[int, int] = {}  # geste sur ce mark : la page recrée cet autre champ (nœud détaché)
        self.detached: set[int] = set()

    def __call__(self, action, params, timeout=20.0):
        self.calls.append((action, params))
        mark = params["mark"]
        if action == "field-state":
            if mark in self.detached:
                raise RuntimeError("Field removed or replaced by the page since the gesture")
            ((kind, value),) = params["expect"].items()
            current = self.fields.get(mark)
            return {"verified": current == value, "value" if kind != "checked" else "checked": current}
        if mark == self.dialog_on:
            return {"dialogOpened": True, "dialog": {"type": "confirm", "message": "Sûr ?"}, "method": "cdp"}
        value = params.get("value", params.get("text", params.get("checked")))
        self.fields[mark] = "" if mark in self.refuse else value
        if mark in self.after:
            other, forced = self.after[mark]
            self.fields[other] = forced
        if mark in self.replaces:
            self.detached.add(self.replaces[mark])
        if action == "select-option":  # comme l'extension : selectedText de l'option trouvée, pas de verified
            return {"selectedValue": self.fields[mark], "selectedText": value}
        return {"verified": self.fields[mark] == value, "value": self.fields[mark]}


@pytest.fixture
def page(monkeypatch):
    fake = Page()
    monkeypatch.setattr(mcp_server, "call_bridge", fake)
    monkeypatch.setattr(mcp_server.emergency_stop, "check", lambda: None)
    return fake


def run(fields, tab_id=4):
    return json.loads(mcp_server.browser_fill_form(fields, tab_id=tab_id))


def test_fills_by_mark_with_the_single_field_gestures_then_reads_the_same_elements_back(page):
    result = run(
        [
            {"mark": 1, "value": "Marie"},
            {"mark": 3, "value": "marie@example.com"},
            {"mark": 4, "option": "Lille"},
            {"mark": 6, "checked": False},
        ]
    )
    assert result["status"] == "success" and result["data"]["all_verified"] is True
    gestures = [action for action, _ in page.calls if action != "field-state"]
    assert gestures == ["fill", "fill", "select-option", "check"]
    assert page.calls[0] == (
        "fill",
        {"mark": 1, "value": "Marie", "timeoutMs": 1200, "replace": True, "perKey": False, "mode": "auto", "tab_id": 4},
    )
    reads = [params["mark"] for action, params in page.calls if action == "field-state"]
    assert reads == [1, 3, 4, 6, 1, 3, 4, 6]  # chaque champ tout de suite, puis tout : toujours le mark du geste
    assert all(params["tab_id"] == 4 for _, params in page.calls)


def test_everything_is_validated_before_the_first_gesture(page):
    for fields in (
        [],
        [{"mark": 1, "value": "x"}, {"mark": 2}],
        [{"label": "Ville", "value": "Lyon"}],  # un libellé serait réévalué à chaque relecture
        [{"selector": "#ville", "value": "Lyon"}],
        [{"locator": {"label": "Ville"}, "value": "Lyon"}],
        [{"mark": 1, "label": "Ville", "value": "x"}],
        [{"mark": 1, "value": "x", "checked": True}],
        [{"mark": 1, "checked": "oui"}],
        [{"mark": 0, "value": "x"}],
        [{"mark": True, "value": "x"}],
        [{"mark": "3", "value": "x"}],
        [{"mark": 4, "option": ""}],
        [{"mark": 1, "value": ["x"]}],
        ["A"],
    ):
        assert run(list(fields))["status"] == "error", fields
    assert run([{"mark": 1, "value": "x"}], tab_id=0)["status"] == "error"
    assert page.calls == []


def test_a_dialog_stops_the_batch_and_is_reported(page):
    page.dialog_on = 2
    result = run([{"mark": 1, "value": "Marie"}, {"mark": 2, "value": "Lyon"}, {"mark": 3, "value": "1"}])
    assert result["status"] == "error" and "dialog" in result["error"]
    last = result["data"]["fields"][-1]
    assert last["ok"] is False and last["dialogOpened"] is True and last["dialog"]["message"] == "Sûr ?"
    assert 3 not in page.fields and result["data"]["all_verified"] is False


def test_a_refused_value_stops_before_the_next_field(page):
    page.refuse.add(2)
    result = run([{"mark": 2, "value": "Lyon"}, {"mark": 3, "value": "69001"}])
    assert result["status"] == "error" and "not confirmed" in result["error"]
    assert 3 not in page.fields


def test_an_option_put_back_by_the_page_is_not_verified(page):
    page.refuse.add(4)
    result = run([{"mark": 4, "option": "Pro"}, {"mark": 2, "value": "Banc"}])
    assert result["status"] == "error" and result["data"]["fields"][0]["verified"] is False
    assert 2 not in page.fields


def test_a_field_changed_by_a_later_field_fails_the_final_read(page):
    page.after[3] = (2, "Paris")
    result = run([{"mark": 2, "value": "Lyon"}, {"mark": 3, "value": "69001"}])
    assert result["status"] == "error" and "Final read-back" in result["error"] and '"#2"' in result["error"]
    ville = result["data"]["fields"][0]
    assert ville["verified"] is True and ville["final_verified"] is False and ville["final"]["value"] == "Paris"
    assert result["data"]["all_verified"] is False


def test_a_field_replaced_by_the_page_fails_the_final_read(page):
    page.replaces[3] = 2  # remplir le code postal fait recréer le champ Ville par la page
    result = run([{"mark": 2, "value": "Lyon"}, {"mark": 3, "value": "69001"}])
    assert result["status"] == "error" and '"#2"' in result["error"]
    assert result["data"]["fields"][0]["final"]["error"].startswith("Field removed")


def test_the_emergency_stop_is_checked_before_each_field(page, monkeypatch):
    checks = iter([None, RuntimeError("Emergency stop requested by the user")])

    def stop():
        outcome = next(checks)
        if outcome:
            raise outcome

    monkeypatch.setattr(mcp_server.emergency_stop, "check", stop)
    result = run([{"mark": 1, "value": "1"}, {"mark": 2, "value": "2"}])
    assert result["status"] == "error" and "Emergency stop" in result["error"]
    assert 1 in page.fields and 2 not in page.fields


def test_a_gesture_that_was_not_confirmed_is_never_cleared_by_the_read_back(page, monkeypatch):
    def bridge(action, params, timeout=20.0):
        page.calls.append((action, params))
        if action == "fill":  # le champ réel refuse (remis à Paris) ; la relecture viserait un libellé devenu vide
            return {"verified": False, "value": "Paris"}
        return {"verified": True, "value": ""}

    monkeypatch.setattr(mcp_server, "call_bridge", bridge)
    result = run([{"mark": 1, "value": ""}, {"mark": 3, "value": "69001"}])
    assert result["status"] == "error" and "not confirmed" in result["error"]
    assert [params["mark"] for action, params in page.calls if action == "fill"] == [1]  # #3 jamais touché


def test_after_a_stop_the_fields_before_are_read_again_never_reported_from_their_old_check(page):
    page.after[3] = (2, "Paris")  # le code postal remet Ville à Paris...
    page.refuse.add(3)  # ... et refuse sa propre valeur : arrêt
    result = run([{"mark": 2, "value": "Lyon"}, {"mark": 3, "value": "69001"}, {"mark": 6, "value": "Bonjour"}])
    assert result["status"] == "error" and '"#2"' in result["error"] and "were filled" not in result["error"]
    ville = result["data"]["fields"][0]
    assert ville["verified"] is True and ville["final_verified"] is False and ville["final"]["value"] == "Paris"
    assert 6 not in page.fields  # aucun geste après l'arrêt, aucun geste rejoué
    assert [params["mark"] for action, params in page.calls if action == "fill"] == [2, 3]


def test_after_a_dialog_the_fields_before_are_unknown_not_read(page):
    page.dialog_on = 3
    result = run([{"mark": 2, "value": "Lyon"}, {"mark": 3, "value": "69001"}])
    assert result["status"] == "error" and "unknown state" in result["error"]
    assert result["data"]["fields"][0]["final_verified"] is None
    assert page.calls[-1] == ("fill", page.calls[-1][1]) and page.calls[-1][1]["mark"] == 3  # rien lu après la boîte
