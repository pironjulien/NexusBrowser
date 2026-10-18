# Installe NexusBrowser sur ce PC (à relancer sans risque après une mise à jour synchronisée par OneDrive).
#  - environnement Python HORS OneDrive : ~\.nexus\nexus-browser\venv (jeton, journaux, captures et exports à côté)
#  - hôte natif com.nexus.browser_auth déclaré à Chrome (HKCU) ; tâche « Nexus Browser Bridge » sans déclencheur
#    (le pont démarre à la demande : premier appel d'un agent, schtasks /Run)
#  - serveur MCP « nexus-browser » inscrit pour Claude Code, Codex et Antigravity, chacun avec son nom d'agent
#    (groupe d'onglets à son nom) ; inscriptions remplacées en place, rien d'autre n'est touché. Antigravity : par son
#    plugin SEULEMENT (une entrée en plus dans mcp_config.json lançait un second serveur, outils en double)
#  - compétence nexus-browser copiée pour Antigravity, Claude Code (~\.claude\skills) et Codex (~\.codex\skills)
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

# --- Inscriptions MCP : même serveur pour les trois agents, nom d'agent propre à chacun.
$server = Join-Path $repositoryRoot 'client\mcp_server.py'
$args_ = @('-B', $server)
function Get-Env([string]$Agent) {
    [ordered]@{ PYTHONUTF8 = '1'; PYTHONDONTWRITEBYTECODE = '1'; NEXUS_BROWSER_AGENT = $Agent }
}

# Claude Code (portée utilisateur). Sans CLI dans le PATH : celle fournie par l'application Claude.
$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claude) {
    $bundles = @(Join-Path $env:APPDATA 'Claude\claude-code') +
        @(Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Packages') -Directory -Filter 'AnthropicPBC.Claude_*' -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName 'LocalCache\Roaming\Claude\claude-code' })
    $claude = $bundles | Where-Object { Test-Path $_ } |
        ForEach-Object { Get-ChildItem $_ -Recurse -Depth 2 -Filter claude.exe -File } |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if ($claude) {
    $env_ = Get-Env 'Claude'
    $previous = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & $claude mcp remove nexus-browser -s user *> $null
    $ErrorActionPreference = $previous
    $envArgs = foreach ($k in $env_.Keys) { '-e'; "$k=$($env_[$k])" }
    & $claude mcp add @envArgs --scope user --transport stdio nexus-browser '--' $pythonExe @args_ | Out-Null
    if ($LASTEXITCODE) { throw 'claude mcp add nexus-browser a échoué.' }
    Write-Host 'Claude Code : nexus-browser inscrit.'
} else { Write-Warning 'CLI claude introuvable : Claude Code non inscrit.' }

# Codex : table [mcp_servers.nexus-browser] de ~\.codex\config.toml, remplacée en place (sous-tables comprises).
$codexConfig = Join-Path $HOME '.codex\config.toml'
if (Test-Path $codexConfig) {
    $env_ = Get-Env 'Codex'
    $q = { param($s) "'" + $s + "'" }  # chaîne TOML littérale : antislashs Windows conservés
    $block = @('[mcp_servers.nexus-browser]', "command = $(& $q $pythonExe)",
        "args = [$(($args_ | ForEach-Object { & $q $_ }) -join ', ')]", 'startup_timeout_sec = 60',
        'tool_timeout_sec = 120', '', '[mcp_servers.nexus-browser.env]') +
        ($env_.Keys | ForEach-Object { "$_ = $(& $q $env_[$_])" })
    $lines = [Collections.Generic.List[string]](Get-Content $codexConfig)
    $start = $lines.FindIndex({ param($l) $l -match '^\s*\[mcp_servers\.nexus-browser\]\s*$' })
    if ($start -ge 0) {
        $end = $start + 1
        while ($end -lt $lines.Count -and ($lines[$end] -notmatch '^\s*\[' -or $lines[$end] -match '^\s*\[mcp_servers\.nexus-browser\.')) { $end++ }
        $lines.RemoveRange($start, $end - $start)
        $lines.InsertRange($start, [string[]]($block + ''))
    } else {
        if ($lines.Count -and $lines[$lines.Count - 1] -ne '') { $lines.Add('') }
        $lines.AddRange([string[]]$block)
    }
    $backup = Join-Path $localRoot ('backups\codex-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.toml')
    New-Item -ItemType Directory -Force (Split-Path $backup) | Out-Null
    Copy-Item $codexConfig $backup
    [IO.File]::WriteAllText($codexConfig, ($lines -join "`n") + "`n", $utf8)
    Write-Host 'Codex : nexus-browser inscrit.'
} else { Write-Warning 'Codex absent de ce PC : non inscrit.' }

# Antigravity : ~\.gemini\config (mcp_config.json, plugin nexus-browser et sa compétence). La synchronisation de
# NexusAGY fusionne sans retirer ce serveur ni ce plugin.
$agyRoot = Join-Path $HOME '.gemini\config'
$agyConfig = Join-Path $agyRoot 'mcp_config.json'
if (Test-Path $agyConfig) {
    $entry = [PSCustomObject]@{ command = $pythonExe; args = $args_; env = [PSCustomObject](Get-Env 'Antigravity') }
    $plugin = Join-Path $agyRoot 'plugins\nexus-browser'
    foreach ($file in Get-ChildItem (Join-Path $PSScriptRoot 'plugins\nexus-browser') -File -Recurse) {
        if ($file.Name -eq 'mcp_config.json') { continue }
        $target = Join-Path $plugin $file.FullName.Substring((Join-Path $PSScriptRoot 'plugins\nexus-browser').Length + 1)
        New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
        Copy-Item $file.FullName $target -Force
    }
    $pluginMcp = [PSCustomObject]@{ mcpServers = [PSCustomObject]@{ 'nexus-browser' = $entry } }
    [IO.File]::WriteAllText((Join-Path $plugin 'mcp_config.json'), ($pluginMcp | ConvertTo-Json -Depth 100), $utf8)
    $skill = Join-Path $agyRoot 'skills\nexus-browser'
    New-Item -ItemType Directory -Force $skill | Out-Null
    Copy-Item (Join-Path $PSScriptRoot 'skills\nexus-browser\SKILL.md') (Join-Path $skill 'SKILL.md') -Force
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

# Compétence nexus-browser aussi pour Claude Code et Codex (chargées depuis <agent>\skills\<nom>\SKILL.md).
foreach ($agentHome in @((Join-Path $HOME '.claude'), (Join-Path $HOME '.codex'))) {
    if (-not (Test-Path -LiteralPath $agentHome -PathType Container)) { continue }
    $skill = Join-Path $agentHome 'skills\nexus-browser'
    New-Item -ItemType Directory -Force $skill | Out-Null
    Copy-Item (Join-Path $PSScriptRoot 'skills\nexus-browser\SKILL.md') (Join-Path $skill 'SKILL.md') -Force
    Write-Host "Compétence nexus-browser copiée : $skill"
}

if (-not $SkipTests) {
    & (Join-Path $PSScriptRoot 'test.ps1')
    if ($LASTEXITCODE) { throw 'test.ps1 en échec.' }
}
if (-not $SkipLaunch) { Start-ScheduledTask -TaskName $bridgeTaskName }
# Empreinte de l'installation (scripts\empreinte.ps1, formule unique) : Sync-NexusPoste (NexusInfra) la compare aux
# sources pour savoir s'il faut réinstaller (uv.lock, install.ps1, installer-hote-natif.ps1, runtime.ps1).
$stamp = & (Join-Path $PSScriptRoot 'scripts\empreinte.ps1')
Set-Content (Join-Path $localRoot 'installed.stamp') $stamp -Encoding utf8NoBOM
Write-Host 'NexusBrowser installé. Recharger l''extension (dossier extension\) dans chrome://extensions,'
Write-Host 'puis ouvrir une nouvelle conversation dans chaque agent pour charger nexus-browser.'
