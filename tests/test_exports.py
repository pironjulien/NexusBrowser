"""Outils MCP d'export (2.4.0) : page en Markdown, Google Docs/Sheets/Slides, transcription YouTube.

Aucun Chrome : le pont est simulé ; les fichiers exportés vont dans un dossier temporaire (jamais ~/.nexusagy)."""

import base64
import importlib.util
import json
import sys
import urllib.request
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "client"))

import bridge_client  # noqa: E402

from client import emergency_stop as package_stop  # noqa: E402
from client import mcp_server  # noqa: E402


@pytest.fixture
def exports_dir(tmp_path, monkeypatch):
    directory = tmp_path / "exports"
    monkeypatch.setattr(mcp_server, "_exports_dir", lambda: directory)
    return directory


@pytest.fixture
def bridge(monkeypatch):
    """Pont simulé : réponse programmable, appels enregistrés."""
    state = {"calls": [], "reply": {"ok": True}}

    def fake(action, params, timeout=20.0):
        state["calls"].append((action, params, timeout))
        reply = state["reply"]
        if isinstance(reply, Exception):
            raise reply
        return json.loads(json.dumps(reply))

    monkeypatch.setattr(mcp_server, "call_bridge", fake)
    return state


def test_browser_export_forwards_format_zone_and_bound(bridge):
    mcp_server.browser_export(tab_id=4)
    mcp_server.browser_export(tab_id=4, format="html", selector="article", max_chars=500)
    mcp_server.browser_export(tab_id=4, format="text", locator={"role": "main"})
    assert bridge["calls"][0] == ("export-content", {"tab_id": 4, "format": "markdown", "maxChars": 100_000}, 30.0)
    assert bridge["calls"][1][1] == {"tab_id": 4, "format": "html", "maxChars": 500, "selector": "article"}
    assert bridge["calls"][2][1]["locator"] == {"role": "main"} and "selector" not in bridge["calls"][2][1]


def test_gsuite_binary_written_under_exports_dir_never_inline(bridge, exports_dir):
    content = b"%PDF-1.7\n" + bytes(range(256)) * 4
    bridge["reply"] = {
        "kind": "document",
        "document_id": "1AbC",
        "title": "Plan 2026",
        "format": "pdf",
        "extension": "pdf",
        "binary": True,
        "bytes": len(content),
        "filename": "Plan 2026.pdf",
        "base64": base64.b64encode(content).decode(),
    }
    result = json.loads(mcp_server.browser_export_gsuite(tab_id=2, format="pdf"))
    assert result["status"] == "success"
    data = result["data"]
    assert "base64" not in data and "base64" not in json.dumps(result)
    path = Path(data["output_path"])
    assert path.parent == exports_dir.resolve()
    assert path.name.startswith("Plan 2026_") and path.suffix == ".pdf"
    assert path.read_bytes() == content and data["size_bytes"] == len(content)
    assert bridge["calls"][0][:2] == ("export-gsuite", {"tab_id": 2, "format": "pdf"})
    assert bridge["calls"][0][2] >= 60.0
    assert list(exports_dir.iterdir()) == [path]  # aucun fichier temporaire laissé


def test_gsuite_chrome_download_is_read_then_removed(bridge, exports_dir, tmp_path):
    """Export redirigé vers googleusercontent (mesuré le 16/10) : fichier téléchargé par Chrome, lu puis supprimé."""
    downloads = tmp_path / "Downloads" / "nexus-browser-exports"
    downloads.mkdir(parents=True)
    text_file = downloads / "1AbC.md"
    text_file.write_bytes("﻿# Plan\n\nMARQUEUR".encode())
    bridge["reply"] = {"document_id": "1AbC", "title": "Plan", "format": "md", "extension": "md", "binary": False,
                       "download_path": str(text_file)}  # fmt: skip
    data = json.loads(mcp_server.browser_export_gsuite(tab_id=2))["data"]
    assert data["text"] == "# Plan\n\nMARQUEUR" and "download_path" not in data and not text_file.exists()
    pdf_file = downloads / "1AbC.pdf"
    pdf_file.write_bytes(b"%PDF-1.7 corps")
    bridge["reply"] = {"document_id": "1AbC", "title": "Plan", "format": "pdf", "extension": "pdf", "binary": True,
                       "download_path": str(pdf_file)}  # fmt: skip
    data = json.loads(mcp_server.browser_export_gsuite(tab_id=2, format="pdf"))["data"]
    assert Path(data["output_path"]).read_bytes() == b"%PDF-1.7 corps" and not pdf_file.exists()


def test_gsuite_download_outside_export_folder_is_refused(bridge, exports_dir, tmp_path):
    """Le client ne lit ni ne supprime jamais un fichier hors de Téléchargements\\nexus-browser-exports."""
    other = tmp_path / "Documents" / "important.md"
    other.parent.mkdir(parents=True)
    other.write_text("à garder", encoding="utf-8")
    bridge["reply"] = {"document_id": "1AbC", "format": "md", "extension": "md", "binary": False,
                       "download_path": str(other)}  # fmt: skip
    result = json.loads(mcp_server.browser_export_gsuite(tab_id=2))
    assert result["status"] == "error" and "nexus-browser-exports" in result["error"]
    assert other.read_text(encoding="utf-8") == "à garder"


def test_gsuite_hostile_filename_stays_in_exports_dir(bridge, exports_dir):
    bridge["reply"] = {
        "kind": "spreadsheets",
        "document_id": "1ZyX",
        "format": "xlsx",
        "extension": "xlsx",
        "binary": True,
        "filename": "..\\..\\Windows\\evil:name?.xlsx",
        "base64": base64.b64encode(b"PK\x03\x04").decode(),
    }
    data = json.loads(mcp_server.browser_export_gsuite(tab_id=1, format="xlsx", gid=7))["data"]
    path = Path(data["output_path"])
    assert path.parent == exports_dir.resolve() and path.suffix == ".xlsx"
    assert ":" not in path.name and "?" not in path.name
    assert bridge["calls"][0][1]["gid"] == "7"


def test_gsuite_text_returned_and_bounded_with_full_copy_on_disk(bridge, exports_dir):
    bridge["reply"] = {"kind": "document", "document_id": "1AbC", "format": "md", "extension": "md", "binary": False}
    bridge["reply"]["text"] = "# Court\n"
    data = json.loads(mcp_server.browser_export_gsuite(tab_id=1))["data"]
    assert data["text"] == "# Court\n" and data["truncated"] is False and "output_path" not in data
    assert not exports_dir.exists() or not list(exports_dir.iterdir())
    long_text = "Ligne de document.\n" * 50
    bridge["reply"]["text"] = long_text
    data = json.loads(mcp_server.browser_export_gsuite(tab_id=1, max_chars=100))["data"]
    assert data["truncated"] is True and len(data["text"]) == 100 and data["total_chars"] == len(long_text)
    assert Path(data["output_path"]).read_text(encoding="utf-8") == long_text


def test_gsuite_clear_error_from_extension_is_kept(bridge, exports_dir):
    bridge["reply"] = RuntimeError("Export Google Docs (docx) refusé (HTTP 403) : droits insuffisants pour ce compte")
    result = json.loads(mcp_server.browser_export_gsuite(tab_id=1, format="docx"))
    assert result["status"] == "error" and "HTTP 403" in result["error"]
    assert not exports_dir.exists()
    bridge["reply"] = {"binary": True, "extension": "pdf", "base64": "pas du base64 !"}
    assert json.loads(mcp_server.browser_export_gsuite(tab_id=1, format="pdf"))["status"] == "error"


def test_youtube_transcript_forwarding(bridge):
    mcp_server.browser_youtube_transcript(tab_id=9, lang="fr")
    mcp_server.browser_youtube_transcript(tab_id=9, format="vtt", max_chars=2000, enable_captions=False)
    assert bridge["calls"][0] == (
        "export-youtube-transcript",
        {"tab_id": 9, "format": "json3", "maxChars": 100_000, "enableCaptions": True, "lang": "fr"},
        45.0,
    )
    assert bridge["calls"][1][1] == {"tab_id": 9, "format": "vtt", "maxChars": 2000, "enableCaptions": False}


def test_exports_read_only_except_youtube_during_emergency_stop(bridge):
    for action in ("export-content", "export_gsuite"):
        assert bridge_client.is_read_only_action(action)
    assert not bridge_client.is_read_only_action("export-youtube-transcript")  # peut activer les sous-titres
    package_stop.pressed()
    assert json.loads(mcp_server.browser_export(tab_id=1))["status"] == "success"
    assert json.loads(mcp_server.browser_youtube_transcript(tab_id=1))["status"] == "error"
    assert [action for action, _, _ in bridge["calls"]] == ["export-content"]


def test_export_tools_are_registered():
    for server in (mcp_server.browser_mcp,):
        names = set(mcp_server.listed_tool_names(server))
        assert {"browser_export", "browser_export_gsuite", "browser_youtube_transcript"} <= names


def test_default_exports_dir_is_outside_onedrive():
    directory = mcp_server._exports_dir()
    assert directory == Path.home() / ".nexus" / "nexus-browser" / "exports"
    assert "onedrive" not in str(directory).lower()


# -----------------------------------------------------------------------------
# Validation réelle : page d'article de --full-live et mode --exports-live
# -----------------------------------------------------------------------------
@pytest.fixture
def live_module():
    spec = importlib.util.spec_from_file_location(
        "live_browser_validation_exports", REPO_ROOT / "tests" / "live_browser_validation.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_full_live_serves_article_with_body_and_noise(live_module):
    fixture = live_module.FullFixture()
    try:
        page = urllib.request.urlopen(fixture.article_url, timeout=5).read().decode("utf-8")
    finally:
        fixture.close()
    for marker in ("CORPS-INTRO", "CORPS-TABLEAU", "CORPS-CODE", "CORPS-CONCLUSION"):
        assert marker in page
    for noise in ("BRUIT-MENU", "BRUIT-PUB", "BRUIT-COOKIES", "BRUIT-LATERAL", "BRUIT-FORMULAIRE", "BRUIT-PIED"):
        assert noise in page
    source = (REPO_ROOT / "tests" / "live_browser_validation.py").read_text(encoding="utf-8")
    assert "export_markdown_corps_sans_bruit" in source


def test_exports_live_skipped_without_urls_never_counted(live_module, monkeypatch):
    monkeypatch.delenv("AGY_TEST_GDOC_URL", raising=False)
    monkeypatch.delenv("AGY_TEST_YOUTUBE_URL", raising=False)

    def no_chrome(*args, **kwargs):
        raise AssertionError("aucun appel au pont sans URL")

    monkeypatch.setattr(live_module.bridge_client, "call_bridge", no_chrome)
    monkeypatch.setattr(live_module.mcp, "call_bridge", no_chrome)
    results, skipped = live_module.run_exports_validation()
    assert results == {} and len(skipped) == 2


def test_exports_live_not_run_by_full():
    script = (REPO_ROOT / "test.ps1").read_text(encoding="utf-8")
    assert "--exports-live" not in script
