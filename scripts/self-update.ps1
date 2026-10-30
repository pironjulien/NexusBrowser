# Compatibility entry point, no scheduler. NexusSystem owns periodic maintenance.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime.ps1')
$central = Join-Path $HOME '.nexus\nexussystem\maintenance\get-nexus.ps1'
if (Test-Path -LiteralPath $central -PathType Leaf) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $central -Maintain
    exit $LASTEXITCODE
}
# Older standalone installs still work, using only existing routes and the safe activation receipt.
$app = Split-Path -Parent $PSScriptRoot
$get = Join-Path $env:TEMP "nexus-browser-get-$PID.ps1"
try {
    Copy-Item -LiteralPath (Join-Path $app 'get.ps1') -Destination $get -Force
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $get -UpdateOnly
    exit $LASTEXITCODE
} finally {
    Remove-Item -LiteralPath $get -Force -ErrorAction SilentlyContinue
}
