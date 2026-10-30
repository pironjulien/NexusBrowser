# Mise a jour de NexusBrowser par lui-meme (contrat commun des produits Nexus), lancee par la tache
# "Nexus Browser Update" (sans declencheur) que le pont demarre sur POST /api/update : hors du pont, qu'elle survit a
# arreter, et hors du conteneur d'une application du Microsoft Store. Installation publique seulement
# (%LOCALAPPDATA%\NexusBrowser\app). Etat dans ~\.nexus\status\browser.json (moteur natif, BridgeServer), journal
# dans ~\.nexus\nexus-browser\update.log. Des onglets pilotes par un agent : rien n'est touche, essai suivant plus tard.
# Un echec garde la version en cours et l'ecrit dans "message". Fichier en ASCII (Windows PowerShell 5.1).
$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent $PSScriptRoot
$statusDir = if ($env:NEXUS_STATUS_DIR) { $env:NEXUS_STATUS_DIR } else { Join-Path $HOME '.nexus\status' }
$statusFile = Join-Path $statusDir 'browser.json'
$log = Join-Path $HOME '.nexus\nexus-browser\update.log'
$utf8 = New-Object Text.UTF8Encoding $false

function Set-Status([string]$State, [string]$Message, [string]$Version = '') {
    $status = [ordered]@{}
    if (Test-Path -LiteralPath $statusFile) {
        try {
            (Get-Content -LiteralPath $statusFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $status[$_.Name] = $_.Value }
        } catch { }
    }
    $status['product'] = 'browser'
    $status['state'] = $State
    $status['message'] = $Message
    if ($Version) { $status['version'] = $Version }
    New-Item -ItemType Directory -Force $statusDir | Out-Null
    $temporary = "$statusFile.$PID.tmp"
    [IO.File]::WriteAllText($temporary, ($status | ConvertTo-Json), $utf8)
    Move-Item -LiteralPath $temporary -Destination $statusFile -Force
}

function Write-Log([string]$Text) {
    New-Item -ItemType Directory -Force (Split-Path -Parent $log) | Out-Null
    [IO.File]::AppendAllText($log, (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Text + [Environment]::NewLine, $utf8)
}

try {
    . (Join-Path $PSScriptRoot 'runtime.ps1')
    Write-Log "Update started from $app."
    if ($nativeExe) {
        if ((Invoke-Native $nativeExe @('--refresh-extension', '--check-only') 60).Code -eq 3) {
            Set-Status 'failed' 'Update deferred: an agent is working in Chrome. Try again later; the current version is kept.'
            Write-Log 'Deferred: agent tabs in use.'
            exit 0
        }
    }
    # get.ps1 recopie le dossier de l'application (celui-ci compris) : il tourne depuis une copie, par -File.
    $get = Join-Path $env:TEMP "nexus-browser-get-$PID.ps1"
    Copy-Item -LiteralPath (Join-Path $app 'get.ps1') -Destination $get -Force
    $env:NEXUS_PACK = '1'
    # Sorties de l'installeur (stderr compris) gardees dans le journal en UTF-8 : sous
    # Windows PowerShell 5.1, une redirection de stderr avec 'Stop' ferait de chaque avertissement une erreur fatale.
    $ErrorActionPreference = 'Continue'
    $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $get 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    [IO.File]::AppendAllText($log, (($output | Out-String).TrimEnd()) + [Environment]::NewLine, $utf8)
    Remove-Item -LiteralPath $get -Force -ErrorAction SilentlyContinue
    if ($code) {
        Set-Status 'failed' "Update failed (exit code $code), see $log."
        Write-Log "Failed: exit code $code."
        exit 1
    }
    $version = (Get-Content -LiteralPath (Join-Path $app 'VERSION') -Raw).Trim()
    Set-Status 'done' "Updated to $version." $version
    Write-Log "Updated to $version."
} catch {
    Set-Status 'failed' "Update failed: $($_.Exception.Message)"
    Write-Log "Failed: $($_.Exception.Message)"
    exit 1
}
