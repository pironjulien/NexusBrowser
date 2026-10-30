# Paths of NexusBrowser on this PC, outside OneDrive: data in ~\.nexus\nexus-browser (token, logs, captures, exports),
# immutable engine builds in %LOCALAPPDATA%\NexusBrowser\versions\<fingerprint>, the one in use named by current.json.
# Windows PowerShell 5.1 and pwsh 7 (ASCII file).
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$localRoot = Join-Path $env:USERPROFILE '.nexus\nexus-browser'
$tokenFile = Join-Path $localRoot 'bridge-token'
$bridgeTaskName = 'Nexus Browser Bridge'
$daemonTaskName = 'Nexus Browser MCP'
$updateTaskName = 'Nexus Browser Update'
$nativeRoot = Join-Path $env:LOCALAPPDATA 'NexusBrowser'
$versionsRoot = Join-Path $nativeRoot 'versions'
$currentFile = Join-Path $nativeRoot 'current.json'
$legacyExe = Join-Path $nativeRoot 'native\NexusBrowser.exe'
$daemonSpec = Join-Path $HOME '.nexus\daemons\specs\nexus-browser.json'
$restartRequest = Join-Path $localRoot 'daemon-restart.request'
$buildRoot = Join-Path $HOME '.nexus\build\nexus-browser'

# The engine in use (current.json), else the legacy fixed folder of versions before 2.33.0.
function Get-CurrentExe {
    if (Test-Path -LiteralPath $currentFile) {
        $exe = (Get-Content -LiteralPath $currentFile -Raw | ConvertFrom-Json).exe
        if ($exe -and (Test-Path -LiteralPath $exe -PathType Leaf)) { return $exe }
    }
    if (Test-Path -LiteralPath $legacyExe -PathType Leaf) { return $legacyExe }
    return $null
}
$nativeExe = Get-CurrentExe

# Runs the engine (a WinExe: PowerShell would not wait for it) hidden, waits, returns its exit code and output.
function Invoke-Native([string]$Exe, [string[]]$Arguments, [int]$TimeoutSeconds = 120) {
    $info = New-Object Diagnostics.ProcessStartInfo $Exe
    $info.Arguments = (($Arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' ')
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.Encoding]::UTF8
    $process = [Diagnostics.Process]::Start($info)
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) { $process.Kill(); throw "$Exe $Arguments : no answer in $TimeoutSeconds s." }
    [pscustomobject]@{ Code = $process.ExitCode; Output = ($stdout.Result + $stderr.Result).Trim() }
}

# Same value as the engine's RestartRequest.CodeFingerprint: its main assembly (framework-dependent build) or the
# single-file executable (release build).
function Get-BuildFingerprint([string]$Directory) {
    $dll = Join-Path $Directory 'NexusBrowser.dll'
    $file = if (Test-Path -LiteralPath $dll) { $dll } else { Join-Path $Directory 'NexusBrowser.exe' }
    (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
}
