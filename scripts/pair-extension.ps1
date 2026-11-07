param([string]$ExtensionId = '', [switch]$Print)
# Pairing of the extension with the local bridge, without a native host (native\BridgePairing.cs): for an installation
# where the native host com.nexus.browser_auth cannot be declared to Chrome (Microsoft Store app, virtualized HKCU
# key). Asks the bridge for an offer (256-bit secret, single use, 5 minutes) with the bridge token, then opens
# chrome-extension://<id>/pair.html#<secret> in Chrome: the page pairs the extension and clears the secret from its
# address. -Print: shows the secret instead of opening Chrome (to paste in the popup's "Pair with a code" page).
# Not needed once the native host is installed.
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

# The Chrome Web Store extension once published (store_public), otherwise the unpacked extension (fixed ID).
if (-not $ExtensionId) {
    $config = Get-Content (Join-Path $root 'native\resources\bridge_config.json') -Raw | ConvertFrom-Json
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
