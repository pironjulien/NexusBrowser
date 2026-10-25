param([string]$ExtensionId = '', [switch]$Print)
# Appairage de l'extension au pont local, sans hote natif (native-host/bridge_pairing.py) : pour une installation ou
# l'hote natif com.nexus.browser_auth ne peut pas etre declare a Chrome (application du Microsoft Store, cle HKCU
# virtualisee). Demande au pont une offre (secret de 256 bits, usage unique, 5 minutes) avec le jeton du pont, puis
# ouvre chrome-extension://<id>/pair.html#<secret> dans Chrome : la page appaire l'extension et efface le secret de
# son adresse. -Print : affiche le secret au lieu d'ouvrir Chrome (a coller dans la page "Appairer avec un code" de
# la fenetre de l'icone). Messages en anglais (installation publique). Avec l'hote natif installe, inutile.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$tokenFile = if ($env:NEXUS_BROWSER_TOKEN_FILE) { $env:NEXUS_BROWSER_TOKEN_FILE } else { Join-Path $HOME '.nexus\nexus-browser\bridge-token' }
if (-not (Test-Path -LiteralPath $tokenFile)) { throw 'NexusBrowser bridge token not found: install NexusBrowser first.' }
$token = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
try {
    $offer = Invoke-RestMethod -UseBasicParsing -Method Post -Uri 'http://127.0.0.1:9225/api/pair' -Headers @{ 'X-Nexus-Browser-Token' = $token }
} catch {
    throw "The NexusBrowser bridge does not answer on 127.0.0.1:9225 ($($_.Exception.Message)): start it, then run this again."
}
if ($Print) {
    Write-Host "Pairing code (single use, valid $($offer.expires_in_s) s):"
    Write-Output $offer.secret
    return
}

# Extension du Chrome Web Store une fois publiee (store_public), sinon l'extension non empaquetee (identifiant fixe).
if (-not $ExtensionId) {
    $config = Get-Content (Join-Path $root 'native-host\bridge_config.json') -Raw | ConvertFrom-Json
    $ExtensionId = if ($config.store_public) { $config.store_id } else { ([string]$config.allowed_origins[0]) -replace '^chrome-extension://([a-p]{32})/?$', '$1' }
}
if ($ExtensionId -notmatch '^[a-p]{32}$') { throw "Invalid extension ID: $ExtensionId" }

$chrome = $null
foreach ($key in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe')) {
    $path = (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).'(default)'
    if ($path -and (Test-Path -LiteralPath $path)) { $chrome = $path; break }
}
if (-not $chrome) { throw 'Google Chrome was not found.' }
Start-Process -FilePath $chrome -ArgumentList "chrome-extension://$ExtensionId/pair.html#$($offer.secret)"
Write-Host 'Chrome shows "Extension paired" when it is done (the code is single use and expires in 5 minutes).'
