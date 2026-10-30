# NexusBrowser installer for Windows 10/11 (Windows PowerShell 5.1 or PowerShell 7), no admin rights, no Python. It is a
# file of each release (listed in SHA256SUMS.txt, with build provenance): download it, check it, run it as a file:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\get.ps1
# It never runs downloaded code in memory: the package is checked, unpacked, and its install.ps1 started with -File.
# Downloads the latest release's NexusBrowser-win-x64.zip or NexusBrowser-win-arm64.zip (this PC's architecture), checks
# it against the release's SHA256SUMS.txt (build provenance: `gh attestation verify <zip> --repo pironjulien/NexusBrowser`),
# unpacks it into %LOCALAPPDATA%\NexusBrowser\app (the same folder on every update, so Chrome keeps the extension), then
# runs install.ps1 -Register: self-contained engine (no .NET needed), local bridge, native host, shared MCP daemon
# (127.0.0.1:16182, token in the user variable NEXUS_MCP_TOKEN), MCP server declared to the AI clients found (Claude
# Code, Claude Desktop, Codex, Antigravity), and a guide for the one manual step, loading the extension.
# Run it again to update.
# NEXUS_PACK=1 (the Nexus pack, get-nexus.ps1): no question, no wait, no window (no Chrome, no guide, no clipboard);
# exit code 0 on success; a last "NEXUS_PACK_RESULT ..." line; the pack shows the guide itself at the end:
#   & "$env:LOCALAPPDATA\NexusBrowser\app\scripts\guide-extension.ps1" -WaitSeconds 0
# For tests: NEXUS_BROWSER_SOURCE, a local release zip (checked against the SHA256SUMS.txt next to it when present)
# or an unpacked folder (a clone: install.ps1 then builds the engine with the .NET SDK); NEXUS_BROWSER_TAG, a release
# tag instead of the latest; NEXUS_BROWSER_ROOT, another install folder: download, check and unpack only, the engine
# answers --version, nothing is registered on the PC.
$ErrorActionPreference = 'Stop'
# Started from Explorer (right click > Run with PowerShell): the window would close at once, before the result or an
# error could be read. Never under the pack.
function Test-StartedFromExplorer {
    if (-not $PSCommandPath -or $env:NEXUS_PACK -eq '1') { return $false }
    $parent = (Get-CimInstance Win32_Process -Filter "ProcessId = $PID" -ErrorAction SilentlyContinue).ParentProcessId
    return [bool]($parent -and (Get-Process -Id $parent -ErrorAction SilentlyContinue).ProcessName -eq 'explorer')
}
trap {
    if (Test-StartedFromExplorer) {
        Write-Host $_ -ForegroundColor Red
        Read-Host 'Press Enter to close this window' | Out-Null
    }
    break
}
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is many times slower with its progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$repository = 'pironjulien/NexusBrowser'
$sandbox = [bool]$env:NEXUS_BROWSER_ROOT
$root = if ($sandbox) { $env:NEXUS_BROWSER_ROOT } else { Join-Path $env:LOCALAPPDATA 'NexusBrowser' }
$app = Join-Path $root 'app'
New-Item -ItemType Directory -Force $root | Out-Null

# Architecture of Windows itself (a 32-bit or emulated PowerShell reports its own in PROCESSOR_ARCHITECTURE).
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$rid = switch ($arch) { 'ARM64' { 'win-arm64' } 'AMD64' { 'win-x64' } default { throw "Unsupported Windows architecture: $arch (x64 or ARM64 needed)." } }
$zipName = "NexusBrowser-$rid.zip"

# Latest release tag from the redirect of github.com/.../releases/latest (Location: .../releases/tag/vX.Y.Z): no API
# call, so no "API rate limit exceeded" (60 requests an hour per IP without a token). The API stays as a fallback.
function Get-LatestTag {
    $location = $null
    try {
        $request = [Net.HttpWebRequest]::Create("https://github.com/$repository/releases/latest")
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
    (Invoke-RestMethod -UseBasicParsing "https://api.github.com/repos/$repository/releases/latest").tag_name
}

# Expected SHA-256 of one file in a SHA256SUMS.txt ("<hash>  <name>" lines).
function Get-ExpectedHash([string]$Sums, [string]$Name) {
    $expected = $null
    foreach ($line in ($Sums -split '\r?\n' | Where-Object { $_.Trim() })) {
        if ($line -notmatch '^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$') { throw 'SHA256SUMS.txt has an invalid line: installation refused.' }
        if ($Matches[2] -ceq $Name) {
            if ($expected) { throw "SHA256SUMS.txt lists $Name twice: installation refused." }
            $expected = $Matches[1].ToLowerInvariant()
        }
    }
    if (-not $expected) { throw "$Name is absent from SHA256SUMS.txt: installation refused." }
    return $expected
}

$download = Join-Path $root 'download'
if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download -Recurse -Force }
New-Item -ItemType Directory -Force $download | Out-Null
$source = $null
# A refused or broken download leaves nothing behind.
try {
if ($env:NEXUS_BROWSER_SOURCE -and (Test-Path -LiteralPath $env:NEXUS_BROWSER_SOURCE -PathType Container)) {
    $source = (Resolve-Path -LiteralPath $env:NEXUS_BROWSER_SOURCE).Path
    Write-Host "Installing NexusBrowser from $source..."
} else {
    $zip = Join-Path $download $zipName
    if ($env:NEXUS_BROWSER_SOURCE) {
        $local = (Resolve-Path -LiteralPath $env:NEXUS_BROWSER_SOURCE).Path
        Copy-Item -LiteralPath $local -Destination $zip
        $sumsFile = Join-Path (Split-Path $local) 'SHA256SUMS.txt'
        $sums = if (Test-Path -LiteralPath $sumsFile) { [IO.File]::ReadAllText($sumsFile) } else { $null }
        $zipName = Split-Path -Leaf $local
        Write-Host "Installing NexusBrowser from $local..."
    } else {
        $tag = if ($env:NEXUS_BROWSER_TAG) { $env:NEXUS_BROWSER_TAG } else { Get-LatestTag }
        $base = "https://github.com/$repository/releases/download/$tag"
        Write-Host "Downloading NexusBrowser $tag ($rid)..."
        Invoke-WebRequest -UseBasicParsing "$base/$zipName" -OutFile $zip
        $sums = [Text.Encoding]::UTF8.GetString((Invoke-WebRequest -UseBasicParsing "$base/SHA256SUMS.txt").RawContentStream.ToArray())
    }
    if ($sums) {
        $expected = Get-ExpectedHash $sums $zipName
        $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $expected) { throw "SHA-256 mismatch for $($zipName): the download is not the published package." }
        Write-Host 'Package checked against SHA256SUMS.txt.'
    } elseif (-not $env:NEXUS_BROWSER_SOURCE) { throw 'SHA256SUMS.txt missing from the release: installation refused.' }
    $source = Join-Path $download 'package'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $source)
    if (-not (Test-Path -LiteralPath (Join-Path $source 'engine\NexusBrowser.exe'))) { throw 'Not a NexusBrowser package (engine\NexusBrowser.exe missing).' }
}
} catch {
    Remove-Item -LiteralPath $download -Recurse -Force -ErrorAction SilentlyContinue
    throw
}

# The new version is prepared beside the working one (app.next), then the folder is switched by a single rename; a
# failed installation puts the previous folder back and installs it again. Same folder name: Chrome keeps the extension.
$next = Join-Path $root 'app.next'
$previous = Join-Path $root 'app.previous'
$failed = Join-Path $root 'app.failed'
foreach ($leftover in $next, $failed) {
    if (Test-Path -LiteralPath $leftover) { Remove-Item -LiteralPath $leftover -Recurse -Force }
}
& robocopy.exe $source $next /MIR /NFL /NDL /NJH /NJS /NP /XD .git | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copy to $next failed (robocopy $LASTEXITCODE)." }
Get-ChildItem -LiteralPath $next -Recurse -File | Unblock-File
Remove-Item -LiteralPath $download -Recurse -Force

if ($sandbox) {
    if (Test-Path -LiteralPath $app) { Remove-Item -LiteralPath $app -Recurse -Force }
    Rename-Item -LiteralPath $next -NewName 'app'
    $engine = Join-Path $app 'engine\NexusBrowser.exe'
    $answer = (& $engine --version | Out-String).Trim()
    $expectedVersion = (Get-Content (Join-Path $app 'VERSION') -Raw).Trim()
    if ($answer -ne $expectedVersion) { throw "Unpacked engine answers '$answer', expected $expectedVersion." }
    Write-Host "NexusBrowser $answer unpacked in $app (test folder: nothing registered)." -ForegroundColor Green
    return
}

$hadApp = Test-Path -LiteralPath $app
if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Recurse -Force }
if ($hadApp) {
    try {
        Rename-Item -LiteralPath $app -NewName 'app.previous'
    } catch {
        Remove-Item -LiteralPath $next -Recurse -Force
        throw "The folder $app is in use ($($_.Exception.Message)): nothing was changed. Close what uses it and try again."
    }
}
Rename-Item -LiteralPath $next -NewName 'app'

$shell = (Get-Process -Id $PID).Path  # the same PowerShell that runs this script
& $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $app 'install.ps1') -SkipTests -Register
$installCode = $LASTEXITCODE
if ($installCode -and $hadApp -and (Test-Path -LiteralPath (Join-Path $previous 'install.ps1'))) {
    Rename-Item -LiteralPath $app -NewName 'app.failed'
    Rename-Item -LiteralPath $previous -NewName 'app'
    Write-Warning "The installation failed (exit code $installCode): restoring the previous version."
    & $shell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $app 'install.ps1') -SkipTests -Register
    $restoreCode = $LASTEXITCODE
    Remove-Item -LiteralPath $failed -Recurse -Force -ErrorAction SilentlyContinue
    if ($restoreCode) { throw "The update failed and so did restoring the previous version (exit code $restoreCode). Log: $HOME\.nexus\nexus-browser\install.log" }
    throw "The update failed; the previous version is restored. Log: $HOME\.nexus\nexus-browser\install.log"
}
if ($installCode) { throw "NexusBrowser installation failed (see above). Log: $HOME\.nexus\nexus-browser\install.log" }
if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Recurse -Force -ErrorAction SilentlyContinue }

if (Test-StartedFromExplorer) { Read-Host 'Press Enter to close this window' | Out-Null }
