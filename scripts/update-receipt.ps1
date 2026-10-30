# Read-only activation receipt. Installed files are never treated as proof of loaded code.
param([string]$Published)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime.ps1')

function Get-ActivationState($Current, $Daemon, $Bridge, $Extension) {
    $validFingerprint = $Current.fingerprint -match '^[0-9a-fA-F]{64}$'
    $daemonOk = $validFingerprint -and $Daemon.status -eq 'ok' -and $Daemon.service -eq 'nexus-browser' -and
        $Daemon.version -eq $Current.version -and $Daemon.fingerprint -eq $Current.fingerprint
    $bridgeOk = $validFingerprint -and $Bridge.status -eq 'online' -and $Bridge.version -eq $Current.version -and
        $Bridge.fingerprint -eq $Current.fingerprint
    $extensionOk = $Extension.verified -eq $true
    $ok = $daemonOk -and $bridgeOk -and $extensionOk
    [ordered]@{
        schema = 1; product = 'browser'; state = $(if ($ok) { 'done' } else { 'deferred' })
        published = $Published; installed = $Current.version; active = $(if ($ok) { $Current.version } else { $null })
        fingerprint = $Current.fingerprint; retryable = -not $ok
        reason = $(if ($ok) { 'loaded-code-verified' } elseif (-not $daemonOk) { 'daemon-activation-pending' }
            elseif (-not $bridgeOk) { 'bridge-activation-pending' } else { 'extension-activation-pending' })
        components = [ordered]@{
            daemon = @{ version = $Daemon.version; fingerprint = $Daemon.fingerprint; pid = $Daemon.pid; verified = $daemonOk }
            bridge = @{ version = $Bridge.version; fingerprint = $Bridge.fingerprint; pid = $Bridge.pid; verified = $bridgeOk }
            extension = $Extension
        }
    }
}

$current = Get-Content -LiteralPath $currentFile -Raw | ConvertFrom-Json
$daemon = $null; $bridge = $null; $extension = $null
try { $daemon = Invoke-RestMethod -Uri 'http://127.0.0.1:16182/health' -TimeoutSec 3 } catch { }
try {
    $bridge = Invoke-RestMethod -Uri 'http://127.0.0.1:9225/api/status' -Headers @{
        'X-Nexus-Browser-Token' = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
    } -TimeoutSec 3
    $probe = Invoke-Native $current.exe @('--refresh-extension', '--check-only') 15
    $extension = $probe.Output | ConvertFrom-Json
} catch { }
$result = Get-ActivationState $current $daemon $bridge $extension
$path = Join-Path $localRoot 'update-receipt.json'
$temporary = "$path.$PID.tmp"
$text = $result | ConvertTo-Json -Depth 8 -Compress
[IO.File]::WriteAllText($temporary, $text, (New-Object Text.UTF8Encoding $false))
Move-Item -LiteralPath $temporary -Destination $path -Force
Write-Output "NEXUS_UPDATE_RESULT $text"
