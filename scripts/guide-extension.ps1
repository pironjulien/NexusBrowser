param([int]$WaitSeconds = 300)
# Guide for the only manual step of the public installation (install.ps1 -Register): loading the extension in Chrome.
# Chrome installs an extension from outside the Chrome Web Store only by "Load unpacked" (developer mode): the
# folder is copied to the clipboard, chrome://extensions opened, then the script waits for the extension to join the
# bridge (WaitSeconds, 0 = no wait). Its name is a contract: NexusSystem's app and get-nexus.ps1 run it by this path.
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

# Extension already linked to the bridge (update, or reinstallation by an AI): nothing to add, otherwise Chrome ends
# up with two copies (Web Store and unpacked). Codes: 0 up to date, 1 behind, 3 busy, 2 missing.
$exe = Get-CurrentExe
if ($exe -and (Invoke-Native $exe @('--refresh-extension', '--wait-ready', '3') 30).Code -in 0, 1, 3) {
    Write-Host ''
    Write-Host 'The NexusBrowser extension is already in Chrome and connected: nothing to add.' -ForegroundColor Green
    return
}

# Published on the Chrome Web Store (store_public of bridge_config.json): "Add to Chrome", no developer mode.
$config = Get-Content (Join-Path $repositoryRoot 'native\resources\bridge_config.json') -Raw | ConvertFrom-Json
$storeId = if ($config.store_public) { $config.store_id } else { $null }
# The store serves the version Google approved, often several versions behind during review: when it has less than
# this installation, the unpacked extension is kept (otherwise two copies of different ages).
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
