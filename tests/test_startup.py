"""Le serveur MCP démarre seul, sans Chrome, sans pont ni extension, sur tout système (Windows, Linux) : initialize
puis tools/list. C'est ce que vérifient les annuaires MCP (Glama) dans un conteneur Linux ; la CI le lance aussi sous
Linux. Profil temporaire (HOME, USERPROFILE) : ni le vrai jeton du pont ni le vrai ~/.nexus/stop ne sont lus."""

import os
import sys
from pathlib import Path

import anyio
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

REPO_ROOT = Path(__file__).resolve().parent.parent


def test_initialize_and_list_tools(tmp_path):
    env = {**os.environ, "HOME": str(tmp_path), "USERPROFILE": str(tmp_path), "NEXUS_BROWSER_AGENT": "Test"}
    params = StdioServerParameters(command=sys.executable, args=[str(REPO_ROOT / "client" / "mcp_server.py")], env=env)
    version = (REPO_ROOT / "VERSION").read_text(encoding="utf-8").strip()

    async def session_check():
        async with stdio_client(params) as (read, write), ClientSession(read, write) as session:
            init = await session.initialize()
            assert init.server_info.name == "nexus-browser"
            assert init.server_info.version == version
            tools = (await session.list_tools()).tools
            assert len(tools) == 52
            for tool in tools:
                assert tool.annotations is not None and tool.annotations.title, tool.name

    async def check():
        with anyio.fail_after(60):
            await session_check()

    anyio.run(check)
