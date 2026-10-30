# État de NexusBrowser sur ce PC : tâche du pont, hôte natif, résidus de l'ancien pont, doublon Antigravity, ancienne
# extension signalée ; -Browser : pont joint et extension chargée à jour (version et fonctions annoncées par ping).
param([switch]$Browser)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\runtime.ps1')
try {
    $bridge = Get-ScheduledTask -TaskName $bridgeTaskName -ErrorAction SilentlyContinue
    $useNative = $bridge -and $bridge.Actions.Execute -eq $nativeExe
    $bridgeAligned = if ($useNative) { $bridge.Actions.Arguments -match '(?:^|\s)--bridge(?:\s|$)' } else {
        $bridge.Actions.Execute -eq $pythonwExe -and $bridge.Actions.Arguments -like '*bridge_server.py*'
    }
    if (-not $bridge -or $bridge.State -eq 'Disabled' -or -not $bridgeAligned) {
        throw "Tâche « $bridgeTaskName » absente ou inactive : relancer install.ps1"
    }
    if ($bridge.Triggers) { throw "La tâche du pont a un déclencheur : relancer install.ps1 (lancement à la demande)" }
    if ($useNative -and -not (Test-Path -LiteralPath $nativeExe -PathType Leaf)) { throw 'Moteur natif NexusBrowser absent.' }
    if (Get-ScheduledTask -TaskName 'NexusAGY Browser Bridge' -ErrorAction SilentlyContinue) {
        throw 'Ancienne tâche « NexusAGY Browser Bridge » encore là (mêmes ports) : relancer install.ps1'
    }
    $runtime = if ($useNative) { 'Native' } else { 'Python' }
    & (Join-Path $PSScriptRoot 'scripts\installer-hote-natif.ps1') -CheckOnly -Runtime $runtime
    # Résidus de l'ancien pont de NexusAGY : hôte natif (clé et fichiers) et jeton.
    if (Test-Path 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.nexusagy.bridge_auth') {
        throw 'Ancien hôte natif com.nexusagy.bridge_auth encore déclaré à Chrome : relancer install.ps1'
    }
    foreach ($old in 'bridge-token', 'native-host\com.nexusagy.bridge_auth.json', 'native-host\nexusagy_bridge_auth.cmd') {
        $path = Join-Path $HOME ".nexusagy\$old"
        if (Test-Path -LiteralPath $path) { throw "Résidu de l'ancien pont encore présent ($path) : relancer install.ps1" }
    }
    # Antigravity : nexus-browser déclaré par son plugin seulement (sinon deux serveurs, outils en double).
    & (Join-Path $PSScriptRoot 'scripts\doublon-antigravity.ps1') -ConfigPath (Join-Path $HOME '.gemini\config\mcp_config.json') -CheckOnly
    if ($LASTEXITCODE) { throw 'Doublon nexus-browser chez Antigravity : relancer install.ps1 (Antigravity fermé)' }
    # Ancienne extension « Antigravity Browser Bridge » chargée dans Chrome (profil lu, jamais modifié) : signalée.
    $oldExtension = @(& (Join-Path $PSScriptRoot 'scripts\ancienne-extension.ps1'))
    foreach ($line in $oldExtension) {
        Write-Warning "Ancienne extension encore chargée ($line) : la retirer dans chrome://extensions (mêmes ports que le pont)."
    }
    if ($Browser) {
        if ($bridge.State -ne 'Running') { Start-ScheduledTask -TaskName $bridgeTaskName; Start-Sleep -Seconds 2 }
        $token = [IO.File]::ReadAllText($tokenFile).Trim()
        $status = Invoke-RestMethod -Uri 'http://127.0.0.1:9225/api/status' `
            -Headers @{ 'X-Nexus-Browser-Token' = $token } -TimeoutSec 5
        if ($status.PSObject.Properties['chrome_running'] -and -not $status.chrome_running) {
            throw 'Chrome est ferme ; browser_new_tab le rouvrira avec le profil Default. Le pont reste disponible.'
        }
        if ($status.connected_clients -lt 1) { throw 'Chrome est ouvert, mais aucune extension NexusBrowser authentifiée.' }
        $result = Invoke-RestMethod -Uri 'http://127.0.0.1:9225/api/command' -Method Post `
            -Headers @{ 'X-Nexus-Browser-Token' = $token } -ContentType 'application/json' `
            -Body '{"action":"ping","timeout":3}' -TimeoutSec 5
        $version = (Get-Content (Join-Path $PSScriptRoot 'extension\manifest.json') -Raw | ConvertFrom-Json).version
        if (-not $result.success -or $result.data.version -ne $version) {
            throw "Extension chargée non alignée (attendu $version) : la recharger dans chrome://extensions"
        }
        $source = Get-Content (Join-Path $PSScriptRoot 'extension\background.js') -Raw
        $declared = [regex]::Match($source, 'const AGY_FEATURES = \[(.*?)\];', 'Singleline').Groups[1].Value
        $wanted = @([regex]::Matches($declared, '"([^"]+)"') | ForEach-Object { $_.Groups[1].Value } | Sort-Object)
        $loaded = @($result.data.features | Sort-Object)
        if (($wanted -join ',') -ne ($loaded -join ',')) {
            throw 'Ancien service worker encore actif (fonctions annoncées différentes du dépôt) : recharger l''extension'
        }
        Write-Host "Pont navigateur : OK ($version)."
    }
    $specPath = Join-Path $HOME '.nexus\daemons\specs\nexus-browser.json'
    if (Test-Path -LiteralPath $specPath) {
        $spec = Get-Content -LiteralPath $specPath -Raw | ConvertFrom-Json
        $expected = if ($useNative) { $spec.python -eq $nativeExe -and $spec.args.Count -eq 0 } else {
            $spec.python -eq $pythonExe -and $spec.args -contains (Join-Path $PSScriptRoot 'client\mcp_server.py')
        }
        if (-not $expected -or $spec.port -ne 16182) {
            throw 'Demon MCP Browser non aligne sur le runtime du pont : relancer install.ps1.'
        }
        if ($useNative) {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:16182/health' -TimeoutSec 5
            if ($health.status -ne 'ok' -or $health.service -ne 'nexus-browser' -or $health.runtime -ne 'native') {
                throw 'Le port MCP Browser ne confirme pas le moteur natif attendu.'
            }
        }
    }
    Write-Host 'NexusBrowser : OK sur ce PC.'
    exit 0
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
