# Offline check of NexusBrowser, no side effect: engine tests (xUnit, dotnet test) and extension tests (node --test).
# -Full: in addition, the bridge and the loaded extension on this PC (verify.ps1 -Browser).
param([switch]$Full)
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot  # dotnet test reads global.json from here
try {
    & dotnet test --project tests\NexusBrowser.Tests
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    & node --test tests\browser.test.cjs
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    if ($Full) {
        & (Join-Path $PSScriptRoot 'verify.ps1') -Browser
        if ($LASTEXITCODE) { exit $LASTEXITCODE }
    }
} finally { Pop-Location }
exit 0
