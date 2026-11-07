# NexusBrowser install entry point, run in place (safe to run again):
#  - from a release package (engine\NexusBrowser.exe present: %LOCALAPPDATA%\NexusBrowser\app), its engine installs it;
#  - from a development checkout, the engine is built first with the .NET 10 SDK (scripts\build-native.ps1, outputs in
#    ~\.nexus\build\nexus-browser), test.ps1 runs unless -SkipTests, then that build installs the checkout.
# Everything else is NexusBrowser.exe --install (native\Installer.cs). Windows PowerShell 5.1 and pwsh 7 (ASCII file).
# Usage: pwsh -NoProfile -File install.ps1 [-SkipTests] [-SkipLaunch] [-Register] [-UpdateOnly]
param([switch]$SkipTests, [switch]$SkipLaunch, [switch]$Register, [switch]$UpdateOnly)
$ErrorActionPreference = 'Stop'
$engine = Join-Path $PSScriptRoot 'engine\NexusBrowser.exe'
$arguments = @('--install', '--source', $PSScriptRoot)
if (-not (Test-Path -LiteralPath $engine)) {
    if ($UpdateOnly) { throw 'UpdateOnly requires a prebuilt release; development checkouts are not built automatically.' }
    if (-not $SkipTests) {
        & (Join-Path $PSScriptRoot 'test.ps1')
        if ($LASTEXITCODE) { throw 'test.ps1 failed.' }
    }
    . (Join-Path $PSScriptRoot 'scripts\runtime.ps1')
    $candidate = Join-Path $buildRoot 'candidate'
    & (Join-Path $PSScriptRoot 'scripts\build-native.ps1') -OutputDirectory $candidate
    $engine = Join-Path $candidate 'NexusBrowser.exe'
    $arguments += @('--engine', $candidate)
}
if ($Register) { $arguments += '--register' }
if ($UpdateOnly) { $arguments += '--update-only' }
if ($SkipLaunch) { $arguments += '--skip-launch' }

# The engine is a Windows program (PowerShell would not wait for it): started without a window, its output shown as it
# comes, its exit code returned. Its standard input is closed at once.
$info = New-Object Diagnostics.ProcessStartInfo $engine
$info.Arguments = (($arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' ')
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$info.StandardOutputEncoding = [Text.Encoding]::UTF8
$info.StandardErrorEncoding = [Text.Encoding]::UTF8
$process = [Diagnostics.Process]::Start($info)
$process.StandardInput.Close()
$errors = $process.StandardError.ReadToEndAsync()
while ($null -ne ($line = $process.StandardOutput.ReadLine())) { Write-Host $line }
$process.WaitForExit()
if ($errors.Result.Trim()) { Write-Host $errors.Result.Trim() }
exit $process.ExitCode
