# Empreinte de l'installation de NexusBrowser : une seule formule, écrite par install.ps1 dans installed.stamp et
# recalculée par Sync-NexusPoste (NexusInfra) pour savoir s'il faut réinstaller. Tout fichier dont dépend
# l'installation y entre : dépendances (uv.lock), install.ps1, l'hôte natif (installer-hote-natif.ps1) et
# l'environnement local (runtime.ps1).
$root = Split-Path -Parent $PSScriptRoot
$files = 'uv.lock', 'install.ps1', 'scripts\installer-hote-natif.ps1', 'scripts\runtime.ps1'
($files | ForEach-Object { (Get-FileHash (Join-Path $root $_)).Hash }) -join ' '
