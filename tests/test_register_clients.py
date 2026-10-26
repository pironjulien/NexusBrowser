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


def test_antigravity_gets_a_plugin_and_the_global_entry_of_an_earlier_version_goes(home, monkeypatch):
    monkeypatch.setattr(rc, "antigravity_running", lambda: False)
    folder = home / ".gemini" / "config"
    folder.mkdir(parents=True)
    old = {"mcpServers": {"other": {"command": "x"}, "nexus-browser": rc.entry(PY, SERVER, "Antigravity")}}
    (folder / "mcp_config.json").write_text(json.dumps(old), encoding="utf-8")
    (folder / "config.json").write_text('{"theme": "dark"}', encoding="utf-8")
    assert rc.antigravity(home, PY, SERVER, home / "b").startswith("plugin installed and enabled")
    plugin = folder / "plugins" / "nexus-browser"
    assert json.loads((plugin / "mcp_config.json").read_text(encoding="utf-8")) == {
        "mcpServers": {"nexus-browser": rc.entry(PY, SERVER, "Antigravity")}
    }
    assert json.loads((plugin / "plugin.json").read_text(encoding="utf-8"))["name"] == "nexus-browser"
    assert (plugin / "logo.png").read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"  # plugin logo (Nexus family icon)
    assert "Julien" not in (plugin / "skills" / "nexus-browser" / "SKILL.md").read_text(encoding="utf-8")
    assert json.loads((folder / "mcp_config.json").read_text(encoding="utf-8")) == {
        "mcpServers": {"other": {"command": "x"}}
    }
    assert json.loads((folder / "config.json").read_text(encoding="utf-8")) == {
        "theme": "dark",
        "plugins": {"nexus-browser": {"enabled": True}},
    }
    assert rc.short(rc.antigravity(home, PY, SERVER, home / "b")) == "plugin"  # run again: same plugin, in place


def test_antigravity_open_or_without_config_is_told_to_enable_it(home, monkeypatch):
    monkeypatch.setattr(rc, "antigravity_running", lambda: True)
    folder = home / ".gemini" / "antigravity"
    folder.mkdir(parents=True)
    (folder / "config.json").write_text("{}", encoding="utf-8")
    assert "enable nexus-browser" in rc.antigravity(home, PY, SERVER, home / "b")
    assert json.loads((folder / "config.json").read_text(encoding="utf-8")) == {}


def test_antigravity_plugin_of_the_user_kept(home):
    """Poste Nexus : le plugin pointe vers le démon partagé (serverUrl) ; il n'est pas touché."""
    plugin = home / ".gemini" / "config" / "plugins" / "nexus-browser"
    plugin.mkdir(parents=True)
    mine = {"mcpServers": {"nexus-browser": {"serverUrl": "http://127.0.0.1:16182/mcp?agent=antigravity"}}}
    (plugin / "mcp_config.json").write_text(json.dumps(mine), encoding="utf-8")
    assert rc.antigravity(home, PY, SERVER, home / "b") == rc.PLUGIN
    assert json.loads((plugin / "mcp_config.json").read_text(encoding="utf-8")) == mine


def test_pack_summary_words():
    assert [rc.short(r) for r in (None, "declared in x", "already declared", rc.PLUGIN, rc.REMOVED)] == [
        "absent",
        "declared",
        "declared",
        "plugin",
        "plugin",
    ]
    assert (
        rc.short("plugin installed in x") == "plugin"
        and rc.short("kept (y)") == "kept"
        and rc.short("failed: z") == "failed"
    )


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


def test_claude_desktop_store_claude_data_and_left_folder_skipped(home):
    local = home / "AppData" / "Local"
    store = local / "Packages" / "AnthropicPBC.Claude_abc" / "LocalCache" / "Roaming" / "Claude"
    data = local / "Claude-Data" / "anthropicpbc.claude_abc"
    left = local / "Claude-Data" / "anthropicpbc.claude_old"
    for folder in (store, data, left):
        folder.mkdir(parents=True)
    (left / ".user-data-left.2026-10-25").write_text("", encoding="utf-8")
    results = rc.claude_desktop(home, PY, SERVER, home / "b")
    assert len(results) == 2 and all(r.startswith("declared") for r in results)
    for folder in (store, data):
        assert json.loads((folder / "claude_desktop_config.json").read_text(encoding="utf-8"))["mcpServers"]
    assert not (left / "claude_desktop_config.json").exists()


def test_unreadable_file_left_untouched(home):
    (home / ".codex").mkdir()
    (home / ".codex" / "config.toml").write_text("not = [valid", encoding="utf-8")
    with pytest.raises(ValueError):
        rc.codex(home, PY, SERVER, home / "b")
    assert (home / ".codex" / "config.toml").read_text(encoding="utf-8") == "not = [valid"


def test_pack_scope_configures_only_the_listed_ai_apps(home, monkeypatch, capsys):
    """NEXUS_PACK_TARGETS (le -Only / -Skip du pack) : seules ces IA sont configurées, les autres ne sont pas touchées."""
    monkeypatch.setattr(rc.Path, "home", classmethod(lambda cls: home))
    (home / ".codex").mkdir()
    (home / ".codex" / "config.toml").write_text('model = "x"\n', encoding="utf-8")
    desktop = home / "AppData" / "Roaming" / "Claude"
    desktop.mkdir(parents=True)
    claude_json = home / ".claude.json"
    claude_json.write_text("{}", encoding="utf-8")
    monkeypatch.setenv("NEXUS_PACK", "1")
    monkeypatch.setenv("NEXUS_PACK_TARGETS", "codex")
    argv = ["register_clients.py", "--python", PY, "--server", SERVER, "--backups", str(home / "b")]
    monkeypatch.setattr(rc.sys, "argv", argv)
    assert rc.main() == 0
    out = capsys.readouterr().out
    assert "nexus-browser" in (home / ".codex" / "config.toml").read_text(encoding="utf-8")
    assert not (desktop / "claude_desktop_config.json").exists()  # Claude Desktop exclue : rien d'écrit
    assert claude_json.read_text(encoding="utf-8") == "{}"  # Claude Code exclu : fichier intact
    assert "Claude Desktop=skipped" in out and "Claude Code=skipped" in out and "Codex=declared" in out
    monkeypatch.setenv("NEXUS_PACK_TARGETS", "codex, chatgpt")
    assert rc.main() == 2  # nom inconnu : refusé, rien configuré
    assert rc.pack_scope("") == set() and rc.pack_scope(None) is None  # vide : aucune IA ; absente : toutes


def test_claude_desktop_with_the_mcpb_extension_gets_no_second_server(home):
    """Extension .mcpb de Claude Desktop installée : elle lance déjà le serveur, aucune entrée n'est ajoutée et celle
    de l'installeur est retirée (outils en double sinon) ; une entrée écrite par l'utilisateur reste."""
    desktop = home / "AppData" / "Roaming" / "Claude"
    rc.claude_desktop(home, PY, SERVER, home / "b")  # dossier absent : rien
    desktop.mkdir(parents=True)
    assert rc.claude_desktop(home, PY, SERVER, home / "b")[0].startswith("declared")
    extension = desktop / "Claude Extensions" / "local.mcpb.julien-piron.nexus-browser"
    extension.mkdir(parents=True)
    (extension / "manifest.json").write_text(json.dumps({"name": "nexus-browser"}), encoding="utf-8")
    result = rc.claude_desktop(home, PY, SERVER, home / "b")[0]
    assert result == rc.MCPB + " (the installer's own entry removed)" and rc.short(result) == "plugin"
    config = json.loads((desktop / "claude_desktop_config.json").read_text(encoding="utf-8"))
    assert "nexus-browser" not in config.get("mcpServers", {})
    assert rc.claude_desktop(home, PY, SERVER, home / "b") == [rc.MCPB]
