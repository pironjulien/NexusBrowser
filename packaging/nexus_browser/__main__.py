# pyright: reportMissingImports=false
# (nexus_browser.client exists only in the built wheel, where client/ is mirrored under this package.)
"""Entry point of the `nexus-browser` command: the MCP server over stdio, as `python client/mcp_server.py` does."""


def main() -> None:
    from nexus_browser.client import emergency_stop, mcp_server
    from nexus_browser.client.bridge_client import start_heartbeat

    # Shared emergency stop (Ctrl+Alt+Shift+Esc), session heartbeat, then the server (same order as mcp_server.py).
    emergency_stop.start()
    start_heartbeat()
    mcp_server.browser_mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
