# Antigravity : nexus-browser déclaré UNE seule fois, par son plugin (~\.gemini\config\plugins\nexus-browser).
# Une entrée nexus-browser en plus dans ~\.gemini\config\mcp_config.json lance un second serveur : outils en double
# (nexus-browser_nexus-browser), tokens perdus. Ce script retire cette seule entrée (les autres serveurs et réglages
# restent tels quels), après une sauvegarde hors OneDrive, par écriture atomique (fichier temporaire puis remplacement).
#  -CheckOnly : n'écrit rien ; code 1 et message si le doublon est présent (verify.ps1).
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
    Write-Host "Doublon : nexus-browser est déclaré dans $ConfigPath ET par le plugin d'Antigravity (outils en double) : relancer install.ps1"
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
Write-Host "Antigravity : entrée nexus-browser retirée de $ConfigPath (le plugin la déclare ; sauvegarde : $backup)."
exit 0
