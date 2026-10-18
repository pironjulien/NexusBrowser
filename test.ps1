# Contrôle complet de NexusBrowser, hors ligne et sans effet de bord (convention Nexus : test.ps1 à la racine).
# Style (ruff), types (Pyright, zéro erreur), tests Python (pont réel sur ports éphémères, jeton jetable) et tests de
# l'extension (Node). -Full : en plus, validation réelle dans le Chrome de Julien (onglet d'agent en arrière-plan,
# fermé à la fin) : --mouse puis --full-live. Échec clair si le pont ou l'extension ne sont pas à jour.
param([switch]$Full)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\runtime.ps1')
if (-not (Test-Path $pythonExe)) { throw 'Environnement absent : lancer install.ps1.' }
& $pythonExe -m ruff check $PSScriptRoot
if ($LASTEXITCODE) { exit $LASTEXITCODE }
& $pythonExe -m ruff format --check $PSScriptRoot
if ($LASTEXITCODE) { exit $LASTEXITCODE }
& $pythonExe -m pyright --project $PSScriptRoot --pythonpath $pythonExe $PSScriptRoot
if ($LASTEXITCODE) { exit $LASTEXITCODE }
& $pythonExe -m pytest (Join-Path $PSScriptRoot 'tests') -q -p no:cacheprovider
if ($LASTEXITCODE) { exit $LASTEXITCODE }
& node --test (Join-Path $PSScriptRoot 'tests\browser.test.cjs')
if ($LASTEXITCODE) { exit $LASTEXITCODE }
if ($Full) {
    & (Join-Path $PSScriptRoot 'verify.ps1') -Browser
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    $live = Join-Path $PSScriptRoot 'tests\live_browser_validation.py'
    foreach ($mode in "--mouse", "--full-live") {
        & $pythonExe $live $mode
        if ($LASTEXITCODE) {
            Write-Error "Validation réelle $mode en échec (code $LASTEXITCODE)." -ErrorAction Continue
            exit $LASTEXITCODE
        }
    }
    Write-Host 'Validation réelle (--mouse, --full-live) : OK.'
}
exit 0
