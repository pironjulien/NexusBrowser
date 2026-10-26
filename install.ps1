# Installe NexusBrowser sur ce PC (a relancer sans risque apres une mise a jour synchronisee par OneDrive).
#  - environnement Python HORS OneDrive : ~\.nexus\nexus-browser\venv (jeton, journaux, captures et exports a cote)
#  - hote natif com.nexus.browser_auth declare a Chrome (HKCU) ; tache "Nexus Browser Bridge" sans declencheur
#    (le pont demarre a la demande : premier appel d'un agent, schtasks /Run)
#  - serveur MCP "nexus-browser" inscrit pour Antigravity avec son nom d'agent (Codex et Claude : par leurs plugins)
#    (groupe d'onglets a son nom) ; inscriptions remplacees en place, rien d'autre n'est touche. Antigravity : par son
#    plugin SEULEMENT (une entree en plus dans mcp_config.json lancait un second serveur, outils en double)
#  - competence nexus-browser : dans le plugin pour Antigravity (ancienne copie globale retiree) ; Codex la recoit par
#    son plugin perso (NexusCodex) ; Claude Code recoit serveur et competence
#    par le plugin nexus-browser du catalogue "nexus" (NexusClaude)
#  - migration depuis NexusAGY (pont d'avant le 17/10/2026) : ancienne tache, ancien hote natif (cle et fichiers),
#    ancien jeton ~\.nexusagy\bridge-token et anciennes inscriptions retires, chaque retrait journalise dans
#    ~\.nexus\nexus-browser\install.log ; l'ancienne extension "Antigravity Browser Bridge" est a retirer de Chrome
#  - tests hors ligne ; -SkipTests pour les sauter
#  - -Register (installation publique, get.ps1) : serveur declare aux clients trouves (Claude Code, Claude Desktop,
#    Codex, Antigravity) par scripts\register_clients.py, puis guide du chargement de l'extension dans Chrome
#  - NEXUS_PACK=1 (pack Nexus, get-nexus.ps1) : aucune question, aucune attente, aucune fenetre (ni Chrome, ni guide,
#    ni presse-papiers) ; le pack appelle lui-meme scripts\guide-extension.ps1 -WaitSeconds 0 a la fin
# Tourne sous Windows PowerShell 5.1 comme sous pwsh 7 (fichier en ASCII : 5.1 lit un .ps1 sans BOM en page ANSI).
# Usage : pwsh -NoProfile -File install.ps1 [-SkipTests] [-SkipLaunch] [-Register]
param([switch]$SkipTests, [switch]$SkipLaunch, [switch]$Register)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\runtime.ps1')
$utf8 = [Text.UTF8Encoding]::new($false)
New-Item -ItemType Directory -Force $localRoot | Out-Null

$journal = Join-Path $localRoot 'install.log'
function Write-Journal([string]$Text) {
    Write-Host $Text
    [IO.File]::AppendAllText($journal, (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Text + [Environment]::NewLine, $utf8)
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
    if ((Get-ScheduledTask -TaskName $Name).State -eq 'Running') { throw "Le pont '$Name' ne s'est pas arrete." }
}

# Les deux ponts (ancien et nouveau) ecoutent les memes ports 9224/9225 : arretes avant tout. Des onglets pilotes par
# un agent : code de sortie 3, rien n'est touche (get.ps1 remet alors le dossier precedent en place).
if (-not $SkipLaunch -and (Test-Path -LiteralPath $pythonExe)) {
    & $pythonExe -B (Join-Path $PSScriptRoot 'scripts\refresh_extension.py') --check-only
    if ($LASTEXITCODE -eq 3) { Write-Warning 'Actualisation differee : des onglets sont pilotes par un agent. Aucun pont arrete.'; exit 3 }
    if ($LASTEXITCODE -eq 2 -and (Get-Process -Name chrome -ErrorAction SilentlyContinue) -and
        (Get-ScheduledTask -TaskName $bridgeTaskName -ErrorAction SilentlyContinue).State -ne 'Running') {
        # Pont a la demande pas encore demarre : le lancer pour que l'extension reponde, puis reverifier.
        schtasks /Run /TN $bridgeTaskName | Out-Null
        Start-Sleep -Seconds 5
        & $pythonExe -B (Join-Path $PSScriptRoot 'scripts\refresh_extension.py') --check-only
        if ($LASTEXITCODE -eq 3) { Write-Warning 'Actualisation differee : des onglets sont pilotes par un agent. Aucun pont arrete.'; exit 3 }
    }
    # -Register : a la premiere installation, l'extension n'est souvent pas encore chargee dans Chrome.
    if ($LASTEXITCODE -eq 2 -and -not $Register -and (Get-Process -Name chrome -ErrorAction SilentlyContinue)) {
        throw 'Chrome est ouvert mais son pont ne repond pas : aucune session arretee.'
    }
}
Stop-BridgeTask 'NexusAGY Browser Bridge'
Stop-BridgeTask $bridgeTaskName

# Python systeme de preference : celui de uv sous %AppData% est virtualise par l'application Claude.
$systemPython = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python314\python.exe'
if (-not (Test-Path $pythonExe)) {
    if (Test-Path $systemPython) { & $uv venv --python $systemPython $venv } else { & $uv venv --python 3.14 $venv }
    if ($LASTEXITCODE) { throw 'Creation de l''environnement Python en echec.' }
}
& $uv sync --frozen --all-groups --project $PSScriptRoot
if ($LASTEXITCODE) { throw 'uv sync a echoue.' }

& (Join-Path $PSScriptRoot 'scripts\installer-hote-natif.ps1')

# --- Tache du pont : aucun declencheur, lancee a la demande (bridge_client.ensure_bridge_running).
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$bridgeScript = Join-Path $repositoryRoot 'native-host\bridge_server.py'
$arguments = "-B `"$bridgeScript`" --token-file `"$tokenFile`" --log-file `"$(Join-Path $localRoot 'bridge.log')`""
$action = New-ScheduledTaskAction -Execute $pythonwExe -Argument $arguments -WorkingDirectory $localRoot
$settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
# Register -Force garde les declencheurs d'une tache existante : recreee de zero.
if (Get-ScheduledTask -TaskName $bridgeTaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $bridgeTaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $bridgeTaskName -Action $action -Principal $principal -Settings $settings `
    -Description 'Pont Chrome NexusBrowser (Antigravity, Claude, Codex), lance a la demande (aucun declencheur).' | Out-Null
Write-Host "Tache '$bridgeTaskName' installee."

# --- Tache de mise a jour (contrat des produits Nexus) : installation publique seulement (get.ps1, dossier
#     %LOCALAPPDATA%\NexusBrowser\app). Sans declencheur : le pont la lance sur POST /api/update
#     (native-host\bridge_update.py), elle execute scripts\self-update.ps1 sans fenetre. Un clone se met a jour par git.
$updateTaskName = 'Nexus Browser Update'
$publicApp = Join-Path $env:LOCALAPPDATA 'NexusBrowser\app'
if ((Test-Path -LiteralPath $publicApp) -and ((Resolve-Path -LiteralPath $repositoryRoot).Path -eq (Resolve-Path -LiteralPath $publicApp).Path)) {
    $updateAction = New-ScheduledTaskAction -Execute $pythonwExe -Argument "-B `"$(Join-Path $repositoryRoot 'scripts\self_update.py')`"" -WorkingDirectory $localRoot
    $updateSettings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
    if (Get-ScheduledTask -TaskName $updateTaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $updateTaskName -Confirm:$false
    }
    Register-ScheduledTask -TaskName $updateTaskName -Action $updateAction -Principal $principal -Settings $updateSettings `
        -Description 'Mise a jour de NexusBrowser, lancee par son pont (POST /api/update), aucun declencheur.' | Out-Null
    Write-Host "Tache '$updateTaskName' installee."
}

# --- Migration depuis NexusAGY : son pont, son hote natif et son jeton ne servent plus.
if (Get-ScheduledTask -TaskName 'NexusAGY Browser Bridge' -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName 'NexusAGY Browser Bridge' -Confirm:$false
    Write-Host 'Ancienne tache "NexusAGY Browser Bridge" retiree.'
}
$oldHostKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.nexusagy.bridge_auth'
if (Test-Path $oldHostKey) {
    Remove-Item $oldHostKey -Recurse -Force
    Write-Journal 'Ancien hote natif com.nexusagy.bridge_auth retire de Chrome (cle HKCU).'
}
# Fichiers precis de l'ancien pont (jamais un motif) : son jeton et son hote natif. Le reste de ~\.nexusagy appartient
# encore au Computer Use de NexusAGY et n'est pas touche.
$oldRoot = Join-Path $HOME '.nexusagy'
foreach ($old in @(
        (Join-Path $oldRoot 'bridge-token'),
        (Join-Path $oldRoot 'native-host\com.nexusagy.bridge_auth.json'),
        (Join-Path $oldRoot 'native-host\nexusagy_bridge_auth.cmd'))) {
    if (Test-Path -LiteralPath $old -PathType Leaf) {
        Remove-Item -LiteralPath $old -Force
        Write-Journal "Ancien fichier du pont NexusAGY retire : $old"
    }
}
$oldHostDirectory = Join-Path $oldRoot 'native-host'
if ((Test-Path -LiteralPath $oldHostDirectory -PathType Container) -and -not (Get-ChildItem -LiteralPath $oldHostDirectory -Force)) {
    Remove-Item -LiteralPath $oldHostDirectory
    Write-Journal "Ancien dossier vide de l'hote natif retire : $oldHostDirectory"
}

# --- Demon partage : un seul serveur nexus-browser pour toutes les sessions de Claude, Codex et Antigravity, declare
#     au superviseur des demons Nexus (NexusInfra\ops\workstation\nexus-mcp-daemons.py, tache "Nexus MCP Daemons").
#     Chaque client le joint par URL avec son agent (?agent=...) et le jeton de NexusSecure ; chaque session MCP a sa
#     propre identite (ses onglets).
$server = Join-Path $repositoryRoot 'client\mcp_server.py'
$args_ = @('-B', $server)
$port = 16182
# Jeton commun aux deux PC : cree une seule fois par Sync-NexusPoste (etape "Demons MCP partages"), jamais ici. Un
# installeur lance sur un PC neuf avant que OneDrive ait descendu le coffre en creait un autre, qui cassait l'autre PC.
# Sans ce jeton (autre poste, coffre pas encore synchronise) : demon partage et inscription d'Antigravity sautes avec
# un avertissement ; le pont, l'hote natif et la tache restent installes. ($tokenFile, de runtime.ps1, est le jeton du
# pont : nom distinct.)
$mcpTokenFile = if ($env:OneDrive) { Join-Path $env:OneDrive 'Documents\NexusSecure\agents\nexus-mcp-token.txt' }
$token = $null
if ($mcpTokenFile -and (Test-Path -LiteralPath $mcpTokenFile)) { $token = (Get-Content -LiteralPath $mcpTokenFile -Raw).Trim() }
function Get-Url([string]$Agent) { "http://127.0.0.1:$port/mcp?agent=$($Agent.ToLower())" }
if ($token) {
    $spec = [ordered]@{ port = $port; python = $pythonExe; args = $args_; env = [ordered]@{ PYTHONUTF8 = '1'; PYTHONDONTWRITEBYTECODE = '1' } }
    $specs = Join-Path $HOME '.nexus\daemons\specs'
    New-Item -ItemType Directory -Force $specs | Out-Null
    [IO.File]::WriteAllText((Join-Path $specs 'nexus-browser.json'), ($spec | ConvertTo-Json -Depth 5), $utf8)
    # Nouveau code : le demon en place est recharge une seule fois, en fin d'installation (sans -SkipLaunch), apres le
    # controle des onglets pilotes ; son superviseur le relance et les clients se reconnectent seuls.
    if (-not (Get-ScheduledTask -TaskName 'Nexus MCP Daemons' -ErrorAction SilentlyContinue)) {
        Write-Warning 'Superviseur des demons absent : lancer NexusInfra\ops\workstation\Sync-NexusPoste.ps1 -Apply.'
    }
} else {
    $where = if ($mcpTokenFile) { $mcpTokenFile } else { 'OneDrive non configure' }
    # Installation publique (-Register) : rien de partage a attendre, le serveur est declare en stdio plus bas.
    if (-not $Register) { Write-Warning "Jeton MCP partage absent ($where) : demon partage et inscription d'Antigravity sautes. Poste Nexus : attendre la synchro OneDrive du coffre, lancer Sync-NexusPoste.ps1 -Apply, puis relancer install.ps1." }
}

# Claude Code : serveur MCP et competence par le plugin nexus-browser du catalogue "nexus" (NexusClaude\plugins,
# active par NexusClaude\claude-settings.json ; jeton dans la variable NEXUS_MCP_TOKEN des reglages, posee par
# Sync-NexusPoste). Aucune inscription ici (aucune CLI Claude).

# --- Codex : serveur et competence par le plugin perso nexus-browser de Codex (NexusCodex\scripts\installer-plugins-nexus.ps1,
#     lance par Sync-NexusPoste) ; plus de table [mcp_servers] ici.

# Antigravity : ~\.gemini\config (mcp_config.json, plugin nexus-browser et sa competence). La synchronisation de
# NexusAGY fusionne sans retirer ce serveur ni ce plugin.
$agyRoot = Join-Path $HOME '.gemini\config'
$agyConfig = Join-Path $agyRoot 'mcp_config.json'
if ($token -and (Test-Path $agyConfig)) {
    $entry = [PSCustomObject]@{ serverUrl = (Get-Url 'Antigravity'); headers = [PSCustomObject]@{ Authorization = "Bearer $token" } }
    $plugin = Join-Path $agyRoot 'plugins\nexus-browser'
    foreach ($file in Get-ChildItem (Join-Path $PSScriptRoot 'plugins\nexus-browser') -File -Recurse) {
        if ($file.Name -eq 'mcp_config.json') { continue }
        $target = Join-Path $plugin $file.FullName.Substring((Join-Path $PSScriptRoot 'plugins\nexus-browser').Length + 1)
        New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
        Copy-Item $file.FullName $target -Force
    }
    # Competence : la version personnelle du poste (perso\nexus-browser, depot prive, lue aussi par les plugins de
    # Claude et de Codex) si elle existe, sinon la publique (skills\nexus-browser\SKILL.md).
    $pluginSkill = Join-Path $plugin 'skills\nexus-browser'
    New-Item -ItemType Directory -Force $pluginSkill | Out-Null
    $skill = Join-Path $PSScriptRoot 'perso\nexus-browser\SKILL.md'
    if (-not (Test-Path -LiteralPath $skill)) { $skill = Join-Path $PSScriptRoot 'skills\nexus-browser\SKILL.md' }
    Copy-Item $skill (Join-Path $pluginSkill 'SKILL.md') -Force
    $pluginMcp = [PSCustomObject]@{ mcpServers = [PSCustomObject]@{ 'nexus-browser' = $entry } }
    [IO.File]::WriteAllText((Join-Path $plugin 'mcp_config.json'), ($pluginMcp | ConvertTo-Json -Depth 100), $utf8)
    # Competence : seulement dans le plugin. Une ancienne copie globale (skills\nexus-browser) la doublait dans
    # Antigravity : retiree, sauvegarde hors OneDrive.
    $oldSkill = Join-Path $agyRoot 'skills\nexus-browser'
    if (Test-Path $oldSkill) {
        $saved = Join-Path $localRoot "backups\agy-skill-nexus-browser-$(Get-Date -Format yyyyMMdd-HHmmss)"
        New-Item -ItemType Directory -Force (Split-Path $saved) | Out-Null
        Move-Item $oldSkill $saved
        Write-Journal "Antigravity : copie globale du skill nexus-browser retiree (doublon du plugin), sauvegarde $saved"
    }
    # Plugin active dans config.json, seulement Antigravity ferme (sinon il reecrirait l'ancien fichier en quittant).
    $agyApp = Join-Path $agyRoot 'config.json'
    if ((Test-Path $agyApp) -and -not (Get-Process -Name Antigravity -ErrorAction SilentlyContinue)) {
        $app = Get-Content $agyApp -Raw | ConvertFrom-Json
        if (-not $app.PSObject.Properties['plugins']) { $app | Add-Member plugins ([PSCustomObject]@{}) }
        if ($app.plugins.'nexus-browser'.enabled -ne $true) {
            $app.plugins | Add-Member -NotePropertyName 'nexus-browser' -NotePropertyValue ([PSCustomObject]@{ enabled = $true }) -Force
            [IO.File]::WriteAllText($agyApp, ($app | ConvertTo-Json -Depth 100), $utf8)
        }
    }
    # Une seule declaration : le plugin. L'entree globale de mcp_config.json (versions d'avant la 2.7.0) est retiree
    # des que le plugin est active (sinon Antigravity perdrait nexus-browser) ; sauvegarde hors OneDrive, autres
    # serveurs intacts, ecriture atomique.
    $pluginOn = (Test-Path $agyApp) -and ((Get-Content $agyApp -Raw | ConvertFrom-Json).plugins.'nexus-browser'.enabled -eq $true)
    if ($pluginOn) {
        & (Join-Path $PSScriptRoot 'scripts\doublon-antigravity.ps1') -ConfigPath $agyConfig -BackupDir (Join-Path $localRoot 'backups') |
            ForEach-Object { Write-Journal $_ }
        if ($LASTEXITCODE) { throw 'Retrait du doublon nexus-browser de mcp_config.json (Antigravity) en echec.' }
    } else {
        Write-Warning 'Antigravity ouvert et plugin nexus-browser pas encore active : entree globale gardee (relancer install.ps1 Antigravity ferme).'
    }
    Write-Host 'Antigravity : nexus-browser inscrit (plugin seulement).'
} elseif ($Register) { }  # Antigravity : declare en stdio par register_clients.py
elseif (-not $token) { Write-Warning 'Antigravity : non inscrit (jeton MCP partage absent).' }
else { Write-Warning 'Antigravity absent de ce PC : non inscrit.' }

if ($Register) {
    & $pythonExe -B (Join-Path $PSScriptRoot 'scripts\register_clients.py') --python $pythonExe `
        --server (Join-Path $repositoryRoot 'client\mcp_server.py') --backups (Join-Path $localRoot 'backups')
    if ($LASTEXITCODE) { throw 'Inscription du serveur aupres des clients en echec (voir ci-dessus).' }
}


if (-not $SkipTests) {
    & (Join-Path $PSScriptRoot 'test.ps1')
    if ($LASTEXITCODE) { throw 'test.ps1 en echec.' }
}
if (-not $SkipLaunch) {
    Start-ScheduledTask -TaskName $bridgeTaskName
    $pack = $env:NEXUS_PACK -eq '1'
    $wait = if ($pack) { 0 } else { 30 }
    & $pythonExe -B (Join-Path $PSScriptRoot 'scripts\refresh_extension.py') --wait-ready $wait
    if ($LASTEXITCODE -notin 0, 2) { throw "Le rechargement de l'extension n'est pas verifie ; installation non marquee a jour." }
    if ($LASTEXITCODE -eq 2 -and $Register) {
        if (-not $pack) { & (Join-Path $PSScriptRoot 'scripts\guide-extension.ps1') }
    } elseif ($LASTEXITCODE -eq 2 -and (Get-Process -Name chrome -ErrorAction SilentlyContinue)) {
        throw 'Extension Chrome ouverte mais injoignable.'
    }
    # Le demon HTTP conserve ses modules Python en memoire. Recharger uniquement celui de Browser,
    # apres le controle d'absence d'onglets pilotes ; son superviseur reprend le meme port.
    $listener = Get-NetTCPConnection -LocalPort 16182 -State Listen -ErrorAction SilentlyContinue
    if ($listener) {
        $daemonPid = $listener.OwningProcess | Select-Object -Unique
        $daemon = Get-CimInstance Win32_Process -Filter "ProcessId = $daemonPid"
        $entryPoint = Join-Path $PSScriptRoot 'client\mcp_server.py'
        $supervisor = Get-ScheduledTask -TaskName 'Nexus MCP Daemons' -ErrorAction SilentlyContinue
        if ($daemon.CommandLine -notlike "*$entryPoint --http 16182*" -or $supervisor.State -ne 'Running') {
            throw 'Le port MCP Browser ne correspond pas au demon supervise attendu.'
        }
        Stop-Process -Id $daemonPid -ErrorAction Stop
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        do {
            Start-Sleep -Milliseconds 250
            $next = Get-NetTCPConnection -LocalPort 16182 -State Listen -ErrorAction SilentlyContinue
        } while ((-not $next -or $next.OwningProcess -eq $daemonPid) -and [DateTime]::UtcNow -lt $deadline)
        if (-not $next -or $next.OwningProcess -eq $daemonPid) { throw "Le demon MCP Browser n'a pas confirme sa relance." }
        $replacement = Get-CimInstance Win32_Process -Filter "ProcessId = $($next.OwningProcess)"
        if ($replacement.CommandLine -notlike "*$entryPoint --http 16182*") { throw 'Le nouveau listener ne correspond pas au demon Browser attendu.' }
        Write-Host 'Demon MCP Browser recharge ; Android et Relay conserves.'
    }
} elseif (Get-NetTCPConnection -LocalPort 16182 -State Listen -ErrorAction SilentlyContinue) {
    Write-Warning "-SkipLaunch : demon MCP Browser laisse en place ; le nouveau code sera pris a sa prochaine relance."
}
Write-Host 'NexusBrowser installe. Extension verifiee si Chrome est connecte ; sources prises en compte au prochain lancement sinon.'
