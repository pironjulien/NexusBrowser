# NexusBrowser install entry point. The controller is versioned with this package and also performs safe rollbacks.
param([switch]$SkipTests, [switch]$SkipLaunch, [switch]$Register)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'scripts\install-native.ps1') @PSBoundParameters
exit $LASTEXITCODE
