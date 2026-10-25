"""Declares the nexus-browser MCP server to the AI clients found on this PC (install.ps1 -Register, one-line install).

Claude Code (CLI or ~/.claude.json), Claude Desktop, Codex (~/.codex/config.toml) and Antigravity (mcp_config.json):
one stdio entry each, run by the local environment's Python, with the client's name as NEXUS_BROWSER_AGENT (its tab
group). An entry of ours is replaced in place; an entry the user wrote differently, or a nexus-browser plugin that
already provides the server, is left alone. Nothing else in these files is touched; each file is written atomically
after a backup next to the install's logs. Prints one line per client.
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
    # Classic install, then the Store (MSIX) one, whose AppData is redirected into its package.
    folders = [roaming / "Claude", *sorted((local / "Packages").glob("Claude_*/LocalCache/Roaming/Claude"))]
    return [
        set_json_server(folder / "claude_desktop_config.json", entry(python, server, "Claude"), server, backups)
        for folder in folders
        if folder.is_dir()
    ]


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


def antigravity(home: Path, python: str, server: str, backups: Path) -> str | None:
    # Antigravity has used both folders; the one that exists is the one it reads.
    for folder in (home / ".gemini" / "config", home / ".gemini" / "antigravity"):
        if folder.is_dir():
            if (folder / "plugins" / NAME).is_dir():
                return REMOVED if remove_json_server(folder / "mcp_config.json", server, backups) else PLUGIN
            return set_json_server(folder / "mcp_config.json", entry(python, server, "Antigravity"), server, backups)
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", required=True)
    parser.add_argument("--server", required=True)
    parser.add_argument("--backups", required=True)
    args = parser.parse_args()
    home = Path.home()
    backups = Path(args.backups)
    results: dict[str, str | None] = {}
    for client, declare in (("Claude Code", claude_code), ("Codex", codex), ("Antigravity", antigravity)):
        try:
            results[client] = declare(home, args.python, args.server, backups)
        except (OSError, ValueError) as error:  # unreadable file (JSON or TOML): left as it is
            results[client] = f"failed: {error}"
    try:
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
    return 1 if any(r and r.startswith("failed") for r in results.values()) else 0


if __name__ == "__main__":
    sys.exit(main())
