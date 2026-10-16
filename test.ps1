# Offline check: the extension's Node test suite (simulated Chrome APIs, CDP input and DOM; no browser needed) and a
# syntax check of the native host. Nothing is written to the source tree. Exit code 0 when everything passes.
# Requires Node 22+ and Python 3.10+.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
node --test (Join-Path $root 'tests\browser.test.cjs')
if ($LASTEXITCODE) { throw 'Extension tests failed.' }
$python = (Get-Command python -ErrorAction Stop).Source
$files = Get-ChildItem (Join-Path $root 'native-host') -Filter '*.py' | Select-Object -ExpandProperty FullName
& $python -c "import ast, sys`nfor f in sys.argv[1:]: ast.parse(open(f, encoding='utf-8').read(), f)" @files
if ($LASTEXITCODE) { throw 'Native host syntax check failed.' }
Write-Host 'All checks passed.'
exit 0
