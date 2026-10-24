# Installe NexusBrowser sur ce PC (à relancer sans risque après une mise à jour synchronisée par OneDrive).
#  - environnement Python HORS OneDrive : ~\.nexus\nexus-browser\venv (jeton, journaux, captures et exports à côté)
#  - hôte natif com.nexus.browser_auth déclaré à Chrome (HKCU) ; tâche « Nexus Browser Bridge » sans déclencheur
#    (le pont démarre à la demande : premier appel d'un agent, schtasks /Run)
#  - serveur MCP « nexus-browser » inscrit pour Antigravity avec son nom d'agent (Codex et Claude : par leurs plugins)
#    (groupe d'onglets à son nom) ; inscriptions remplacées en place, rien d'autre n'est touché. Antigravity : par son
#    plugin SEULEMENT (une entrée en plus dans mcp_config.json lançait un second serveur, outils en double)
#  - compétence nexus-browser : dans le plugin pour Antigravity (ancienne copie globale retirée) ; Codex la reçoit par
#    son plugin perso (NexusCodex) ; Claude Code reçoit serveur et compétence
#    par le plugin nexus-browser du catalogue « nexus » (NexusClaude)
#  - migration depuis NexusAGY (pont d'avant le 17/10/2026) : ancienne tâche, ancien hôte natif (clé et fichiers),
#    ancien jeton ~\.nexusagy\bridge-token et anciennes inscriptions retirés, chaque retrait journalisé dans
#    ~\.nexus\nexus-browser\install.log ; l'ancienne extension « Antigravity Browser Bridge » est à retirer de Chrome
#  - tests hors ligne ; -SkipTests pour les sauter
# Usage : pwsh -NoProfile -File install.ps1 [-SkipTests] [-SkipLaunch]
param([switch]$SkipTests, [switch]$SkipLaunch)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\runtime.ps1')
$utf8 = [Text.UTF8Encoding]::new($false)
New-Item -ItemType Directory -Force $localRoot | Out-Null

$journal = Join-Path $localRoot 'install.log'
function Write-Journal([string]$Text) {
    Write-Host $Text
    Add-Content -LiteralPath $journal -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Text) -Encoding utf8NoBOM
}

$uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
if (-not $uv) { throw "uv introuvable : l'installer (https://docs.astral.sh/uv/) puis relancer." }

function Stop-BridgeTask([string]$Name) {
    $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if (-not $task -or $task.State -ne 'Running') { return }
    Stop-ScheduledTask -TaskName $Name
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-ScheduledTask -TaskName $Name).State -eq 'Running' -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 100
    }
    if ((Get-ScheduledTask -TaskName $Name).State -eq 'Running') { throw "Le pont « $Name » ne s'est pas arrêté." }
}

# Les deux ponts (ancien et nouveau) écoutent les mêmes ports 9224/9225 : arrêtés avant tout.
if (-not $SkipLaunch -and (Test-Path -LiteralPath $pythonExe)) {
    & $pythonExe -B (Join-Path $PSScriptRoot 'scripts\refresh_extension.py') --check-only
    if ($LASTEXITCODE -eq 3) { throw 'Actualisation différée : des onglets sont pilotés par un agent. Aucun pont arrêté.' }
    if ($LASTEXITCODE -eq 2 -and (Get-Process -Name chrome -ErrorAction SilentlyContinue) -and
        (Get-ScheduledTask -TaskName $bridgeTaskName -ErrorAction SilentlyContinue).State -ne 'Running') {
        # Pont à la demande pas encore démarré : le lancer pour que l'extension réponde, puis revérifier.
        schtasks /Run /TN $bridgeTaskName | Out-Null
        Start-Sleep -Seconds 5
        & $pythonExe -B (Join-Path $PSScriptRoot 'scripts\refresh_extension.py') --check-only
        if ($LASTEXITCODE -eq 3) { throw 'Actualisation différée : des onglets sont pilotés par un agent. Aucun pont arrêté.' }
    }
    if ($LASTEXITCODE -eq 2 -and (Get-Process -Name chrome -ErrorAction SilentlyContinue)) {
        throw 'Chrome est ouvert mais son pont ne répond pas : aucune session arrêtée.'
    }
}
Stop-BridgeTask 'NexusAGY Browser Bridge'
Stop-BridgeTask $bridgeTaskName

# Python système de préférence : celui de uv sous %AppData% est virtualisé par l'application Claude.
$systemPython = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python314\python.exe'
if (-not (Test-Path $pythonExe)) {
    if (Test-Path $systemPython) { & $uv venv --python $systemPython $venv } else { & $uv venv --python 3.14 $venv }
    if ($LASTEXITCODE) { throw 'Création de l''environnement Python en échec.' }
}
& $uv sync --frozen --all-groups --project $PSScriptRoot
if ($LASTEXITCODE) { throw 'uv sync a échoué.' }

& (Join-Path $PSScriptRoot 'scripts\installer-hote-natif.ps1')

# --- Tâche du pont : aucun déclencheur, lancée à la demande (bridge_client.ensure_bridge_running).
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$bridgeScript = Join-Path $repositoryRoot 'native-host\bridge_server.py'
$arguments = "-B `"$bridgeScript`" --token-file `"$tokenFile`" --log-file `"$(Join-Path $localRoot 'bridge.log')`""
$action = New-ScheduledTaskAction -Execute $pythonwExe -Argument $arguments -WorkingDirectory $localRoot
$settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
# Register -Force garde les déclencheurs d'une tâche existante : recréée de zéro.
if (Get-ScheduledTask -TaskName $bridgeTaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $bridgeTaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $bridgeTaskName -Action $action -Principal $principal -Settings $settings `
    -Description 'Pont Chrome NexusBrowser (Antigravity, Claude, Codex), lancé à la demande (aucun déclencheur).' | Out-Null
Write-Host "Tâche « $bridgeTaskName » installée."

# --- Migration depuis NexusAGY : son pont, son hôte natif et son jeton ne servent plus.
if (Get-ScheduledTask -TaskName 'NexusAGY Browser Bridge' -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName 'NexusAGY Browser Bridge' -Confirm:$false
    Write-Host 'Ancienne tâche « NexusAGY Browser Bridge » retirée.'
}
$oldHostKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.nexusagy.bridge_auth'
if (Test-Path $oldHostKey) {
    Remove-Item $oldHostKey -Recurse -Force
    Write-Journal 'Ancien hôte natif com.nexusagy.bridge_auth retiré de Chrome (clé HKCU).'
}
# Fichiers précis de l'ancien pont (jamais un motif) : son jeton et son hôte natif. Le reste de ~\.nexusagy appartient
# encore au Computer Use de NexusAGY et n'est pas touché.
$oldRoot = Join-Path $HOME '.nexusagy'
foreach ($old in @(
        (Join-Path $oldRoot 'bridge-token'),
        (Join-Path $oldRoot 'native-host\com.nexusagy.bridge_auth.json'),
        (Join-Path $oldRoot 'native-host\nexusagy_bridge_auth.cmd'))) {
    if (Test-Path -LiteralPath $old -PathType Leaf) {
        Remove-Item -LiteralPath $old -Force
        Write-Journal "Ancien fichier du pont NexusAGY retiré : $old"
    }
}
$oldHostDirectory = Join-Path $oldRoot 'native-host'
if ((Test-Path -LiteralPath $oldHostDirectory -PathType Container) -and -not (Get-ChildItem -LiteralPath $oldHostDirectory -Force)) {
    Remove-Item -LiteralPath $oldHostDirectory
    Write-Journal "Ancien dossier vide de l'hôte natif retiré : $oldHostDirectory"
}

# --- Démon partagé : un seul serveur nexus-browser pour toutes les sessions de Claude, Codex et Antigravity, déclaré
#     au superviseur des démons Nexus (NexusInfra\ops\workstation\nexus-mcp-daemons.py, tâche « Nexus MCP Daemons »).
#     Chaque client le joint par URL avec son agent (?agent=…) et le jeton de NexusSecure ; chaque session MCP a sa
#     propre identité (ses onglets).
$server = Join-Path $repositoryRoot 'client\mcp_server.py'
$args_ = @('-B', $server)
$port = 16182
$tokenFile = Join-Path $env:OneDrive 'Documents\NexusSecure\agents\nexus-mcp-token.txt'
# Jeton commun aux deux PC : créé une seule fois par Sync-NexusPoste (étape « Démons MCP partagés »), jamais ici. Un
# installeur lancé sur un PC neuf avant que OneDrive ait descendu le coffre en créait un autre, qui cassait l'autre PC.
if (-not (Test-Path $tokenFile)) { throw "Jeton absent ($tokenFile) : attendre la synchro OneDrive du coffre, puis lancer Sync-NexusPoste.ps1 -Apply." }
$token = (Get-Content $tokenFile -Raw).Trim()
function Get-Url([string]$Agent) { "http://127.0.0.1:$port/mcp?agent=$($Agent.ToLower())" }
$spec = [ordered]@{ port = $port; python = $pythonExe; args = $args_; env = [ordered]@{ PYTHONUTF8 = '1'; PYTHONDONTWRITEBYTECODE = '1' } }
$specs = Join-Path $HOME '.nexus\daemons\specs'
New-Item -ItemType Directory -Force $specs | Out-Null
[IO.File]::WriteAllText((Join-Path $specs 'nexus-browser.json'), ($spec | ConvertTo-Json -Depth 5), $utf8)
# Nouveau code : arrêter le démon en place, le superviseur le relance (les clients se reconnectent seuls).
Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" | Where-Object { $_.CommandLine -match 'mcp_server\.py"? --http' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
if (-not (Get-ScheduledTask -TaskName 'Nexus MCP Daemons' -ErrorAction SilentlyContinue)) {
    Write-Warning 'Superviseur des démons absent : lancer NexusInfra\ops\workstation\Sync-NexusPoste.ps1 -Apply.'
}

# Claude Code : serveur MCP et compétence par le plugin nexus-browser du catalogue « nexus » (NexusClaude\plugins,
# activé par NexusClaude\claude-settings.json ; jeton dans la variable NEXUS_MCP_TOKEN des réglages, posée par
# Sync-NexusPoste). Aucune inscription ici (aucune CLI Claude).

# --- Codex : serveur et compétence par le plugin perso nexus-browser de Codex (NexusCodex\scripts\installer-plugins-nexus.ps1,
#     lancé par Sync-NexusPoste) ; plus de table [mcp_servers] ici.

# Antigravity : ~\.gemini\config (mcp_config.json, plugin nexus-browser et sa compétence). La synchronisation de
# NexusAGY fusionne sans retirer ce serveur ni ce plugin.
$agyRoot = Join-Path $HOME '.gemini\config'
$agyConfig = Join-Path $agyRoot 'mcp_config.json'
if (Test-Path $agyConfig) {
    $entry = [PSCustomObject]@{ serverUrl = (Get-Url 'Antigravity'); headers = [PSCustomObject]@{ Authorization = "Bearer $token" } }
    $plugin = Join-Path $agyRoot 'plugins\nexus-browser'
    foreach ($file in Get-ChildItem (Join-Path $PSScriptRoot 'plugins\nexus-browser') -File -Recurse) {
        if ($file.Name -eq 'mcp_config.json') { continue }
        $target = Join-Path $plugin $file.FullName.Substring((Join-Path $PSScriptRoot 'plugins\nexus-browser').Length + 1)
        New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
        Copy-Item $file.FullName $target -Force
    }
    # Compétence : source unique skills\nexus-browser (lue aussi par les plugins de Claude et de Codex).
    $pluginSkill = Join-Path $plugin 'skills\nexus-browser'
    New-Item -ItemType Directory -Force $pluginSkill | Out-Null
    Copy-Item (Join-Path $PSScriptRoot 'skills\nexus-browser\SKILL.md') (Join-Path $pluginSkill 'SKILL.md') -Force
    $pluginMcp = [PSCustomObject]@{ mcpServers = [PSCustomObject]@{ 'nexus-browser' = $entry } }
    [IO.File]::WriteAllText((Join-Path $plugin 'mcp_config.json'), ($pluginMcp | ConvertTo-Json -Depth 100), $utf8)
    # Compétence : seulement dans le plugin. Une ancienne copie globale (skills\nexus-browser) la doublait dans
    # Antigravity : retirée, sauvegarde hors OneDrive.
    $oldSkill = Join-Path $agyRoot 'skills\nexus-browser'
    if (Test-Path $oldSkill) {
        $saved = Join-Path $localRoot "backups\agy-skill-nexus-browser-$(Get-Date -Format yyyyMMdd-HHmmss)"
        New-Item -ItemType Directory -Force (Split-Path $saved) | Out-Null
        Move-Item $oldSkill $saved
        Write-Journal "Antigravity : copie globale du skill nexus-browser retirée (doublon du plugin), sauvegarde $saved"
    }
    # Plugin activé dans config.json, seulement Antigravity fermé (sinon il réécrirait l'ancien fichier en quittant).
    $agyApp = Join-Path $agyRoot 'config.json'
    if ((Test-Path $agyApp) -and -not (Get-Process -Name Antigravity -ErrorAction SilentlyContinue)) {
        $app = Get-Content $agyApp -Raw | ConvertFrom-Json
        if (-not $app.PSObject.Properties['plugins']) { $app | Add-Member plugins ([PSCustomObject]@{}) }
        if ($app.plugins.'nexus-browser'.enabled -ne $true) {
            $app.plugins | Add-Member -NotePropertyName 'nexus-browser' -NotePropertyValue ([PSCustomObject]@{ enabled = $true }) -Force
            [IO.File]::WriteAllText($agyApp, ($app | ConvertTo-Json -Depth 100), $utf8)
        }
    }
    # Une seule déclaration : le plugin. L'entrée globale de mcp_config.json (versions d'avant la 2.7.0) est retirée
    # dès que le plugin est activé (sinon Antigravity perdrait nexus-browser) ; sauvegarde hors OneDrive, autres
    # serveurs intacts, écriture atomique.
    $pluginOn = (Test-Path $agyApp) -and ((Get-Content $agyApp -Raw | ConvertFrom-Json).plugins.'nexus-browser'.enabled -eq $true)
    if ($pluginOn) {
        & (Join-Path $PSScriptRoot 'scripts\doublon-antigravity.ps1') -ConfigPath $agyConfig -BackupDir (Join-Path $localRoot 'backups') |
            ForEach-Object { Write-Journal $_ }
        if ($LASTEXITCODE) { throw 'Retrait du doublon nexus-browser de mcp_config.json (Antigravity) en échec.' }
    } else {
        Write-Warning 'Antigravity ouvert et plugin nexus-browser pas encore activé : entrée globale gardée (relancer install.ps1 Antigravity fermé).'
    }
    Write-Host 'Antigravity : nexus-browser inscrit (plugin seulement).'
} else { Write-Warning 'Antigravity absent de ce PC : non inscrit.' }


if (-not $SkipTests) {
    & (Join-Path $PSScriptRoot 'test.ps1')
    if ($LASTEXITCODE) { throw 'test.ps1 en échec.' }
}
if (-not $SkipLaunch) {
    Start-ScheduledTask -TaskName $bridgeTaskName
    & $pythonExe -B (Join-Path $PSScriptRoot 'scripts\refresh_extension.py') --wait-ready 30
    if ($LASTEXITCODE -notin 0, 2) { throw "Le rechargement de l'extension n'est pas vérifié ; installation non marquée à jour." }
    if ($LASTEXITCODE -eq 2 -and (Get-Process -Name chrome -ErrorAction SilentlyContinue)) { throw 'Extension Chrome ouverte mais injoignable.' }
    # Le démon HTTP conserve ses modules Python en mémoire. Recharger uniquement celui de Browser,
    # après le contrôle d'absence d'onglets pilotés ; son superviseur reprend le même port.
    $listener = Get-NetTCPConnection -LocalPort 16182 -State Listen -ErrorAction SilentlyContinue
    if ($listener) {
        $daemonPid = $listener.OwningProcess | Select-Object -Unique
        $daemon = Get-CimInstance Win32_Process -Filter "ProcessId = $daemonPid"
        $entryPoint = Join-Path $PSScriptRoot 'client\mcp_server.py'
        $supervisor = Get-ScheduledTask -TaskName 'Nexus MCP Daemons' -ErrorAction SilentlyContinue
        if ($daemon.CommandLine -notlike "*$entryPoint --http 16182*" -or $supervisor.State -ne 'Running') {
            throw 'Le port MCP Browser ne correspond pas au démon supervisé attendu.'
        }
        Stop-Process -Id $daemonPid -ErrorAction Stop
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        do {
            Start-Sleep -Milliseconds 250
            $next = Get-NetTCPConnection -LocalPort 16182 -State Listen -ErrorAction SilentlyContinue
        } while ((-not $next -or $next.OwningProcess -eq $daemonPid) -and [DateTime]::UtcNow -lt $deadline)
        if (-not $next -or $next.OwningProcess -eq $daemonPid) { throw "Le démon MCP Browser n'a pas confirmé sa relance." }
        $replacement = Get-CimInstance Win32_Process -Filter "ProcessId = $($next.OwningProcess)"
        if ($replacement.CommandLine -notlike "*$entryPoint --http 16182*") { throw 'Le nouveau listener ne correspond pas au démon Browser attendu.' }
        Write-Host 'Démon MCP Browser rechargé ; Android et Relay conservés.'
    }
}
Write-Host 'NexusBrowser installé. Extension vérifiée si Chrome est connecté ; sources prises en compte au prochain lancement sinon.'
