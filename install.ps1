# Installs NexusBrowser on this PC (safe to run again after an update). No Python: the engine is NexusBrowser.exe (.NET).
#  - engine: the prebuilt one of a release (engine\, from get.ps1), else built here with the .NET 10 SDK
#    (scripts\build-native.ps1, outputs in ~\.nexus\build\nexus-browser); installed once per build in
#    %LOCALAPPDATA%\NexusBrowser\versions\<fingerprint> (never overwritten while it runs), named by current.json
#  - native host com.nexus.browser_auth declared to Chrome (HKCU), task "Nexus Browser Bridge" without trigger (the
#    bridge starts on demand: first agent call, schtasks /Run)
#  - shared MCP daemon (127.0.0.1:16182, bearer token): on a Nexus workstation declared to the daemon supervisor
#    (~\.nexus\daemons\specs\nexus-browser.json, key exe, restart_request); a new build asks the running daemon to
#    restart once no call is running. Public install (-Register) without that supervisor: task "Nexus Browser MCP" at
#    logon, token in the user variable NEXUS_MCP_TOKEN (created once, shared with the other Nexus products)
#  - Antigravity (Nexus workstation): plugin nexus-browser pointing to the shared daemon
#  - -Register (public install, get.ps1): server declared to the AI clients found (NexusBrowser.exe --register), then a
#    guide for loading the extension in Chrome; NEXUS_PACK=1 (the Nexus pack): no question, no wait, no window
#  - offline tests (test.ps1) unless -SkipTests
# Runs under Windows PowerShell 5.1 and pwsh 7 (ASCII file: 5.1 reads a .ps1 without BOM in the ANSI code page).
# Usage: pwsh -NoProfile -File install.ps1 [-SkipTests] [-SkipLaunch] [-Register]
param([switch]$SkipTests, [switch]$SkipLaunch, [switch]$Register)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\runtime.ps1')
$utf8 = New-Object Text.UTF8Encoding $false
New-Item -ItemType Directory -Force $localRoot | Out-Null
$journal = Join-Path $localRoot 'install.log'
function Write-Journal([string]$Text) {
    Write-Host $Text
    [IO.File]::AppendAllText($journal, (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Text + [Environment]::NewLine, $utf8)
}
$version = (Get-Content (Join-Path $PSScriptRoot 'VERSION') -Raw).Trim()
$previousExe = $nativeExe
$pack = $env:NEXUS_PACK -eq '1'

# --- 1. Engine: one immutable folder per build.
$prebuilt = Join-Path $PSScriptRoot 'engine'
if (Test-Path -LiteralPath (Join-Path $prebuilt 'NexusBrowser.exe')) {
    $candidate = $prebuilt
} else {
    $candidate = Join-Path $buildRoot 'candidate'
    & (Join-Path $PSScriptRoot 'scripts\build-native.ps1') -OutputDirectory $candidate
}
$fingerprint = Get-BuildFingerprint $candidate
$versionDir = Join-Path $versionsRoot $fingerprint.Substring(0, 16)
if (-not (Test-Path -LiteralPath (Join-Path $versionDir 'NexusBrowser.exe'))) {
    $staging = "$versionDir.tmp-$PID"
    New-Item -ItemType Directory -Force $staging | Out-Null
    Get-ChildItem -LiteralPath $candidate | Copy-Item -Destination $staging -Recurse -Force
    if (Test-Path -LiteralPath $versionDir) { Remove-Item -LiteralPath $versionDir -Recurse -Force }  # incomplete leftover
    Rename-Item -LiteralPath $staging -NewName (Split-Path -Leaf $versionDir)
    Write-Journal "Engine $version installed in $versionDir."
}
$exe = Join-Path $versionDir 'NexusBrowser.exe'
$check = Invoke-Native $exe @('--version') 30
if ($check.Code -or $check.Output -ne $version) { throw "Installed engine answers '$($check.Output)', expected $version." }
# Where the plugin, skill and update script are read from (public update, client registration).
[IO.File]::WriteAllText((Join-Path $versionDir 'installation.json'), (@{ repository_root = $PSScriptRoot } | ConvertTo-Json), $utf8)

# --- 2. Agents driving tabs: the running bridge and daemon are left alone (their new build waits for the next start).
$busy = $false
if (-not $SkipLaunch -and (Test-Path -LiteralPath $tokenFile)) {
    $probe = Invoke-Native $exe @('--refresh-extension', '--check-only') 60
    $busy = $probe.Code -eq 3
    if ($busy) { Write-Warning 'Agents are driving Chrome tabs: the running bridge and daemon keep their build until their next start.' }
}

[IO.File]::WriteAllText($currentFile, (@{ exe = $exe; version = $version; fingerprint = $fingerprint } | ConvertTo-Json), $utf8)
& (Join-Path $PSScriptRoot 'scripts\installer-hote-natif.ps1') -Exe $exe

# --- 3. Bridge task, started on demand (no trigger).
function Get-EngineProcesses([string]$Pattern) {
    @(Get-CimInstance Win32_Process -Filter "Name='NexusBrowser.exe'" | Where-Object { $_.CommandLine -match $Pattern })
}
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$bridgeArguments = "--bridge --token-file `"$tokenFile`" --log-file `"$(Join-Path $localRoot 'bridge.log')`""
$action = New-ScheduledTaskAction -Execute $exe -Argument $bridgeArguments -WorkingDirectory $localRoot
$settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$oldBridges = @(Get-EngineProcesses '--bridge(\s|$)' | Where-Object { $_.ExecutablePath -ne $exe })
if ($oldBridges.Count -and -not $busy -and -not $SkipLaunch) {
    if ((Get-ScheduledTask -TaskName $bridgeTaskName -ErrorAction SilentlyContinue).State -eq 'Running') { Stop-ScheduledTask -TaskName $bridgeTaskName }
    # The previous build's auth hosts cannot answer Chrome once its bridge is gone: Chrome reconnects to the new one.
    Get-EngineProcesses '(--bridge(\s|$))|(chrome-extension://[a-p]{32}/)' | Where-Object { $_.ExecutablePath -ne $exe } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Write-Journal 'Previous bridge stopped; the new build starts on demand.'
}
# Register -Force keeps the triggers of an existing task: recreated from scratch.
if (Get-ScheduledTask -TaskName $bridgeTaskName -ErrorAction SilentlyContinue) {
    if ((Get-ScheduledTask -TaskName $bridgeTaskName).State -ne 'Running') { Unregister-ScheduledTask -TaskName $bridgeTaskName -Confirm:$false }
    else { Set-ScheduledTask -TaskName $bridgeTaskName -Action $action | Out-Null }
}
if (-not (Get-ScheduledTask -TaskName $bridgeTaskName -ErrorAction SilentlyContinue)) {
    Register-ScheduledTask -TaskName $bridgeTaskName -Action $action -Principal $principal -Settings $settings `
        -Description 'NexusBrowser Chrome bridge (Antigravity, Claude, Codex), started on demand (no trigger).' | Out-Null
}
Write-Host "Task '$bridgeTaskName' -> $exe"

# --- 4. Update task (public install only, %LOCALAPPDATA%\NexusBrowser\app): the bridge starts it on POST /api/update;
#     it runs scripts\self-update.ps1 without a window. A clone updates through git.
$publicApp = Join-Path $nativeRoot 'app'
if ((Test-Path -LiteralPath $publicApp) -and ((Resolve-Path -LiteralPath $PSScriptRoot).Path -eq (Resolve-Path -LiteralPath $publicApp).Path)) {
    $updateAction = New-ScheduledTaskAction -Execute 'conhost.exe' -WorkingDirectory $localRoot `
        -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $publicApp 'scripts\self-update.ps1')`""
    $updateSettings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
    if (Get-ScheduledTask -TaskName $updateTaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $updateTaskName -Confirm:$false }
    Register-ScheduledTask -TaskName $updateTaskName -Action $updateAction -Principal $principal -Settings $updateSettings `
        -Description 'NexusBrowser update, started by its bridge (POST /api/update), no trigger.' | Out-Null
    Write-Host "Task '$updateTaskName' installed."
}

# --- 5. Leftovers of the bridge before 17/10/2026 (NexusAGY): its task, native host and token no longer serve.
. (Join-Path $PSScriptRoot 'scripts\registre-reel.ps1')
if (Get-ScheduledTask -TaskName 'NexusAGY Browser Bridge' -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName 'NexusAGY Browser Bridge' -Confirm:$false
    Write-Journal 'Old task "NexusAGY Browser Bridge" removed.'
}
if (Test-Path 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.nexusagy.bridge_auth') {
    $null = Invoke-RegistreReel @('delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.nexusagy.bridge_auth" /f')
    Write-Journal 'Old native host com.nexusagy.bridge_auth removed from Chrome (HKCU key).'
}
$oldRoot = Join-Path $HOME '.nexusagy'
foreach ($old in @((Join-Path $oldRoot 'bridge-token'), (Join-Path $oldRoot 'native-host\com.nexusagy.bridge_auth.json'),
        (Join-Path $oldRoot 'native-host\nexusagy_bridge_auth.cmd'))) {
    if (Test-Path -LiteralPath $old -PathType Leaf) { Remove-Item -LiteralPath $old -Force; Write-Journal "Old NexusAGY bridge file removed: $old" }
}

# --- 6. Shared MCP daemon (port 16182): one nexus-browser server for every session of Claude, Codex and Antigravity.
$port = 16182
$supervised = [bool](Get-ScheduledTask -TaskName 'Nexus MCP Daemons' -ErrorAction SilentlyContinue)
# Nexus workstation token, shared by both PCs: created once by Sync-NexusPoste, never here.
$mcpTokenFile = if ($env:OneDrive) { Join-Path $env:OneDrive 'Documents\NexusSecure\agents\nexus-mcp-token.txt' }
$token = $null
if ($supervised -and $mcpTokenFile -and (Test-Path -LiteralPath $mcpTokenFile)) { $token = (Get-Content -LiteralPath $mcpTokenFile -Raw).Trim() }
$daemonExes = @(Get-EngineProcesses "--http\s+$port" | Where-Object { $_.ExecutablePath -ne $exe })
if ($token) {
    # exe: the supervisor's key. python (same value): read by supervisors built before the exe key; to drop once every
    # workstation runs a NexusPoste that reads exe (an older one ignores a spec without it: daemon not started).
    $spec = [ordered]@{ port = $port; exe = $exe; python = $exe; args = @(); env = [ordered]@{}; restart_request = $restartRequest }
    $specText = $spec | ConvertTo-Json -Depth 5
    $before = if (Test-Path -LiteralPath $daemonSpec) { [IO.File]::ReadAllText($daemonSpec) } else { '' }
    if ($before -ne $specText) {
        New-Item -ItemType Directory -Force (Split-Path $daemonSpec) | Out-Null
        [IO.File]::WriteAllText("$daemonSpec.tmp", $specText, $utf8)
        Move-Item -LiteralPath "$daemonSpec.tmp" -Destination $daemonSpec -Force
        Write-Journal "Daemon spec -> $exe"
    }
    foreach ($leftover in "$daemonSpec.runtime-switch", "$daemonSpec.pause", "$daemonSpec.installing") {
        if (Test-Path -LiteralPath $leftover) { Remove-Item -LiteralPath $leftover -Force }
    }
    if ($daemonExes.Count) {
        # The running daemon stops itself once no call runs; the supervisor then starts this build.
        [IO.File]::WriteAllText($restartRequest, "code sha256:$fingerprint", $utf8)
        # Builds before 2.33.0 do not read restart requests: stopped here unless agents are busy.
        $legacy = @($daemonExes | Where-Object { $_.ExecutablePath -eq $legacyExe })
        if ($legacy.Count -and -not $busy -and -not $SkipLaunch) {
            $legacy | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            Write-Journal 'Daemon of the previous engine (no restart request support) stopped; the supervisor starts the new one.'
        }
    }
} elseif ($Register -and -not $supervised) {
    # Public install: ONE token per PC shared by every Nexus daemon (common rule). Its file: NEXUS_MCP_TOKEN_FILE when
    # set, else ~\.nexus\mcp-token.txt; reused when present, never regenerated; created exclusively otherwise, so that
    # installers run one after the other or together end with the same token. The user variable NEXUS_MCP_TOKEN mirrors
    # it for the AI apps (never written into their files); the daemon reads the file.
    $sharedTokenFile = @([Environment]::GetEnvironmentVariable('NEXUS_MCP_TOKEN_FILE', 'Process'),
        [Environment]::GetEnvironmentVariable('NEXUS_MCP_TOKEN_FILE', 'User')) | Where-Object { $_ } | Select-Object -First 1
    if (-not $sharedTokenFile) { $sharedTokenFile = Join-Path $HOME '.nexus\mcp-token.txt' }
    New-Item -ItemType Directory -Force (Split-Path $sharedTokenFile) | Out-Null
    $token = if (Test-Path -LiteralPath $sharedTokenFile) { (Get-Content -LiteralPath $sharedTokenFile -Raw).Trim() } else { '' }
    if (-not $token) {
        $bytes = New-Object byte[] 32
        [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $candidateToken = -join ($bytes | ForEach-Object { $_.ToString('x2') })
        try {
            $stream = [IO.File]::Open($sharedTokenFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $data = $utf8.GetBytes($candidateToken); $stream.Write($data, 0, $data.Length) } finally { $stream.Dispose() }
            Write-Host "Shared MCP token created: $sharedTokenFile"
        } catch [IO.IOException] { }  # another installer created it first: its token wins
        $deadline = [DateTime]::UtcNow.AddSeconds(5)
        do { $token = (Get-Content -LiteralPath $sharedTokenFile -Raw -ErrorAction SilentlyContinue); if ($token) { $token = $token.Trim() } }
        while (-not $token -and [DateTime]::UtcNow -lt $deadline)
        if (-not $token -or $token.Length -lt 32) { throw "Shared MCP token unreadable: $sharedTokenFile" }
    }
    if ([Environment]::GetEnvironmentVariable('NEXUS_MCP_TOKEN', 'User') -ne $token) {
        [Environment]::SetEnvironmentVariable('NEXUS_MCP_TOKEN', $token, 'User')
        Write-Host 'User variable NEXUS_MCP_TOKEN set (restart the AI apps to see it).'
    }
    $env:NEXUS_MCP_TOKEN = $token
    $daemonAction = New-ScheduledTaskAction -Execute $exe -Argument "--http $port" -WorkingDirectory $localRoot
    $daemonSettings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew `
        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
    $existing = Get-ScheduledTask -TaskName $daemonTaskName -ErrorAction SilentlyContinue
    $restart = $daemonExes.Count -and -not $busy
    if ($existing -and ($existing.State -ne 'Running' -or $restart)) {
        if ($existing.State -eq 'Running') { Stop-ScheduledTask -TaskName $daemonTaskName }
        $daemonExes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Unregister-ScheduledTask -TaskName $daemonTaskName -Confirm:$false
        $existing = $null
    }
    if (-not $existing) {
        Register-ScheduledTask -TaskName $daemonTaskName -Action $daemonAction -Trigger $trigger -Principal $principal -Settings $daemonSettings `
            -Description "NexusBrowser MCP daemon (127.0.0.1:$port) shared by the AI apps, bearer token NEXUS_MCP_TOKEN." | Out-Null
    }
    if (-not $SkipLaunch -and (Get-ScheduledTask -TaskName $daemonTaskName).State -ne 'Running') { Start-ScheduledTask -TaskName $daemonTaskName }
    Write-Host "Task '$daemonTaskName' -> $exe --http $port"
} elseif (-not $supervised) {
    Write-Warning 'No Nexus daemon supervisor and no -Register: shared daemon not installed (stdio servers still work).'
} else {
    Write-Warning "Shared MCP token absent ($mcpTokenFile): daemon not declared. Wait for OneDrive, run Sync-NexusPoste.ps1 -Apply, then install.ps1 again."
}

# --- 7. Antigravity (Nexus workstation): plugin nexus-browser on the shared daemon, its skill; one declaration only.
$agyRoot = Join-Path $HOME '.gemini\config'
$agyConfig = Join-Path $agyRoot 'mcp_config.json'
if ($supervised -and $token -and (Test-Path $agyConfig)) {
    $entry = [PSCustomObject]@{ serverUrl = "http://127.0.0.1:$port/mcp?agent=antigravity"; headers = [PSCustomObject]@{ Authorization = "Bearer $token" } }
    $plugin = Join-Path $agyRoot 'plugins\nexus-browser'
    foreach ($file in Get-ChildItem (Join-Path $PSScriptRoot 'plugins\nexus-browser') -File -Recurse) {
        if ($file.Name -eq 'mcp_config.json') { continue }
        $target = Join-Path $plugin $file.FullName.Substring((Join-Path $PSScriptRoot 'plugins\nexus-browser').Length + 1)
        New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
        Copy-Item $file.FullName $target -Force
    }
    # Skill: the workstation's own version (perso\nexus-browser, private) when present, else the public one.
    $pluginSkill = Join-Path $plugin 'skills\nexus-browser'
    New-Item -ItemType Directory -Force $pluginSkill | Out-Null
    $skill = Join-Path $PSScriptRoot 'perso\nexus-browser\SKILL.md'
    if (-not (Test-Path -LiteralPath $skill)) { $skill = Join-Path $PSScriptRoot 'skills\nexus-browser\SKILL.md' }
    Copy-Item $skill (Join-Path $pluginSkill 'SKILL.md') -Force
    $pluginMcp = [PSCustomObject]@{ mcpServers = [PSCustomObject]@{ 'nexus-browser' = $entry } }
    [IO.File]::WriteAllText((Join-Path $plugin 'mcp_config.json'), ($pluginMcp | ConvertTo-Json -Depth 100), $utf8)
    $oldSkill = Join-Path $agyRoot 'skills\nexus-browser'
    if (Test-Path $oldSkill) {
        $saved = Join-Path $localRoot "backups\agy-skill-nexus-browser-$(Get-Date -Format yyyyMMdd-HHmmss)"
        New-Item -ItemType Directory -Force (Split-Path $saved) | Out-Null
        Move-Item $oldSkill $saved
        Write-Journal "Antigravity: global copy of the nexus-browser skill removed (duplicate of the plugin), saved in $saved"
    }
    # Plugin enabled in config.json only while Antigravity is closed (open, it writes its file back on exit).
    $agyApp = Join-Path $agyRoot 'config.json'
    if ((Test-Path $agyApp) -and -not (Get-Process -Name Antigravity -ErrorAction SilentlyContinue)) {
        $app = Get-Content $agyApp -Raw | ConvertFrom-Json
        if (-not $app.PSObject.Properties['plugins']) { $app | Add-Member plugins ([PSCustomObject]@{}) }
        if ($app.plugins.'nexus-browser'.enabled -ne $true) {
            $app.plugins | Add-Member -NotePropertyName 'nexus-browser' -NotePropertyValue ([PSCustomObject]@{ enabled = $true }) -Force
            [IO.File]::WriteAllText($agyApp, ($app | ConvertTo-Json -Depth 100), $utf8)
        }
    }
    $pluginOn = (Test-Path $agyApp) -and ((Get-Content $agyApp -Raw | ConvertFrom-Json).plugins.'nexus-browser'.enabled -eq $true)
    if ($pluginOn) {
        & (Join-Path $PSScriptRoot 'scripts\doublon-antigravity.ps1') -ConfigPath $agyConfig -BackupDir (Join-Path $localRoot 'backups') |
            ForEach-Object { Write-Journal $_ }
        if ($LASTEXITCODE) { throw 'Removing the nexus-browser duplicate from mcp_config.json (Antigravity) failed.' }
    } else {
        Write-Warning 'Antigravity open and plugin nexus-browser not enabled yet: global entry kept (run install.ps1 again with Antigravity closed).'
    }
    Write-Host 'Antigravity: nexus-browser declared (plugin only).'
}

# --- 8. Public install: the AI clients found get the server (stdio, this engine).
if ($Register) {
    $registration = Invoke-Native $exe @('--register', '--backups', (Join-Path $localRoot 'backups')) 120
    if (-not $pack) { Write-Host $registration.Output }
    if ($registration.Code) { throw 'Declaring the server to the AI clients failed (see above).' }
}

if (-not $SkipTests) {
    & (Join-Path $PSScriptRoot 'test.ps1')
    if ($LASTEXITCODE) { throw 'test.ps1 failed.' }
}

# --- 9. Bridge, extension and daemon checked.
if (-not $SkipLaunch) {
    if ((Get-ScheduledTask -TaskName $bridgeTaskName).State -ne 'Running') { Start-ScheduledTask -TaskName $bridgeTaskName }
    $wait = if ($pack) { 0 } else { 30 }
    $refresh = Invoke-Native $exe @('--refresh-extension', '--wait-ready', "$wait") 90
    Write-Host "Extension: $($refresh.Output)"
    if ($refresh.Code -eq 2 -and $Register) {
        if (-not $pack) { & (Join-Path $PSScriptRoot 'scripts\guide-extension.ps1') }
    } elseif ($refresh.Code -eq 2 -and (Get-Process -Name chrome -ErrorAction SilentlyContinue)) {
        Write-Warning 'Chrome is open but its NexusBrowser extension is not connected to the bridge.'
    } elseif ($refresh.Code -eq 1) {
        Write-Warning 'The loaded extension is not this version yet: reload it in chrome://extensions.'
    }
    if ($token -and -not $busy) {
        $deadline = [DateTime]::UtcNow.AddSeconds(60)
        $confirmed = $false
        do {
            try {
                $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2
                $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($health.pid)"
                $confirmed = $health.status -eq 'ok' -and $health.service -eq 'nexus-browser' -and $health.version -eq $version -and $owner.ExecutablePath -eq $exe
            } catch { $confirmed = $false }
            if (-not $confirmed) { Start-Sleep -Milliseconds 500 }
        } while (-not $confirmed -and [DateTime]::UtcNow -lt $deadline)
        if ($confirmed) { Write-Host "Shared MCP daemon $version confirmed (pid $($health.pid))." }
        else { Write-Warning 'The shared daemon has not switched to this build yet (a call is running): it will once idle.' }
    }
}

# --- 10. Older builds no process runs any more, and the legacy fixed folder, are removed.
$running = @(Get-CimInstance Win32_Process -Filter "Name='NexusBrowser.exe'" | ForEach-Object { $_.ExecutablePath })
if (Test-Path -LiteralPath $versionsRoot) {
    foreach ($dir in Get-ChildItem -LiteralPath $versionsRoot -Directory) {
        if ($dir.FullName -eq $versionDir) { continue }
        if ($running | Where-Object { $_ -and $_.StartsWith($dir.FullName + '\', [StringComparison]::OrdinalIgnoreCase) }) { continue }
        Remove-Item -LiteralPath $dir.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
}
$legacyDir = Split-Path $legacyExe
if ((Test-Path -LiteralPath $legacyDir) -and -not ($running -contains $legacyExe)) {
    Remove-Item -LiteralPath $legacyDir -Recurse -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath $legacyDir)) { Write-Journal "Legacy engine folder removed: $legacyDir" }
}
$oldVenv = Join-Path $localRoot 'venv'
if ((Test-Path -LiteralPath $oldVenv) -and -not (Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like "$oldVenv\*" })) {
    Remove-Item -LiteralPath $oldVenv -Recurse -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath $oldVenv)) { Write-Journal "Former Python environment removed: $oldVenv" }
}
if ($Register -and $pack) { Write-Host $registration.Output }  # the NEXUS_PACK_RESULT line stays the last
else { Write-Host "NexusBrowser $version installed." }
