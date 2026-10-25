# NexusBrowser one-line installer for Windows 10/11 (Windows PowerShell 5.1 or PowerShell 7), no admin rights:
#   irm https://raw.githubusercontent.com/pironjulien/NexusBrowser/main/get.ps1 | iex
# Installs uv if missing (https://docs.astral.sh/uv/), downloads the latest NexusBrowser release into
# %LOCALAPPDATA%\NexusBrowser\app (the same folder on every update, so Chrome keeps the extension), then runs
# install.ps1 -Register: Python environment, local bridge, native host, MCP server declared to the AI clients found
# (Claude Code, Claude Desktop, Codex, Antigravity), and a guide for the one manual step, loading the extension.
# Run it again to update. NEXUS_BROWSER_SOURCE (a local folder) installs that copy instead of the latest release.
# NEXUS_PACK=1 (the Nexus pack, get-nexus.ps1): no question, no wait, no window (no Chrome, no guide, no clipboard);
# exit code 0 on success; a last "NEXUS_PACK_RESULT ..." line; the pack shows the guide itself at the end:
#   & "$env:LOCALAPPDATA\NexusBrowser\app\scripts\guide-extension.ps1" -WaitSeconds 0
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

# Latest release tag from the redirect of github.com/.../releases/latest (Location: .../releases/tag/vX.Y.Z): no API
# call, so no "API rate limit exceeded" (60 requests an hour per IP without a token: shared IPs, CI, retries). The API
# stays as a fallback only.
function Get-LatestTag {
    $latest = 'https://github.com/pironjulien/NexusBrowser/releases/latest'
    $location = $null
    try {
        $request = [Net.HttpWebRequest]::Create($latest)
        $request.AllowAutoRedirect = $false
        $request.Method = 'HEAD'
        $request.UserAgent = 'NexusBrowser-get'
        $response = $request.GetResponse()
        $location = $response.Headers['Location']
        $response.Close()
    } catch [Net.WebException] {
        # .NET (pwsh 7) reports a 3xx without auto-redirect as an exception that still carries the response.
        if ($_.Exception.Response) { $location = $_.Exception.Response.Headers['Location'] }
    } catch { }
    if ($location -match '/releases/tag/([^/?#]+)$') { return $Matches[1] }
    Write-Warning 'Latest release not found through github.com; asking the GitHub API instead.'
    (Invoke-RestMethod -UseBasicParsing 'https://api.github.com/repos/pironjulien/NexusBrowser/releases/latest').tag_name
}

if ($env:NEXUS_BROWSER_SOURCE) {
    $source = (Resolve-Path -LiteralPath $env:NEXUS_BROWSER_SOURCE).Path
    Write-Host "Installing NexusBrowser from $source..."
} else {
    $tag = Get-LatestTag
    Write-Host "Downloading NexusBrowser $tag..."
    $download = Join-Path $root 'download'
    if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download -Recurse -Force }
    New-Item -ItemType Directory -Force $download | Out-Null
    $zip = Join-Path $download 'NexusBrowser.zip'
    Invoke-WebRequest -UseBasicParsing "https://github.com/pironjulien/NexusBrowser/archive/refs/tags/$tag.zip" -OutFile $zip
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
