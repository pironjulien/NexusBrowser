"""Declares the nexus-browser MCP server to the AI clients found on this PC (install.ps1 -Register, one-line install).

Claude Code (CLI or ~/.claude.json), Claude Desktop and Codex (~/.codex/config.toml): one stdio entry each, run by the
local environment's Python, with the client's name as NEXUS_BROWSER_AGENT (its tab group). Antigravity: a
nexus-browser plugin (plugins/nexus-browser: that stdio server and the skill), never an entry in its global
mcp_config.json. An entry of ours is replaced in place; an entry the user wrote differently, or a nexus-browser plugin
that already provides another server, is left alone. Nothing else in these files is touched; each file is written
atomically after a backup next to the install's logs. Prints one line per client, and with NEXUS_PACK=1 a last
"NEXUS_PACK_RESULT Claude Code=...; Codex=...; Antigravity=..." line for the Nexus pack.
NEXUS_PACK_TARGETS (the pack's -Only / -Skip, e.g. "claude-code,codex"): only these AI apps are configured; the others are
not touched at all and reported as skipped.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tomllib
from datetime import datetime
from pathlib import Path

NAME = "nexus-browser"
# Names of the AI apps as the Nexus pack gives them (get-nexus.ps1 -Only / -Skip) -> client shown in the summary.
PACK_AIS = {
    "claude-code": "Claude Code",
    "claude-desktop": "Claude Desktop",
    "codex": "Codex",
    "antigravity": "Antigravity",
}


def pack_scope(value: str | None) -> set[str] | None:
    """Clients to configure from NEXUS_PACK_TARGETS, set by the pack (get-nexus.ps1): None when it is not set (every
    client found), an empty set when it is empty (none). Unknown names are refused."""
    if value is None:
        return None
    names = {part.strip().lower() for part in re.split(r"[,\s]+", value) if part.strip()}
    unknown = names - PACK_AIS.keys()
    if unknown:
        raise ValueError(f"unknown AI app in NEXUS_PACK_TARGETS: {', '.join(sorted(unknown))}")
    return {PACK_AIS[name] for name in names}


def entry(python: str, server: str, agent: str) -> dict:
    return {"command": python, "args": ["-B", server], "env": {"NEXUS_BROWSER_AGENT": agent}}


def ours(existing: object, server: str) -> bool:
    """An entry written by this script (same server file), or none at all."""
    if existing is None:
        return True
    return isinstance(existing, dict) and server in [str(a) for a in existing.get("args", [])]


def backup(path: Path, backups: Path) -> None:
    if path.exists():
        backups.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        shutil.copy2(path, backups / f"{path.parent.name}-{path.name}-{stamp}")


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".nexus-tmp")
    temporary.write_text(text, encoding="utf-8", newline="\n")
    os.replace(temporary, path)


def set_json_server(path: Path, value: dict, server: str, backups: Path) -> str:
    data = json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() and path.stat().st_size else {}
    servers = data.setdefault("mcpServers", {})
    if not ours(servers.get(NAME), server):
        return "kept (an entry of yours already exists)"
    if servers.get(NAME) == value:
        return "already declared"
    backup(path, backups)
    servers[NAME] = value
    write_atomic(path, json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    return f"declared in {path}"


def remove_json_server(path: Path, server: str, backups: Path) -> bool:
    """A plugin now provides the server: our earlier entry would start a second one (tools twice). Only ours."""
    if not path.exists() or not path.stat().st_size:
        return False
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    current = data.get("mcpServers", {}).get(NAME)
    if current is None or not ours(current, server):
        return False
    backup(path, backups)
    del data["mcpServers"][NAME]
    write_atomic(path, json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    return True


PLUGIN = "provided by the nexus-browser plugin"
REMOVED = PLUGIN + " (the installer's own entry removed)"


def claude_plugin_enabled(home: Path) -> bool:
    settings = home / ".claude" / "settings.json"
    try:
        enabled = json.loads(settings.read_text(encoding="utf-8-sig")).get("enabledPlugins", {})
    except (OSError, ValueError):
        return False
    return any(key.split("@")[0] == NAME and on for key, on in enabled.items())


def claude_code(home: Path, python: str, server: str, backups: Path) -> str | None:
    cli = shutil.which("claude")
    config = home / ".claude.json"
    if claude_plugin_enabled(home):
        if cli and config.exists():
            current = json.loads(config.read_text(encoding="utf-8-sig")).get("mcpServers", {}).get(NAME)
            if current is not None and ours(current, server):
                subprocess.run([cli, "mcp", "remove", NAME, "--scope", "user"], capture_output=True, check=False)
                return REMOVED
            return PLUGIN
        return REMOVED if remove_json_server(config, server, backups) else PLUGIN
    if cli:
        current = None
        if config.exists():
            current = json.loads(config.read_text(encoding="utf-8-sig")).get("mcpServers", {}).get(NAME)
        if not ours(current, server):
            return "kept (an entry of yours already exists)"
        subprocess.run([cli, "mcp", "remove", NAME, "--scope", "user"], capture_output=True, check=False)
        added = subprocess.run(
            [
                cli,
                "mcp",
                "add",
                NAME,
                "--scope",
                "user",
                "-e",
                "NEXUS_BROWSER_AGENT=Claude",
                "--",
                python,
                "-B",
                server,
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if added.returncode:
            return f"failed: {(added.stderr or added.stdout).strip()}"
        return "declared (claude mcp add, user scope)"
    if config.exists():
        return set_json_server(config, {"type": "stdio", **entry(python, server, "Claude")}, server, backups)
    return None


def claude_desktop(home: Path, python: str, server: str, backups: Path) -> list[str]:
    roaming = Path(os.environ.get("APPDATA", home / "AppData" / "Roaming"))
    local = Path(os.environ.get("LOCALAPPDATA", home / "AppData" / "Local"))
    # Classic install; the Store (MSIX) one, whose AppData is redirected into its package (AnthropicPBC.Claude_...);
    # and the Store one that reads %LOCALAPPDATA%\Claude-Data\<package>. A folder it left (.user-data-left.*) is skipped.
    folders = [
        roaming / "Claude",
        *sorted((local / "Packages").glob("*Claude_*/LocalCache/Roaming/Claude")),
        *sorted(path for path in (local / "Claude-Data").glob("*") if path.is_dir()),
    ]
    return [
        claude_desktop_folder(folder, python, server, backups)
        for folder in folders
        if folder.is_dir() and not any(folder.glob(".user-data-left.*"))
    ]


MCPB = "provided by the nexus-browser extension of Claude Desktop (.mcpb)"


def mcpb_installed(folder: Path) -> bool:
    """The nexus-browser .mcpb extension installed in this Claude Desktop (Claude Extensions/<id>/manifest.json)."""
    for manifest in folder.glob("Claude Extensions/*/manifest.json"):
        try:
            if json.loads(manifest.read_text(encoding="utf-8-sig")).get("name") == NAME:
                return True
        except (OSError, ValueError):
            continue
    return False


def claude_desktop_folder(folder: Path, python: str, server: str, backups: Path) -> str:
    """One Claude Desktop: its .mcpb extension, when installed, already starts the server; an entry would add a
    second one (tools twice), so ours is removed and none is added."""
    config = folder / "claude_desktop_config.json"
    if mcpb_installed(folder):
        return MCPB + (" (the installer's own entry removed)" if remove_json_server(config, server, backups) else "")
    return set_json_server(config, entry(python, server, "Claude"), server, backups)


TOML_TABLE = re.compile(r"^\[(?P<name>[^\]]+)\]\s*$", re.M)


def toml_string(text: str) -> str:
    return json.dumps(text, ensure_ascii=False)  # a JSON string is a valid TOML basic string


def codex(home: Path, python: str, server: str, backups: Path) -> str | None:
    folder = home / ".codex"
    if not folder.is_dir() and not shutil.which("codex"):
        return None
    config = folder / "config.toml"
    text = config.read_text(encoding="utf-8-sig") if config.exists() else ""
    current = tomllib.loads(text).get("mcp_servers", {}).get(NAME)
    if not ours(current, server):
        return "kept (an entry of yours already exists)"
    if current == entry(python, server, "Codex"):
        return "already declared"
    if current is not None:
        # Our own tables ([mcp_servers.nexus-browser] and its subtables) are cut out, each up to the next table.
        parts, dropping, position = [], False, 0
        for match in TOML_TABLE.finditer(text):
            if not dropping:
                parts.append(text[position : match.start()])
            name = match.group("name").strip()
            dropping = name == f"mcp_servers.{NAME}" or name.startswith(f"mcp_servers.{NAME}.")
            position = match.start()
        if not dropping:
            parts.append(text[position:])
        text = "".join(parts)
        if tomllib.loads(text).get("mcp_servers", {}).get(NAME) is not None:
            return "kept (entry written in a form this installer does not edit)"
    block = (
        f"[mcp_servers.{NAME}]\n"
        f"command = {toml_string(python)}\n"
        f"args = [{toml_string('-B')}, {toml_string(server)}]\n\n"
        f"[mcp_servers.{NAME}.env]\n"
        'NEXUS_BROWSER_AGENT = "Codex"\n'
    )
    new = text.rstrip("\n") + ("\n\n" if text.strip() else "") + block
    if tomllib.loads(new).get("mcp_servers", {}).get(NAME) != entry(python, server, "Codex"):
        return "failed: the edited config.toml would not read back"  # never write a file Codex could not read
    backup(config, backups)
    write_atomic(config, new)
    return f"declared in {config}"


ROOT = Path(__file__).resolve().parents[1]


def antigravity_running() -> bool:
    found = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq Antigravity.exe", "/NH"], capture_output=True, text=True, check=False
    )
    return "antigravity.exe" in found.stdout.lower()


def antigravity(home: Path, python: str, server: str, backups: Path) -> str | None:
    """One plugin per product (no entry in the global mcp_config.json): plugins/nexus-browser with its stdio server
    and the public skill, enabled in config.json while Antigravity is closed (open, it would write its file back)."""
    # Antigravity has used both folders; the one that exists is the one it reads.
    for folder in (home / ".gemini" / "config", home / ".gemini" / "antigravity"):
        if not folder.is_dir():
            continue
        plugin = folder / "plugins" / NAME
        plugin_config = plugin / "mcp_config.json"
        if plugin_config.exists():
            current = json.loads(plugin_config.read_text(encoding="utf-8-sig")).get("mcpServers", {}).get(NAME)
            if current is not None and not ours(current, server):  # a plugin of the user's own (another server)
                return REMOVED if remove_json_server(folder / "mcp_config.json", server, backups) else PLUGIN
        manifest = json.loads((ROOT / "plugins" / NAME / "plugin.json").read_text(encoding="utf-8"))
        write_atomic(plugin / "plugin.json", json.dumps(manifest, indent=2) + "\n")
        servers = {"mcpServers": {NAME: entry(python, server, "Antigravity")}}
        write_atomic(plugin_config, json.dumps(servers, indent=2, ensure_ascii=False) + "\n")
        write_atomic(plugin / "skills" / NAME / "SKILL.md", (ROOT / "skills" / NAME / "SKILL.md").read_text("utf-8"))
        remove_json_server(folder / "mcp_config.json", server, backups)  # global entry of an earlier version
        app = folder / "config.json"
        if app.exists() and not antigravity_running():
            data = json.loads(app.read_text(encoding="utf-8-sig"))
            if (data.get("plugins") or {}).get(NAME, {}).get("enabled") is not True:
                backup(app, backups)
                data.setdefault("plugins", {})[NAME] = {"enabled": True}
                write_atomic(app, json.dumps(data, indent=2, ensure_ascii=False) + "\n")
            return f"plugin installed and enabled in {plugin}"
        return f"plugin installed in {plugin} (enable nexus-browser in Antigravity's plugins if it is not)"
    return None


def short(result: str | None) -> str:
    """One word per client for the Nexus pack's summary line."""
    if result is None:
        return "absent"
    for prefix, word in (
        ("skipped", "skipped"),
        ("failed", "failed"),
        ("kept", "kept"),
        ("provided by", "plugin"),
        ("plugin", "plugin"),
    ):
        if result.startswith(prefix):
            return word
    return "declared"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", required=True)
    parser.add_argument("--server", required=True)
    parser.add_argument("--backups", required=True)
    args = parser.parse_args()
    home = Path.home()
    backups = Path(args.backups)
    results: dict[str, str | None] = {}
    try:
        scope = pack_scope(os.environ.get("NEXUS_PACK_TARGETS"))
    except ValueError as error:
        print(error)
        return 2
    skipped = "skipped (not in the Nexus pack's list)"
    for client, declare in (("Claude Code", claude_code), ("Codex", codex), ("Antigravity", antigravity)):
        if scope is not None and client not in scope:
            results[client] = skipped
            continue
        try:
            results[client] = declare(home, args.python, args.server, backups)
        except (OSError, ValueError) as error:  # unreadable file (JSON or TOML): left as it is
            results[client] = f"failed: {error}"
    try:
        if scope is not None and "Claude Desktop" not in scope:
            results["Claude Desktop"] = skipped
        else:
            for index, result in enumerate(claude_desktop(home, args.python, args.server, backups)):
                results["Claude Desktop" + (f" ({index + 1})" if index else "")] = result
    except (OSError, ValueError) as error:
        results["Claude Desktop"] = f"failed: {error}"
    found = False
    for client, result in results.items():
        if result is not None:
            found = True
            print(f"{client}: {result}")
    if not found:
        print("No AI client found (Claude, Codex, Antigravity): install one, then run the installer again.")
    if os.environ.get("NEXUS_PACK") == "1":  # summary line read by the Nexus pack (get-nexus.ps1)
        print("NEXUS_PACK_RESULT " + "; ".join(f"{client}={short(result)}" for client, result in results.items()))
    return 1 if any(r and r.startswith("failed") for r in results.values()) else 0


if __name__ == "__main__":
    sys.exit(main())
