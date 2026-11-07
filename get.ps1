# NexusBrowser installer for Windows 10/11 (Windows PowerShell 5.1 or PowerShell 7), no admin rights, no Python. It is a
# file of each release (listed in SHA256SUMS.txt, with build provenance): download it, check it, run it as a file:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\get.ps1
# A minimal starter: it downloads the latest release's NexusBrowser-win-x64.zip or NexusBrowser-win-arm64.zip (this PC's
# architecture), checks it against the release's SHA256SUMS.txt and, when the GitHub CLI is signed in, its build
# provenance, unpacks it, and starts the package's own engine: NexusBrowser.exe --install does everything else
# (%LOCALAPPDATA%\NexusBrowser\app switched by one rename and restored on failure, immutable engine build, native host,
# tasks, shared MCP daemon 127.0.0.1:16182 with the user token NEXUS_MCP_TOKEN, AI clients found, extension guide).
# It never runs downloaded code in memory. Run it again to update.
# NEXUS_RELEASE_TAG: install that release (vX.Y.Z, or a development build vX.Y.Z-dev.N) instead of the latest; set by
# NexusSystem for its development channel.
# NEXUS_PACK=1 (the Nexus pack, get-nexus.ps1): no question, no wait, no window (no Chrome, no guide, no clipboard);
# exit code 0 on success; a last "NEXUS_PACK_RESULT ..." line; the pack shows the guide itself at the end:
#   & "$env:LOCALAPPDATA\NexusBrowser\app\scripts\guide-extension.ps1" -WaitSeconds 0
# -UpdateOnly (NexusSystem maintenance): an installed release only, no new AI app configured, NEXUS_UPDATE_RESULT line.
# For tests: NEXUS_BROWSER_SOURCE, a local release zip (checked against the SHA256SUMS.txt next to it when present) or
# an unpacked release folder; NEXUS_BROWSER_TAG, a release tag instead of the latest; NEXUS_BROWSER_ROOT, another
# install folder: check and unpack only, the engine answers --version, nothing is registered on the PC.
param([switch]$UpdateOnly)
$ErrorActionPreference = 'Stop'
if ($UpdateOnly) { $env:NEXUS_PACK = '1' }
# Windows PowerShell launched by PowerShell 7 can inherit Core-only modules ahead of its own standard modules.
if ($PSVersionTable.PSEdition -eq 'Desktop') {
    $desktopModules = Join-Path $PSHOME 'Modules'
    $env:PSModulePath = (@($desktopModules) + @($env:PSModulePath -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ine $desktopModules.TrimEnd('\') })) -join ';'
}
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
$firstNative = [version]'2.36.0'  # first release whose engine installs itself (--install)
$sandbox = [bool]$env:NEXUS_BROWSER_ROOT
$root = if ($sandbox) { $env:NEXUS_BROWSER_ROOT } else { Join-Path $env:LOCALAPPDATA 'NexusBrowser' }
if ($UpdateOnly -and -not $sandbox -and -not (Test-Path -LiteralPath (Join-Path $root 'current.json'))) {
    Write-Output 'NEXUS_UPDATE_RESULT {"product":"browser","state":"skipped","reason":"not-installed","retryable":false}'
    return
}
New-Item -ItemType Directory -Force $root | Out-Null
# Another installation or maintenance running: nothing is downloaded (the engine takes this lock for the whole switch).
try { [IO.File]::Open((Join-Path $root 'update.lock'), 'OpenOrCreate', 'ReadWrite', 'None').Dispose() }
catch [IO.IOException] {
    Write-Output 'NEXUS_UPDATE_RESULT {"product":"browser","state":"deferred","reason":"maintenance-in-progress","retryable":true}'
    return
}

# Architecture of Windows itself (a 32-bit or emulated PowerShell reports its own in PROCESSOR_ARCHITECTURE).
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$rid = switch ($arch) { 'ARM64' { 'win-arm64' } 'AMD64' { 'win-x64' } default { throw "Unsupported Windows architecture: $arch (x64 or ARM64 needed)." } }
$zipName = "NexusBrowser-$rid.zip"

# Latest release tag from the redirect of github.com/.../releases/latest (no API call, so no rate limit); the API
# stays as a fallback. NEXUS_RELEASE_TAG: that release instead, checked against its own SHA256SUMS.txt like any other.
function Get-LatestTag {
    if ($env:NEXUS_RELEASE_TAG) {
        if ($env:NEXUS_RELEASE_TAG -notmatch '^v\d+\.\d+\.\d+(-dev\.\d+)?$') { throw "NEXUS_RELEASE_TAG is not a release tag: $env:NEXUS_RELEASE_TAG" }
        return $env:NEXUS_RELEASE_TAG
    }
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

# Build provenance (Sigstore, signed by NexusSystem's shared release workflow) when the GitHub CLI is installed and
# signed in; a failed check refuses the package. gh writes to stderr when it is not signed in: under Windows
# PowerShell 5.1 with ErrorActionPreference Stop, a redirected stderr line of a native command is a terminating error,
# so gh runs with Continue here.
function Confirm-Provenance([string]$File) {
    $gh = Get-Command gh.exe -ErrorAction SilentlyContinue
    if (-not $gh) { return }
    $preference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $gh.Source auth status *> $null
        if ($LASTEXITCODE -ne 0) { Write-Host 'Build provenance not checked (GitHub CLI not signed in); SHA-256 checked.'; return }
        & $gh.Source attestation verify $File --repo $repository --signer-repo pironjulien/NexusSystem *> $null
        $verified = $LASTEXITCODE -eq 0
    } finally { $ErrorActionPreference = $preference }
    if (-not $verified) { throw "Build provenance of $(Split-Path -Leaf $File) not verified (gh attestation verify): installation refused." }
    Write-Host 'Build provenance verified.'
}
# Runs the engine (a Windows program: PowerShell would not wait for it) without a window, shows its output as it
# comes, returns its exit code. Its standard input is closed at once.
function Invoke-Engine([string]$Exe, [string[]]$Arguments) {
    $info = New-Object Diagnostics.ProcessStartInfo $Exe
    $info.Arguments = (($Arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' ')
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.Encoding]::UTF8
    $info.StandardErrorEncoding = [Text.Encoding]::UTF8
    $process = [Diagnostics.Process]::Start($info)
    $process.StandardInput.Close()
    $errors = $process.StandardError.ReadToEndAsync()
    while ($null -ne ($line = $process.StandardOutput.ReadLine())) { Write-Host $line }
    $process.WaitForExit()
    if ($errors.Result.Trim()) { Write-Host $errors.Result.Trim() }
    return $process.ExitCode
}

$mode = if ($UpdateOnly) { '--update-only' } else { '--register' }
$work = Join-Path $root ('download\' + [Guid]::NewGuid().ToString('N').Substring(0, 12))
$code = 1
try {
    $tag = $null
    if ($UpdateOnly -and -not $env:NEXUS_BROWSER_SOURCE) {
        # A deferred activation retried by maintenance: the installed release is reused when the engine proves it (else 10).
        $tag = if ($env:NEXUS_BROWSER_TAG) { $env:NEXUS_BROWSER_TAG } else { Get-LatestTag }
        $current = Get-Content -LiteralPath (Join-Path $root 'current.json') -Raw | ConvertFrom-Json
        $published = $tag.TrimStart('v')
        if ($current.version -eq $published -and $published -match '^\d+\.\d+\.\d+$' -and [version]$published -ge $firstNative -and $current.exe -and
            (Test-Path -LiteralPath $current.exe) -and (Get-FileHash -LiteralPath $current.exe -Algorithm SHA256).Hash -eq $current.fingerprint) {
            $code = Invoke-Engine $current.exe @('--install', '--reuse-installed', '--update-only')
            if ($code -ne 10) { exit $code }
        }
    }
    $sha = $null
    if ($env:NEXUS_BROWSER_SOURCE -and (Test-Path -LiteralPath $env:NEXUS_BROWSER_SOURCE -PathType Container)) {
        $package = (Resolve-Path -LiteralPath $env:NEXUS_BROWSER_SOURCE).Path
        Write-Host "Installing NexusBrowser from $package..."
    } else {
        New-Item -ItemType Directory -Force $work | Out-Null
        $zip = Join-Path $work $zipName
        if ($env:NEXUS_BROWSER_SOURCE) {
            $local = (Resolve-Path -LiteralPath $env:NEXUS_BROWSER_SOURCE).Path
            Copy-Item -LiteralPath $local -Destination $zip
            $sumsFile = Join-Path (Split-Path $local) 'SHA256SUMS.txt'
            $sums = if (Test-Path -LiteralPath $sumsFile) { [IO.File]::ReadAllText($sumsFile) } else { $null }
            $zipName = Split-Path -Leaf $local
            Write-Host "Installing NexusBrowser from $local..."
        } else {
            if (-not $tag) { $tag = if ($env:NEXUS_BROWSER_TAG) { $env:NEXUS_BROWSER_TAG } else { Get-LatestTag } }
            $base = "https://github.com/$repository/releases/download/$tag"
            Write-Host "Downloading NexusBrowser $tag ($rid)..."
            Invoke-WebRequest -UseBasicParsing "$base/$zipName" -OutFile $zip
            $sums = [Text.Encoding]::UTF8.GetString((Invoke-WebRequest -UseBasicParsing "$base/SHA256SUMS.txt").RawContentStream.ToArray())
        }
        if ($sums) {
            $sha = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($sha -ne (Get-ExpectedHash $sums $zipName)) { throw "SHA-256 mismatch for $($zipName): the download is not the published package." }
            Write-Host 'Package checked against SHA256SUMS.txt.'
        } elseif (-not $env:NEXUS_BROWSER_SOURCE) { throw 'SHA256SUMS.txt missing from the release: installation refused.' }
        if (-not $env:NEXUS_BROWSER_SOURCE) { Confirm-Provenance $zip }
        $package = Join-Path $work 'package'
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::ExtractToDirectory($zip, $package)
    }
    $engine = Join-Path $package 'engine\NexusBrowser.exe'
    if (-not (Test-Path -LiteralPath $engine)) { throw 'Not a NexusBrowser release package (engine\NexusBrowser.exe missing). A clone installs with its own install.ps1.' }
    $version = [version](Get-Content -LiteralPath (Join-Path $package 'VERSION') -Raw).Trim()
    if ($version -lt $firstNative) { throw "NexusBrowser $version predates this installer: use the get.ps1 of that release." }
    Get-ChildItem -LiteralPath $package -Recurse -File | Unblock-File
    $arguments = @('--install', '--switch', '--source', $package, $mode)
    if ($sha) { $arguments += @('--archive-sha256', $sha) }
    $code = Invoke-Engine $engine $arguments
} finally {
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
    $downloads = Split-Path $work
    if ((Test-Path -LiteralPath $downloads) -and -not (Get-ChildItem -LiteralPath $downloads -Force)) { Remove-Item -LiteralPath $downloads -Force }
}
if ($code) { Write-Host "NexusBrowser installation failed (exit code $code). Log: $HOME\.nexus\nexus-browser\install.log" -ForegroundColor Red }
if (Test-StartedFromExplorer) { Read-Host 'Press Enter to close this window' | Out-Null }
exit $code
