# NexusBrowser one-line installer for Windows 10/11 (Windows PowerShell 5.1 or PowerShell 7), no admin rights:
#   irm https://raw.githubusercontent.com/pironjulien/NexusBrowser/main/get.ps1 | iex
# Installs uv if missing (https://docs.astral.sh/uv/), downloads the latest NexusBrowser release into
# %LOCALAPPDATA%\NexusBrowser\app (the same folder on every update, so Chrome keeps the extension), then runs
# install.ps1 -Register: Python environment, local bridge, native host, MCP server declared to the AI clients found
# (Claude Code, Claude Desktop, Codex, Antigravity), and a guide for the one manual step, loading the extension.
# Run it again to update. NEXUS_BROWSER_SOURCE (a local folder) installs that copy instead of the latest release.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is many times slower with its progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$root = Join-Path $env:LOCALAPPDATA 'NexusBrowser'
$app = Join-Path $root 'app'
New-Item -ItemType Directory -Force $root | Out-Null

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Host 'Installing uv (Python package manager, https://docs.astral.sh/uv/)...'
    $uvInstaller = Join-Path $root 'uv-install.ps1'
    Invoke-WebRequest -UseBasicParsing 'https://astral.sh/uv/install.ps1' -OutFile $uvInstaller
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $uvInstaller
    if ($LASTEXITCODE) { throw 'uv installation failed.' }
    Remove-Item -LiteralPath $uvInstaller
    $env:Path = (Join-Path $HOME '.local\bin') + ';' + $env:Path
    if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw 'uv is installed but not found: open a new terminal and run this command again.' }
}

if ($env:NEXUS_BROWSER_SOURCE) {
    $source = (Resolve-Path -LiteralPath $env:NEXUS_BROWSER_SOURCE).Path
    Write-Host "Installing NexusBrowser from $source..."
} else {
    $release = Invoke-RestMethod -UseBasicParsing 'https://api.github.com/repos/pironjulien/NexusBrowser/releases/latest'
    Write-Host "Downloading NexusBrowser $($release.tag_name)..."
    $download = Join-Path $root 'download'
    if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download -Recurse -Force }
    New-Item -ItemType Directory -Force $download | Out-Null
    $zip = Join-Path $download 'NexusBrowser.zip'
    Invoke-WebRequest -UseBasicParsing "https://github.com/pironjulien/NexusBrowser/archive/refs/tags/$($release.tag_name).zip" -OutFile $zip
    Expand-Archive -LiteralPath $zip -DestinationPath $download
    $source = (Get-ChildItem -LiteralPath $download -Directory | Select-Object -First 1).FullName
}

# Mirror into the stable folder (files of an older version that no longer exist are removed).
& robocopy.exe $source $app /MIR /NFL /NDL /NJH /NJS /NP /XD .git | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copy to $app failed (robocopy $LASTEXITCODE)." }
Get-ChildItem -LiteralPath $app -Recurse -File | Unblock-File
if (-not $env:NEXUS_BROWSER_SOURCE) { Remove-Item -LiteralPath (Join-Path $root 'download') -Recurse -Force }

$shell = (Get-Process -Id $PID).Path  # the same PowerShell that runs this script
& $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $app 'install.ps1') -SkipTests -Register
if ($LASTEXITCODE) { throw "NexusBrowser installation failed (see above). Log: $HOME\.nexus\nexus-browser\install.log" }
