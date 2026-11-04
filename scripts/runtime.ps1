# Paths of NexusBrowser on this PC, outside OneDrive: data in ~\.nexus\nexus-browser (token, logs, captures, exports),
# immutable engine builds in %LOCALAPPDATA%\NexusBrowser\versions\<fingerprint>, the one in use named by current.json.
# Windows PowerShell 5.1 and pwsh 7 (ASCII file).
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$localRoot = Join-Path $env:USERPROFILE '.nexus\nexus-browser'
$tokenFile = Join-Path $localRoot 'bridge-token'
# Scheduled tasks. Engines before 2.35.12 start their bridge and update task by the names written with a space: the
# installer keeps the set the installed engine calls (a rollback to such an engine included), and renames or removes
# the other set (Move-ProductTasks), so one task per role, never two bridges or daemons.
$taskNamesSince = [version]'2.35.12'
$taskNames = [ordered]@{ Bridge = 'NexusBrowser Bridge'; Daemon = 'NexusBrowser MCP'; Update = 'NexusBrowser Update' }
$legacyTaskNames = [ordered]@{ Bridge = 'Nexus Browser Bridge'; Daemon = 'Nexus Browser MCP'; Update = 'Nexus Browser Update' }
$bridgeTaskName = $taskNames.Bridge
$daemonTaskName = $taskNames.Daemon
$updateTaskName = $taskNames.Update
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

# Task names the engine of this version calls (its bridge and update tasks are started by name), and the other set.
function Get-TaskNameSets([string]$EngineVersion) {
    if ([version]$EngineVersion -lt $taskNamesSince) { @{ Keep = $legacyTaskNames; Retire = $taskNames } }
    else { @{ Keep = $taskNames; Retire = $legacyTaskNames } }
}

# Migration of the product's tasks found (names): per role, a task under the other set's name only is renamed (same
# action, trigger, principal, settings and disabled state), and removed when the kept name already exists.
function Get-TaskMigration([string]$EngineVersion, [string[]]$Existing) {
    $sets = Get-TaskNameSets $EngineVersion
    foreach ($role in @($sets.Keep.Keys)) {
        $keep = $sets.Keep[$role]; $retire = $sets.Retire[$role]
        if ($Existing -notcontains $retire) { continue }
        $step = if ($Existing -contains $keep) { 'Remove' } else { 'Rename' }
        [pscustomobject]@{ Role = $role; Step = $step; From = $retire; To = $keep }
    }
}

# A bridge or daemon kept by a deferred update may run outside its task (renamed meanwhile): a task is started only
# when it is neither running nor disabled and no instance of its role runs.
function Test-TaskStart([string]$State, [int]$RunningInstances) {
    $State -notin @('Running', 'Disabled') -and $RunningInstances -eq 0
}

# Engine processes whose command line matches (bridge, daemon).
function Get-EngineProcesses([string]$Pattern) {
    @(Get-CimInstance Win32_Process -Filter "Name='NexusBrowser.exe'" | Where-Object { $_.CommandLine -match $Pattern })
}

# Applies Get-TaskMigration on this PC. Unregistering a task leaves its running instance alive (a busy bridge or
# daemon keeps serving), so a rename never stops a process; Test-TaskStart prevents a second instance.
function Move-ProductTasks([string]$EngineVersion, [scriptblock]$OnStep) {
    $names = @($taskNames.Values) + @($legacyTaskNames.Values)
    $existing = @(Get-ScheduledTask -TaskName $names -ErrorAction SilentlyContinue | ForEach-Object { $_.TaskName })
    foreach ($step in @(Get-TaskMigration $EngineVersion $existing)) {
        if ($step.Step -eq 'Rename') {
            $xml = Export-ScheduledTask -TaskName $step.From
            Register-ScheduledTask -TaskName $step.To -Xml $xml | Out-Null
        }
        Unregister-ScheduledTask -TaskName $step.From -Confirm:$false
        & $OnStep $(if ($step.Step -eq 'Rename') { "Task '$($step.From)' renamed '$($step.To)'." } else { "Task '$($step.From)' removed ('$($step.To)' kept)." })
    }
}

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
