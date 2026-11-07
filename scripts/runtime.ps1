# Paths of NexusBrowser on this PC, outside OneDrive, for the build, package, guide and check scripts: data in
# ~\.nexus\nexus-browser (token, logs, captures, exports), immutable engine builds in
# %LOCALAPPDATA%\NexusBrowser\versions\<fingerprint>, the one in use named by current.json. The installation itself is
# the engine's (NexusBrowser.exe --install, native\Installer.cs). Windows PowerShell 5.1 and pwsh 7 (ASCII file).
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$localRoot = Join-Path $env:USERPROFILE '.nexus\nexus-browser'
$tokenFile = Join-Path $localRoot 'bridge-token'
# Scheduled task names (native\InstallSupport.cs, TaskNames): engines before 2.35.12 call the names written with a space.
$taskNamesSince = [version]'2.35.12'
$taskNames = [ordered]@{ Bridge = 'NexusBrowser Bridge'; Daemon = 'NexusBrowser MCP'; Update = 'NexusBrowser Update' }
$legacyTaskNames = [ordered]@{ Bridge = 'Nexus Browser Bridge'; Daemon = 'Nexus Browser MCP'; Update = 'Nexus Browser Update' }
$nativeRoot = Join-Path $env:LOCALAPPDATA 'NexusBrowser'
$currentFile = Join-Path $nativeRoot 'current.json'
$legacyExe = Join-Path $nativeRoot 'native\NexusBrowser.exe'
$daemonSpec = Join-Path $HOME '.nexus\daemons\specs\nexus-browser.json'
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

# A task is started only when it is neither running nor disabled and no instance of its role runs.
function Test-TaskStart([string]$State, [int]$RunningInstances) {
    $State -notin @('Running', 'Disabled') -and $RunningInstances -eq 0
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

# NexusBrowser.exe processes of this PC (pid, image, role, read_by), read by the engine $Exe (--engine-processes,
# native\EngineProcesses.cs).
function Get-EngineProcesses([string]$Exe, [string[]]$Ports = @()) {
    $result = Invoke-Native $Exe (@('--engine-processes') + $Ports) 30  # Ports: --bridge-port N --daemon-port N (tests)
    if ($result.Code) { throw "Listing the NexusBrowser processes failed: $($result.Output)" }
    @(($result.Output | ConvertFrom-Json).processes)
}

# Engine processes of one role ('bridge', 'daemon'), split as the installer does (native\InstallSupport.cs, EngineSplit):
# Others, another build of that role; Unknown, unreadable; Instances, every process that may be one of that role.
function Split-EngineProcesses($Processes, [string]$Role, [string]$Exe) {
    $target = [IO.Path]::GetFullPath($Exe)
    $others = New-Object Collections.Generic.List[object]; $unknown = New-Object Collections.Generic.List[object]
    $instances = New-Object Collections.Generic.List[object]
    foreach ($process in @($Processes)) {
        if ($process.role -ne $Role -and $process.role -ne 'unknown') { continue }
        $instances.Add($process)
        if ($process.role -eq 'unknown' -or -not $process.image) { $unknown.Add($process) }
        elseif (-not [string]::Equals([IO.Path]::GetFullPath($process.image), $target, [StringComparison]::OrdinalIgnoreCase)) { $others.Add($process) }
    }
    [pscustomobject]@{ Others = $others.ToArray(); Unknown = $unknown.ToArray(); Instances = $instances.ToArray() }
}
