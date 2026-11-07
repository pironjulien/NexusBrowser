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

# Installs a build once in <VersionsRoot>\<first 16 characters of its fingerprint> and never writes into that folder
# again: a release engine is a .NET single file that reads its own executable for each assembly on first use, so an
# engine in use must never see its file renamed or replaced under it. An incomplete leftover (no executable) is
# replaced; an existing folder whose engine does not match the fingerprint is refused, never run or overwritten.
function Install-EngineBuild([string]$Candidate, [string]$VersionsRoot) {
    $fingerprint = Get-BuildFingerprint $Candidate
    $directory = Join-Path $VersionsRoot $fingerprint.Substring(0, 16)
    $new = -not (Test-Path -LiteralPath (Join-Path $directory 'NexusBrowser.exe'))
    if ($new) {
        $staging = "$directory.tmp-$PID"
        New-Item -ItemType Directory -Force $staging | Out-Null
        Get-ChildItem -LiteralPath $Candidate | Copy-Item -Destination $staging -Recurse -Force
        [IO.File]::WriteAllText((Join-Path $staging 'engine.lock'), '')  # held by each engine run from here (EngineLock)
        if (Test-Path -LiteralPath $directory) { Remove-Item -LiteralPath $directory -Recurse -Force }  # incomplete leftover
        Rename-Item -LiteralPath $staging -NewName (Split-Path -Leaf $directory)
    }
    if ((Get-BuildFingerprint $directory) -cne $fingerprint) {
        throw "Installed build cache does not match the verified payload: $directory. It was not executed or overwritten."
    }
    # A build installed before 2.35.26 gets its lock file (a new empty file: nothing an engine reads changes).
    $lock = Join-Path $directory 'engine.lock'
    if (-not (Test-Path -LiteralPath $lock)) { [IO.File]::WriteAllText($lock, '') }
    [pscustomobject]@{ Directory = $directory; Fingerprint = $fingerprint; New = $new }
}

# Image paths of the running processes called $Name (without .exe), read by QueryFullProcessImageNameW with
# PROCESS_QUERY_LIMITED_INFORMATION: unlike WMI's ExecutablePath, Get-Process .Path or Process.MainModule, it also
# reads an elevated process of the same user. Unknown: one of them runs but cannot be read at all; callers then keep
# every folder.
if (-not ('NexusBrowserProcessImage' -as [type])) {
    Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class NexusBrowserProcessImage {
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int id);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
    // Image path of a process; "" once it has exited; null while it runs but cannot be read.
    public static string Read(int id) {
        IntPtr handle = OpenProcess(0x1000, false, id);  // PROCESS_QUERY_LIMITED_INFORMATION
        if (handle == IntPtr.Zero) return Marshal.GetLastWin32Error() == 87 ? "" : null;  // 87: no such process
        try {
            StringBuilder name = new StringBuilder(32768); uint size = (uint)name.Capacity;
            if (QueryFullProcessImageNameW(handle, 0, name, ref size)) return name.ToString(0, (int)size);
            uint code; return GetExitCodeProcess(handle, out code) && code != 259 ? "" : null;  // 259: STILL_ACTIVE
        } finally { CloseHandle(handle); }
    }
}
'@
}
function Get-ProcessImages([string[]]$Name) {
    $paths = New-Object Collections.Generic.List[string]; $unknown = $false
    foreach ($process in @(Get-Process -Name $Name -ErrorAction SilentlyContinue)) {
        $path = [NexusBrowserProcessImage]::Read($process.Id)
        if ($null -eq $path) { $unknown = $true } elseif ($path) { $paths.Add($path) }
    }
    [pscustomobject]@{ Paths = $paths.ToArray(); Unknown = $unknown }
}

# True when a folder may still be used: a process image in it, an unreadable process ($Images.Unknown), or its
# engine.lock held (every engine holds the one of its folder for its whole life, whatever path spelling started it).
function Test-FolderInUse([string]$Folder, $Images) {
    if ($Images.Unknown) { return $true }
    $prefix = $Folder.TrimEnd('\') + '\'
    if ($Images.Paths | Where-Object { $_.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) }) { return $true }
    $lock = Join-Path $Folder 'engine.lock'
    if (Test-Path -LiteralPath $lock -PathType Leaf) {
        try { [IO.File]::Open($lock, 'Open', 'ReadWrite', 'None').Dispose() } catch { return $true }
    }
    return $false
}

# Removes a folder no process uses: renamed aside first (Windows refuses while a file in it is open: an engine starting
# meanwhile holds its lock), then deleted. Returns $true when it is gone; a folder in use stays whole.
function Remove-FolderIfUnused([string]$Folder, $Images) {
    if (Test-FolderInUse $Folder $Images) { return $false }
    $aside = "$($Folder.TrimEnd('\')).$PID.removing"
    try { [IO.Directory]::Move($Folder, $aside) } catch { return $false }
    Remove-Item -LiteralPath $aside -Recurse -Force -ErrorAction SilentlyContinue  # anything left goes next time
    return -not (Test-Path -LiteralPath $aside)
}

# Removes the build folders of <VersionsRoot> other than $Keep that no engine uses (Test-FolderInUse): an engine still
# serving an AI session keeps its whole folder until it exits, and a later update removes it. Leftovers renamed aside
# (*.removing) go too.
function Remove-UnusedEngineBuilds([string]$VersionsRoot, [string]$Keep, $Images = (Get-ProcessImages 'NexusBrowser')) {
    if (-not (Test-Path -LiteralPath $VersionsRoot)) { return }
    foreach ($dir in Get-ChildItem -LiteralPath $VersionsRoot -Directory) {
        if ($dir.FullName -eq $Keep) { continue }
        if ($dir.Name -like '*.removing') {
            if (-not (Test-FolderInUse $dir.FullName $Images)) { Remove-Item -LiteralPath $dir.FullName -Recurse -Force -ErrorAction SilentlyContinue }
            continue
        }
        $null = Remove-FolderIfUnused $dir.FullName $Images
    }
}
