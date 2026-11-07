# Antigravity: nexus-browser is declared ONCE, by its plugin (~\.gemini\config\plugins\nexus-browser).
# One more nexus-browser entry in ~\.gemini\config\mcp_config.json starts a second server: duplicate tools
# (nexus-browser_nexus-browser), wasted tokens. This script removes that entry only (other servers and settings are
# kept as they are), after a backup outside OneDrive, by an atomic write (temporary file, then replace).
#  -CheckOnly: writes nothing; exit code 1 and a message when the duplicate is there (verify.ps1).
param(
    [Parameter(Mandatory)][string]$ConfigPath,
    [string]$BackupDir,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { exit 0 }
$raw = [IO.File]::ReadAllText($ConfigPath)
$json = $raw | ConvertFrom-Json
$servers = $json.PSObject.Properties['mcpServers']
if (-not $servers -or -not $servers.Value.PSObject.Properties['nexus-browser']) { exit 0 }
if ($CheckOnly) {
    Write-Host "Doublon : nexus-browser est declare dans $ConfigPath ET par le plugin d'Antigravity (outils en double) : relancer install.ps1"
    exit 1
}
if (-not $BackupDir) { throw '-BackupDir est obligatoire pour retirer le doublon' }
New-Item -ItemType Directory -Force $BackupDir | Out-Null
$backup = Join-Path $BackupDir ('gemini-mcp_config-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')
[IO.File]::WriteAllText($backup, $raw, [Text.UTF8Encoding]::new($false))
$servers.Value.PSObject.Properties.Remove('nexus-browser')
$temporary = "$ConfigPath.nexus-browser.tmp"
[IO.File]::WriteAllText($temporary, ($json | ConvertTo-Json -Depth 100), [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporary -Destination $ConfigPath -Force
Write-Host "Antigravity : entree nexus-browser retiree de $ConfigPath (le plugin la declare ; sauvegarde : $backup)."
exit 0
