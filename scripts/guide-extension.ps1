param([int]$WaitSeconds = 300)
# Guide du seul geste manuel de l'installation publique (install.ps1 -Register) : charger l'extension dans Chrome.
# Chrome n'installe une extension hors Chrome Web Store que par "Charger l'extension non empaquetee" (mode
# developpeur) : le dossier est copie dans le presse-papiers, chrome://extensions ouvert, puis on attend que
# l'extension rejoigne le pont (WaitSeconds, 0 = sans attendre). Messages en anglais (installation publique).
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime.ps1')
$extension = Join-Path $repositoryRoot 'extension'

$chrome = $null
foreach ($key in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe')) {
    $path = (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).'(default)'
    if ($path -and (Test-Path -LiteralPath $path)) { $chrome = $path; break }
}
if (-not $chrome) {
    Write-Host ''
    Write-Host 'Google Chrome was not found. Install it from https://www.google.com/chrome/ and run the installer again.' -ForegroundColor Yellow
    return
}

# Extension deja reliee au pont (mise a jour, ou reinstallation par une IA) : rien a ajouter, sinon Chrome se
# retrouve avec deux copies (Web Store et non empaquetee). Codes : 0 a jour, 1 en retard, 3 occupee, 2 absente.
$exe = Get-CurrentExe
if ($exe -and (Invoke-Native $exe @('--refresh-extension', '--wait-ready', '3') 30).Code -in 0, 1, 3) {
    Write-Host ''
    Write-Host 'The NexusBrowser extension is already in Chrome and connected: nothing to add.' -ForegroundColor Green
    return
}

# Publiee sur le Chrome Web Store (store_public de bridge_config.json) : "Ajouter a Chrome", sans mode developpeur.
$config = Get-Content (Join-Path $repositoryRoot 'native\resources\bridge_config.json') -Raw | ConvertFrom-Json
$storeId = if ($config.store_public) { $config.store_id } else { $null }
# Le Store sert la version que Google a validee, souvent en retard de plusieurs versions pendant la relecture : s'il
# a moins que cette installation, on garde l'extension non empaquetee (sinon deux copies d'ages differents).
if ($storeId) {
    $local = [version](Get-Content (Join-Path $extension 'manifest.json') -Raw | ConvertFrom-Json).version
    try {
        $check = "https://clients2.google.com/service/update2/crx?response=updatecheck&acceptformat=crx3&prodversion=$((Get-Item $chrome).VersionInfo.ProductVersion)&x=id%3D$storeId%26uc"
        $served = [regex]::Match((Invoke-WebRequest $check -UseBasicParsing -TimeoutSec 15).Content, 'version="(\d+(?:\.\d+){1,3})"').Groups[1].Value
        if (-not $served -or [version]$served -lt $local) { $storeId = $null }
    } catch { $storeId = $null }
}
Write-Host ''
Write-Host 'Last step, once: add the NexusBrowser extension to Chrome.' -ForegroundColor Cyan
if ($storeId) {
    $page = "https://chromewebstore.google.com/detail/$storeId"
    Start-Process -FilePath $chrome -ArgumentList $page
    Write-Host '  In the Chrome Web Store tab that just opened, click "Add to Chrome", then "Add extension".'
    Write-Host "  (Tab not opened? Go to $page)"
} else {
    try { Set-Clipboard -Value $extension; $copied = ' (already copied: paste it with Ctrl+V)' } catch { $copied = '' }
    Start-Process -FilePath $chrome -ArgumentList 'chrome://extensions/'
    Write-Host '  1. In the Chrome tab that just opened (chrome://extensions), turn on "Developer mode" (top right).'
    Write-Host '  2. Click "Load unpacked".'
    Write-Host "  3. Choose this folder$copied, then click ""Select Folder"":"
    Write-Host "     $extension"
    Write-Host '  (Tab not opened? Type chrome://extensions in the Chrome address bar.)'
}

if ($WaitSeconds -le 0) { return }
Write-Host ''
Write-Host 'Waiting for the extension... (Ctrl+C to stop waiting; it connects by itself later)'
$deadline = (Get-Date).AddSeconds($WaitSeconds)
do {
    $exe = Get-CurrentExe
    if (-not $exe) { break }
    if ((Invoke-Native $exe @('--refresh-extension', '--wait-ready', '30') 90).Code -eq 0) {
        Write-Host 'Extension connected: NexusBrowser is ready. Restart your AI app (Claude, Codex or Antigravity) to see its browser tools.' -ForegroundColor Green
        return
    }
} while ((Get-Date) -lt $deadline)
Write-Host 'The extension is not connected yet. Once it is loaded, it connects by itself: nothing else to run.' -ForegroundColor Yellow
