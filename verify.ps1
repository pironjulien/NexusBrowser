# État de NexusBrowser sur ce PC : tâche du pont, hôte natif, résidus de l'ancien pont, doublon Antigravity, ancienne
# extension signalée ; -Browser : pont joint et extension chargée à jour (version et fonctions annoncées par ping).
param([switch]$Browser)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\runtime.ps1')

function Assert-RunningVersion([string]$Service, $State, [string]$ExpectedVersion) {
    if ($State.version -ne $ExpectedVersion) {
        $runningVersion = if ($State.version) { $State.version } else { 'inconnue' }
        throw "$Service actif en version $runningVersion (PID $($State.pid)), moteur installe $ExpectedVersion : processus non aligne. Aucun arret force ; les sessions actives sont conservees."
    }
}

try {
    if (-not $nativeExe -or -not (Test-Path -LiteralPath $nativeExe -PathType Leaf)) { throw 'Moteur natif NexusBrowser absent : relancer install.ps1' }
    $installed = Invoke-Native $nativeExe @('--version') 5
    if ($installed.Code -ne 0 -or $installed.Output -notmatch '^\d+\.\d+\.\d+$') { throw "Version du moteur installe illisible : $($installed.Output)" }
    $expectedVersion = $installed.Output
    $bridge = Get-ScheduledTask -TaskName $bridgeTaskName -ErrorAction SilentlyContinue
    if (-not $bridge -or $bridge.State -eq 'Disabled' -or $bridge.Actions.Execute -ne $nativeExe -or
        $bridge.Actions.Arguments -notmatch '(?:^|\s)--bridge(?:\s|$)') {
        throw "Tâche « $bridgeTaskName » absente, inactive ou sur un autre moteur : relancer install.ps1"
    }
    if ($bridge.Triggers) { throw "La tâche du pont a un déclencheur : relancer install.ps1 (lancement à la demande)" }
    if (Get-ScheduledTask -TaskName 'NexusAGY Browser Bridge' -ErrorAction SilentlyContinue) {
        throw 'Ancienne tâche « NexusAGY Browser Bridge » encore là (mêmes ports) : relancer install.ps1'
    }
    & (Join-Path $PSScriptRoot 'scripts\installer-hote-natif.ps1') -CheckOnly -Exe $nativeExe
    foreach ($old in 'bridge-token', 'native-host\com.nexusagy.bridge_auth.json', 'native-host\nexusagy_bridge_auth.cmd') {
        $path = Join-Path $HOME ".nexusagy\$old"
        if (Test-Path -LiteralPath $path) { throw "Résidu de l'ancien pont encore présent ($path) : relancer install.ps1" }
    }
    # Antigravity : nexus-browser déclaré par son plugin seulement (sinon deux serveurs, outils en double).
    & (Join-Path $PSScriptRoot 'scripts\doublon-antigravity.ps1') -ConfigPath (Join-Path $HOME '.gemini\config\mcp_config.json') -CheckOnly
    if ($LASTEXITCODE) { throw 'Doublon nexus-browser chez Antigravity : relancer install.ps1 (Antigravity fermé)' }
    # Ancienne extension « Antigravity Browser Bridge » chargée dans Chrome (profil lu, jamais modifié) : signalée.
    foreach ($line in @(& (Join-Path $PSScriptRoot 'scripts\ancienne-extension.ps1'))) {
        Write-Warning "Ancienne extension encore chargée ($line) : la retirer dans chrome://extensions (mêmes ports que le pont)."
    }
    if ($Browser) {
        if ($bridge.State -ne 'Running') { Start-ScheduledTask -TaskName $bridgeTaskName; Start-Sleep -Seconds 2 }
        $bridgeStatus = Invoke-RestMethod -Uri 'http://127.0.0.1:9225/api/status' -Headers @{
            'X-Nexus-Browser-Token' = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
        } -TimeoutSec 5
        if ($bridgeStatus.status -ne 'online') { throw 'Le port du pont Browser ne confirme pas le service attendu.' }
        Assert-RunningVersion 'Pont Browser' $bridgeStatus $expectedVersion
        $check = Invoke-Native $nativeExe @('--refresh-extension', '--check-only', '--wait-ready', '5') 60
        if ($check.Code -eq 2) { throw "Pont ou extension injoignable : $($check.Output)" }
        if ($check.Code -eq 1) { throw 'Extension chargée non alignée sur cette version : la recharger dans chrome://extensions' }
        Write-Host "Pont navigateur : OK ($($check.Output))."
    }
    if (Test-Path -LiteralPath $daemonSpec) {
        $spec = Get-Content -LiteralPath $daemonSpec -Raw | ConvertFrom-Json
        if ($spec.exe -ne $nativeExe -or $spec.port -ne 16182 -or @($spec.args).Count -ne 0) {
            throw 'Démon MCP Browser non aligné sur le moteur installé : relancer install.ps1.'
        }
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:16182/health' -TimeoutSec 5
        if ($health.status -ne 'ok' -or $health.service -ne 'nexus-browser' -or $health.runtime -ne 'native') {
            throw 'Le port MCP Browser ne confirme pas le moteur natif attendu.'
        }
        Assert-RunningVersion 'Demon MCP Browser' $health $expectedVersion
    }
    Write-Host 'NexusBrowser : OK sur ce PC.'
    exit 0
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
