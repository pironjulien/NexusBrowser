# Build a candidate, never overwrite a running installation. All artifacts stay outside OneDrive.
param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime.ps1')
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $nativeRoot 'build\candidate' }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if ($OutputDirectory.StartsWith([IO.Path]::GetFullPath($repositoryRoot) + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Native build output must stay outside the repository and OneDrive.'
}
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { throw '.NET 10 SDK is required to build NexusBrowser.' }
& dotnet publish (Join-Path $repositoryRoot 'native\NexusBrowser.csproj') -c Release -o $OutputDirectory --nologo
if ($LASTEXITCODE) { throw 'Native NexusBrowser build failed.' }
$candidate = Join-Path $OutputDirectory 'NexusBrowser.exe'
$process = [Diagnostics.Process]::new()
$process.StartInfo = [Diagnostics.ProcessStartInfo]::new($candidate, '--selftest')
$process.StartInfo.UseShellExecute = $false
$process.StartInfo.CreateNoWindow = $true
$process.StartInfo.RedirectStandardOutput = $true
$process.StartInfo.RedirectStandardError = $true
[void]$process.Start()
$stdout = $process.StandardOutput.ReadToEndAsync()
$stderr = $process.StandardError.ReadToEndAsync()
if (-not $process.WaitForExit(60000)) { $process.Kill(); throw 'Native selftest timed out.' }
$out = $stdout.GetAwaiter().GetResult()
$err = $stderr.GetAwaiter().GetResult()
if ($process.ExitCode -ne 0 -or $out -notmatch 'selftest passed') { throw "Native selftest failed: $out $err" }
Write-Host $out.Trim()
