# État de NexusBrowser sur ce PC : tâche du pont, hôte natif, résidus de l'ancien pont, doublon Antigravity, ancienne
# extension signalée ; -Browser : pont joint et extension chargée à jour (version et fonctions annoncées par ping).
param([switch]$Browser)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\runtime.ps1')
try {
    $bridge = Get-ScheduledTask -TaskName $bridgeTaskName -ErrorAction SilentlyContinue
    if (-not $bridge -or $bridge.State -eq 'Disabled' -or $bridge.Actions.Execute -ne $pythonwExe) {
        throw "Tâche « $bridgeTaskName » absente ou inactive : relancer install.ps1"
    }
    if ($bridge.Triggers) { throw "La tâche du pont a un déclencheur : relancer install.ps1 (lancement à la demande)" }
    if (Get-ScheduledTask -TaskName 'NexusAGY Browser Bridge' -ErrorAction SilentlyContinue) {
        throw 'Ancienne tâche « NexusAGY Browser Bridge » encore là (mêmes ports) : relancer install.ps1'
    }
    & (Join-Path $PSScriptRoot 'scripts\installer-hote-natif.ps1') -CheckOnly
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
    Write-Host 'NexusBrowser : OK sur ce PC.'
    exit 0
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
