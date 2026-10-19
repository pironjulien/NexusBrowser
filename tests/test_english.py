"""Textes reçus par l'agent en anglais : descriptions des outils et de leurs paramètres (tools/list), instructions du
serveur, et réponses d'erreur ou de refus produites sans navigateur (pont injoignable, tab_id absent ou invalide,
arguments invalides, arrêt d'urgence, téléversement refusé). Les commentaires du code restent en français."""

import asyncio
import io
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "native-host"))

import bridge_security  # noqa: E402

from client import bridge_client, mcp_server  # noqa: E402

# Marqueurs du français absents de tout texte anglais : lettres accentuées, guillemets français, mots outils.
ACCENTS = "àâçéèêëîïôöûùüÀÂÇÉÈÊËÎÏÔÖÛÙÜ«»"
FRENCH_WORDS = (
    "le", "la", "les", "des", "une", "est", "sont", "pas", "avec", "sans", "pour", "dans", "aucun", "aucune",
    "onglet", "onglets", "jamais", "seulement", "puis", "lorsque", "quand", "selon", "jeton", "pont",
)  # fmt: skip
WORD = re.compile(r"\b(" + "|".join(FRENCH_WORDS) + r")\b", re.IGNORECASE)


def french_markers(text: str) -> list[str]:
    found = [char for char in ACCENTS if char in text]
    return found + sorted({match.group(0) for match in WORD.finditer(text)})


def _descriptions(schema: Any) -> list[str]:
    """Toutes les descriptions (et titres) d'un schéma JSON, à toute profondeur."""
    if isinstance(schema, dict):
        found = [value for key, value in schema.items() if key in ("description", "title") and isinstance(value, str)]
        return found + [text for value in schema.values() for text in _descriptions(value)]
    if isinstance(schema, list):
        return [text for value in schema for text in _descriptions(value)]
    return []


def test_markers_catch_french():
    """Le test sait reconnaître le français (il échouait sur les anciennes descriptions)."""
    assert french_markers("Ouvre un nouvel onglet dans Chrome")
    assert french_markers("tab_id manquant : ouvrir d'abord un onglet avec browser_new_tab")
    assert french_markers("Rend l'onglet à l'utilisateur sans le fermer")
    assert french_markers("« requête »")
    assert not french_markers("Opens a new Chrome tab at the given URL (or about:blank) and returns its id.")


def test_tool_and_parameter_descriptions_are_english():
    tools = asyncio.run(mcp_server.browser_mcp.list_tools())
    assert tools
    problems = {}
    texts = [("instructions", mcp_server.browser_mcp.instructions or "")]
    for tool in tools:
        texts.append((tool.name, tool.description or ""))
        texts.append((f"{tool.name}.title", (tool.annotations.title if tool.annotations else "") or ""))
        texts += [(f"{tool.name}.inputSchema", text) for text in _descriptions(tool.input_schema)]
    for where, text in texts:
        if markers := french_markers(text):
            problems.setdefault(where, []).append((markers, text[:120]))
    assert problems == {}


def _error(reply: str) -> str:
    payload = json.loads(reply)
    assert payload["status"] == "error", payload
    return payload["error"]


def assert_english(text: str) -> None:
    assert text and not french_markers(text), (french_markers(text), text)


def test_argument_errors_are_english():
    assert_english(_error(mcp_server.browser_click(selector="#a", tab_id=None)))  # type: ignore[arg-type]
    assert_english(_error(mcp_server.browser_click(selector="#a", tab_id=0)))
    assert_english(_error(mcp_server.browser_wait_load(tab_id=1, timeout_ms=999_999)))
    assert_english(_error(mcp_server.browser_wait_load(tab_id=1, timeout_ms=-1)))
    assert_english(_error(mcp_server.browser_group_tabs(tab_ids=[])))
    invalid: tuple[list[Any], ...] = (
        [],
        ["x"],
        [{"label": "Ville", "value": "Lyon"}],
        [{"mark": 1}],
        [{"mark": 1, "checked": "oui"}],
        [{"mark": 1, "value": ["a"]}],
        [{"mark": 1, "option": " "}],
    )
    for fields in invalid:
        assert_english(_error(mcp_server.browser_fill_form(fields, tab_id=1)))
    assert_english(_error(mcp_server.browser_fill_form([{"mark": 1, "value": "x"}], tab_id=0)))


def test_refusals_are_english(monkeypatch, tmp_path):
    # Arrêt d'urgence : toute action refusée avant d'atteindre le pont.
    monkeypatch.setattr(mcp_server.emergency_stop, "remaining_s", lambda: 60.0)
    assert_english(_error(mcp_server.browser_click(selector="#a", tab_id=1)))
    assert_english(_error(mcp_server.browser_fill_form([{"mark": 1, "value": "x"}], tab_id=1)))
    monkeypatch.setattr(mcp_server.emergency_stop, "remaining_s", lambda: 0.0)
    # Téléversement d'un fichier d'un dossier de secrets, ou liste invalide : refusé par le client avant tout envoi.
    secret = Path.home() / ".ssh" / "id_ed25519"
    assert_english(_error(mcp_server.browser_upload(files=[str(secret)], tab_id=1)))
    assert_english(_error(mcp_server.browser_upload(files=[], tab_id=1)))
    assert_english(bridge_security.upload_refusal([str(secret)]) or "")


def test_bridge_failures_are_english(monkeypatch):
    monkeypatch.setattr(bridge_client, "ensure_bridge_running", lambda: False)
    monkeypatch.setattr(bridge_client, "ensure_chrome_running", lambda timeout=6.0: False)
    monkeypatch.setattr(bridge_client, "is_chrome_running", lambda: False)

    def refused(*args: Any, **kwargs: Any) -> Any:
        raise urllib.error.URLError(ConnectionRefusedError())

    monkeypatch.setattr(urllib.request, "urlopen", refused)
    assert_english(_error(mcp_server.browser_list_tabs()))  # pont injoignable
    assert_english(_error(mcp_server.browser_click(selector="#a", tab_id=1)))

    def timed_out(*args: Any, **kwargs: Any) -> Any:
        raise TimeoutError

    monkeypatch.setattr(urllib.request, "urlopen", timed_out)
    assert_english(_error(mcp_server.browser_click(selector="#a", tab_id=1)))  # action peut-être exécutée

    def no_extension(request: Any, *args: Any, **kwargs: Any) -> Any:
        body = io.BytesIO(json.dumps({"error": "No Chrome browser extension connected"}).encode())
        raise urllib.error.HTTPError(request.full_url, 503, "Service Unavailable", {}, body)  # type: ignore[arg-type]

    monkeypatch.setattr(urllib.request, "urlopen", no_extension)
    assert_english(_error(mcp_server.browser_list_tabs()))

    def missing_token() -> dict:
        raise FileNotFoundError

    monkeypatch.setattr(bridge_client, "authentication_headers", missing_token)
    assert_english(_error(mcp_server.browser_list_tabs()))  # jeton absent, pont non démarré


def test_form_and_export_reports_are_english(monkeypatch):
    def dialog(action: str, params: dict, timeout: float = 20.0) -> dict:
        return {"dialogOpened": True, "dialog": {"type": "confirm", "message": "Sure?"}}

    monkeypatch.setattr(mcp_server, "call_bridge", dialog)
    assert_english(_error(mcp_server.browser_fill_form([{"mark": 1, "value": "x"}], tab_id=1)))

    def refused_value(action: str, params: dict, timeout: float = 20.0) -> dict:
        return {"verified": False, "value": ""}

    monkeypatch.setattr(mcp_server, "call_bridge", refused_value)
    reply = mcp_server.browser_fill_form([{"mark": 1, "value": "x"}, {"mark": 2, "value": "y"}], tab_id=1)
    assert_english(_error(reply))

    monkeypatch.setattr(mcp_server, "call_bridge", lambda action, params, timeout=20.0: {"binary": True})
    assert_english(_error(mcp_server.browser_export_gsuite(tab_id=1, format="pdf")))


def test_emergency_stop_message_is_english():
    assert_english(mcp_server.emergency_stop.message(12.0))
