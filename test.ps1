# Check of NexusBrowser, no side effect on this PC: engine tests (xUnit, dotnet test), type check of the extension's
# service worker (tsc, tsconfig.json) and extension tests (node --test). Offline once the locked development tools of
# package-lock.json are in node_modules (npm ci, run here when they are missing or older than the lock file).
# -Full: in addition, the bridge and the loaded extension on this PC (verify.ps1 -Browser).
param([switch]$Full)
# Nexus pre-push gate: on a Nexus workstation the run goes through ~\.nexus\git\Invoke-NexusTest.ps1 (NexusInfra), which
# records the tested tree when it passes; the pre-push hook refuses a pushed tree that has not passed this script.
if (-not $env:NEXUS_TEST_EMPREINTE -and (Test-Path -LiteralPath "$HOME\.nexus\git\Invoke-NexusTest.ps1")) { & "$HOME\.nexus\git\Invoke-NexusTest.ps1" -Script $PSCommandPath -Parametres $PSBoundParameters -Arguments $args; exit $LASTEXITCODE }
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot  # dotnet test reads global.json from here
try {
    & dotnet test --project tests\NexusBrowser.Tests
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    $installed = Join-Path $PSScriptRoot 'node_modules\.package-lock.json'
    if (-not (Test-Path -LiteralPath $installed) -or
        (Get-Item -LiteralPath $installed).LastWriteTimeUtc -lt (Get-Item -LiteralPath (Join-Path $PSScriptRoot 'package-lock.json')).LastWriteTimeUtc) {
        & npm ci --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE) { exit $LASTEXITCODE }
    }
    & node node_modules\typescript\bin\tsc -p tsconfig.json
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    & node --test tests\browser.test.cjs
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    if ($Full) {
        & (Join-Path $PSScriptRoot 'verify.ps1') -Browser
        if ($LASTEXITCODE) { exit $LASTEXITCODE }
    }
} finally { Pop-Location }
exit 0
