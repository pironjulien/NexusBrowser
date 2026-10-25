"""Contrôle de l'installation publique sur un Windows neuf (CI « Install », après get.ps1) : chaque client trouvé a
son entrée, puis un vrai aller-retour MCP stdio -> pont -> extension -> page, lancé comme le ferait le client.
Lancé par le Python de l'environnement installé ; pas un test pytest (il faut le pont, l'extension et Chrome)."""

import json
import subprocess
import sys
import tomllib
from pathlib import Path

import anyio
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

APP = Path(sys.argv[1])
HOME = Path.home()
SERVER = str(APP / "client" / "mcp_server.py")


def check_entries() -> None:
    claude = subprocess.run("claude mcp get nexus-browser", shell=True, capture_output=True, text=True, check=False)
    assert claude.returncode == 0 and SERVER in claude.stdout, claude.stdout + claude.stderr
    codex = tomllib.loads((HOME / ".codex" / "config.toml").read_text(encoding="utf-8"))["mcp_servers"]["nexus-browser"]
    assert codex["args"] == ["-B", SERVER] and codex["env"]["NEXUS_BROWSER_AGENT"] == "Codex"
    for path, agent in (
        (HOME / ".gemini" / "antigravity" / "mcp_config.json", "Antigravity"),
        (HOME / "AppData" / "Roaming" / "Claude" / "claude_desktop_config.json", "Claude"),
    ):
        server = json.loads(path.read_text(encoding="utf-8"))["mcpServers"]["nexus-browser"]
        assert server["args"] == ["-B", SERVER] and server["env"]["NEXUS_BROWSER_AGENT"] == agent, path
    print("Entries: Claude Code, Claude Desktop, Codex, Antigravity OK")


async def round_trip() -> None:
    params = StdioServerParameters(command=sys.executable, args=["-B", SERVER], env={"NEXUS_BROWSER_AGENT": "CI"})
    with anyio.fail_after(120):
        async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
            await session.initialize()
            assert len((await session.list_tools()).tools) == 49

            async def call(name: str, arguments: dict) -> dict:
                result = await session.call_tool(name, arguments)
                text = "".join(getattr(block, "text", "") for block in result.content)
                assert not result.is_error, f"{name}: {text}"
                payload = json.loads(json.loads(text)["result"]) if text.startswith('{"result"') else json.loads(text)
                assert payload.get("status") == "success", f"{name}: {payload}"
                return payload["data"]

            tab = (await call("browser_new_tab", {"url": "https://example.com/"}))["id"]
            try:
                await call("browser_wait_load", {"tab_id": tab})
                exported = await call("browser_export", {"tab_id": tab})
                assert "Example Domain" in exported["content"], exported
            finally:
                await call("browser_close_tab", {"tab_id": tab})
    print("Round trip: new tab, export, close OK")


check_entries()
anyio.run(round_trip)
