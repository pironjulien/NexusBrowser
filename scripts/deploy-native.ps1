# Deploy one tested candidate. Stop only this product; never the AI apps or Chrome.
param([Parameter(Mandatory=$true)][string]$CandidateDirectory, [switch]$BridgeOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime.ps1')
$candidateExe = Join-Path $CandidateDirectory 'NexusBrowser.exe'
if (-not (Test-Path -LiteralPath $candidateExe -PathType Leaf)) { throw 'Tested native candidate absent.' }
$bridgeStatus = $null
if (Test-Path -LiteralPath $tokenFile) {
    $headers = @{ 'X-Nexus-Browser-Token' = [IO.File]::ReadAllText($tokenFile).Trim() }
    try { $bridgeStatus = Invoke-RestMethod -Uri 'http://127.0.0.1:9225/api/status' -Headers $headers -TimeoutSec 3 } catch { }
    if ($bridgeStatus.connected_clients -gt 0) {
        $headers['X-Nexus-Browser-Agent'] = 'Installer'
        $headers['X-Nexus-Browser-Client'] = 'installer-native-deploy'
        $tabs = Invoke-RestMethod -Uri 'http://127.0.0.1:9225/api/command' -Method Post -Headers $headers `
            -ContentType 'application/json' -Body '{"action":"list-tabs","params":{},"timeout":3}' -TimeoutSec 5
        if (-not $tabs.success) { throw 'Cannot establish whether Browser agents are busy; no process stopped.' }
        if (@($tabs.data | Where-Object { $_.owner }).Count) { throw 'Browser agent tabs are active; deployment deferred.' }
    }
}
$spec = Join-Path $HOME '.nexus\daemons\specs\nexus-browser.json'
$parked = "$spec.installing"
if (Test-Path -LiteralPath $parked) { throw 'An unfinished NexusBrowser deployment must be resolved first.' }
$hadSpec = -not $BridgeOnly -and (Test-Path -LiteralPath $spec)
if ($hadSpec) { Move-Item -LiteralPath $spec -Destination $parked }
try {
    # Removing the spec asks the supervisor to stop this product's process tree first.
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $daemon = @(Get-CimInstance Win32_Process | Where-Object {
            $_.CommandLine -match '--http\s+16182' -and
            ($_.ExecutablePath -eq $nativeExe -or (-not $BridgeOnly -and $_.CommandLine -like "*$(Join-Path $repositoryRoot 'client\mcp_server.py')*"))
        })
        if (-not $daemon.Count) { break }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($daemon.Count) { throw 'Browser MCP daemon did not stop; native installation left intact.' }
    $bridge = Get-ScheduledTask -TaskName $bridgeTaskName -ErrorAction SilentlyContinue
    if ($bridge.State -eq 'Running') { Stop-ScheduledTask -TaskName $bridgeTaskName }
    # Failed auth hosts from the previous WinExe cannot answer Chrome; allow Chrome to reconnect to the new one.
    Get-CimInstance Win32_Process -Filter "Name='NexusBrowser.exe'" | Where-Object {
        $_.ExecutablePath -eq $nativeExe -and ($_.CommandLine -match '--bridge(?:\s|$)' -or $_.CommandLine -match 'chrome-extension://[a-p]{32}/')
    } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction Stop }
    $destination = Split-Path -Parent $nativeExe
    [IO.Directory]::CreateDirectory($destination) | Out-Null
    Get-ChildItem -LiteralPath $CandidateDirectory | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $destination $_.Name) -Recurse -Force
    }
    [IO.File]::WriteAllText((Join-Path $destination 'installation.json'),
        (@{repository_root=$repositoryRoot} | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    if ($hadSpec) {
        $nextSpec = [ordered]@{port=16182; python=$nativeExe; args=@(); env=[ordered]@{}}
        $temporary = "$spec.tmp"
        [IO.File]::WriteAllText($temporary, ($nextSpec | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $spec -Force
        Remove-Item -LiteralPath $parked
    }
} finally {
    if (Test-Path -LiteralPath $parked) { Move-Item -LiteralPath $parked -Destination $spec -Force }
}
Write-Host 'Native NexusBrowser deployed; Chrome and AI apps remain open.'
