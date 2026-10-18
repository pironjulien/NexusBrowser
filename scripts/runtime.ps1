# Environnement local de NexusBrowser, HORS OneDrive (~\.nexus\nexus-browser) : Python, caches, jeton, journaux.
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$localRoot = Join-Path $env:USERPROFILE ".nexus\nexus-browser"
$venv = Join-Path $localRoot "venv"
$pythonExe = Join-Path $venv "Scripts\python.exe"
$pythonwExe = Join-Path $venv "Scripts\pythonw.exe"
$tokenFile = Join-Path $localRoot "bridge-token"
$bridgeTaskName = "Nexus Browser Bridge"
$env:UV_PROJECT_ENVIRONMENT = $venv
$env:UV_LINK_MODE = "copy"
$env:RUFF_CACHE_DIR = Join-Path $localRoot "cache\ruff"
$env:PYTHONDONTWRITEBYTECODE = "1"
$env:PYTHONPYCACHEPREFIX = Join-Path $localRoot "cache\pycache"
$env:PYRIGHT_PYTHON_CACHE_DIR = Join-Path $localRoot "cache\pyright"
$env:PYRIGHT_PYTHON_IGNORE_WARNINGS = "1"
