# pyright: reportMissingImports=false
# (nexus_browser is installed from PyPI by the host, see pyproject.toml.)
"""Entry point of the Claude Desktop extension: the nexus-browser server from PyPI, over stdio."""

from nexus_browser.__main__ import main

main()
