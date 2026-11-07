# Compatibility entry point. NexusBrowser's get.ps1 up to 2.35.32 restores a failed update by running the NEW package's
# scripts\install-native.ps1 (moved to app.failed) with -PayloadRoot (the restored app) and -ExpectedPayloadHash (its
# digest taken before the update): this package's engine checks that digest and registers the restored payload, whose
# own scripts are never executed (NexusBrowser.exe --install --restore-payload). Without -PayloadRoot: install.ps1.
# Windows PowerShell 5.1 and pwsh 7 (ASCII file).
param([switch]$SkipTests, [switch]$SkipLaunch, [switch]$Register, [switch]$UpdateOnly, [string]$PayloadRoot, [string]$ExpectedPayloadHash)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $PayloadRoot) {
    $forwarded = @{} + $PSBoundParameters
    & (Join-Path $root 'install.ps1') @forwarded
    exit $LASTEXITCODE
}
$arguments = @('--install', '--restore-payload', $PayloadRoot, '--expected-payload-hash', $ExpectedPayloadHash)
if ($Register) { $arguments += '--register' }
if ($UpdateOnly) { $arguments += '--update-only' }
if ($SkipLaunch) { $arguments += '--skip-launch' }
$info = New-Object Diagnostics.ProcessStartInfo (Join-Path $root 'engine\NexusBrowser.exe')
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
