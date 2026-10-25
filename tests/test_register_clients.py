"""scripts/register_clients.py (installation publique, install.ps1 -Register) : une entrée stdio par client trouvé,
remplacée en place si elle est à nous, jamais celle que l'utilisateur a écrite autrement, rien d'autre de touché."""

import importlib.util
import json
import tomllib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("register_clients", ROOT / "scripts" / "register_clients.py")
assert SPEC and SPEC.loader
rc = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rc)

PY = r"D:\NexusTest\venv\Scripts\python.exe"
SERVER = r"D:\NexusTest\app\client\mcp_server.py"


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(rc.shutil, "which", lambda name: None)
    monkeypatch.setenv("APPDATA", str(tmp_path / "AppData" / "Roaming"))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "AppData" / "Local"))
    return tmp_path


def test_codex_added_then_replaced_in_place_other_settings_kept(home):
    (home / ".codex").mkdir()
    config = home / ".codex" / "config.toml"
    config.write_text('model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n', encoding="utf-8")
    assert rc.codex(home, PY, SERVER, home / "b").startswith("declared")
    data = tomllib.loads(config.read_text(encoding="utf-8"))
    assert data["model"] == "gpt-5" and data["mcp_servers"]["other"] == {"command": "x"}
    assert data["mcp_servers"]["nexus-browser"] == rc.entry(PY, SERVER, "Codex")
    assert rc.codex(home, PY, SERVER, home / "b") == "already declared"
    # New Python (environment recreated): our tables are replaced, the table after them is kept.
    config.write_text(config.read_text(encoding="utf-8") + '\n[profiles.fast]\nmodel = "y"\n', encoding="utf-8")
    assert rc.codex(home, "C:/new/python.exe", SERVER, home / "b").startswith("declared")
    data = tomllib.loads(config.read_text(encoding="utf-8"))
    assert data["mcp_servers"]["nexus-browser"]["command"] == "C:/new/python.exe"
    assert data["profiles"]["fast"] == {"model": "y"} and data["mcp_servers"]["other"] == {"command": "x"}
    assert config.read_text(encoding="utf-8").count("[mcp_servers.nexus-browser]") == 1
    assert list((home / "b").iterdir())  # backup made before each write


def test_codex_entry_of_the_user_kept(home):
    (home / ".codex").mkdir()
    config = home / ".codex" / "config.toml"
    original = '[mcp_servers.nexus-browser]\ncommand = "uvx"\nargs = ["nexus-browser"]\n'
    config.write_text(original, encoding="utf-8")
    assert rc.codex(home, PY, SERVER, home / "b").startswith("kept")
    assert config.read_text(encoding="utf-8") == original


def test_codex_absent(home):
    assert rc.codex(home, PY, SERVER, home / "b") is None


def test_antigravity_config_folder_and_plugin(home):
    folder = home / ".gemini" / "config"
    folder.mkdir(parents=True)
    (folder / "mcp_config.json").write_text('{"mcpServers": {"other": {"command": "x"}}}', encoding="utf-8")
    assert rc.antigravity(home, PY, SERVER, home / "b").startswith("declared")
    servers = json.loads((folder / "mcp_config.json").read_text(encoding="utf-8"))["mcpServers"]
    assert (
        servers["other"] == {"command": "x"} and servers["nexus-browser"]["env"]["NEXUS_BROWSER_AGENT"] == "Antigravity"
    )
    # The plugin installed afterwards: our entry would start a second server, it is removed (the other one kept).
    (folder / "plugins" / "nexus-browser").mkdir(parents=True)
    assert rc.antigravity(home, PY, SERVER, home / "b") == rc.REMOVED
    assert json.loads((folder / "mcp_config.json").read_text(encoding="utf-8"))["mcpServers"] == {
        "other": {"command": "x"}
    }
    assert rc.antigravity(home, PY, SERVER, home / "b") == rc.PLUGIN


def test_antigravity_older_folder(home):
    (home / ".gemini" / "antigravity").mkdir(parents=True)
    assert rc.antigravity(home, PY, SERVER, home / "b").startswith("declared")
    assert (home / ".gemini" / "antigravity" / "mcp_config.json").exists()


def test_claude_code_without_cli_edits_claude_json(home):
    (home / ".claude.json").write_text('{"projects": {"C:/p": {}}, "mcpServers": {}}', encoding="utf-8")
    assert rc.claude_code(home, PY, SERVER, home / "b").startswith("declared")
    data = json.loads((home / ".claude.json").read_text(encoding="utf-8"))
    assert data["projects"] == {"C:/p": {}}
    assert data["mcpServers"]["nexus-browser"] == {"type": "stdio", **rc.entry(PY, SERVER, "Claude")}


def test_claude_code_plugin_enabled_left_alone(home):
    (home / ".claude").mkdir()
    (home / ".claude" / "settings.json").write_text(
        '{"enabledPlugins": {"nexus-browser@nexus": true}}', encoding="utf-8"
    )
    (home / ".claude.json").write_text("{}", encoding="utf-8")
    assert rc.claude_code(home, PY, SERVER, home / "b") == rc.PLUGIN
    assert (home / ".claude.json").read_text(encoding="utf-8") == "{}"


def test_claude_code_plugin_after_the_installer_removes_only_our_entry(home):
    (home / ".claude.json").write_text("{}", encoding="utf-8")
    assert rc.claude_code(home, PY, SERVER, home / "b").startswith("declared")
    (home / ".claude").mkdir()
    (home / ".claude" / "settings.json").write_text(
        '{"enabledPlugins": {"nexus-browser@nexus": true}}', encoding="utf-8"
    )
    assert rc.claude_code(home, PY, SERVER, home / "b") == rc.REMOVED
    assert json.loads((home / ".claude.json").read_text(encoding="utf-8"))["mcpServers"] == {}
    # An entry the user wrote is never removed, even with the plugin.
    user = {"mcpServers": {"nexus-browser": {"command": "uvx", "args": ["nexus-browser"]}}}
    (home / ".claude.json").write_text(json.dumps(user), encoding="utf-8")
    assert rc.claude_code(home, PY, SERVER, home / "b") == rc.PLUGIN
    assert json.loads((home / ".claude.json").read_text(encoding="utf-8")) == user


def test_claude_desktop_classic_and_store(home):
    classic = home / "AppData" / "Roaming" / "Claude"
    store = home / "AppData" / "Local" / "Packages" / "Claude_abc" / "LocalCache" / "Roaming" / "Claude"
    classic.mkdir(parents=True)
    store.mkdir(parents=True)
    results = rc.claude_desktop(home, PY, SERVER, home / "b")
    assert len(results) == 2 and all(r.startswith("declared") for r in results)
    for folder in (classic, store):
        assert json.loads((folder / "claude_desktop_config.json").read_text(encoding="utf-8"))["mcpServers"]


def test_unreadable_file_left_untouched(home):
    (home / ".codex").mkdir()
    (home / ".codex" / "config.toml").write_text("not = [valid", encoding="utf-8")
    with pytest.raises(ValueError):
        rc.codex(home, PY, SERVER, home / "b")
    assert (home / ".codex" / "config.toml").read_text(encoding="utf-8") == "not = [valid"
