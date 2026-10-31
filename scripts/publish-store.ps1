# Sends the extension of a stable release to the Chrome Web Store and submits it for review, on request only (GitHub
# never sends it). The zip is the one attached to the release (nexus-browser-extension-<version>.zip), checked against
# the release's SHA256SUMS.txt. The token comes from gcloud as the cws-publisher service account, impersonated by the
# Google account signed in to gcloud that has roles/iam.serviceAccountTokenCreator on it (-Account, else each signed-in
# account in turn): no key or secret is stored.
# Says plainly when the store already has this version, or when an earlier submission is still in review.
# Usage: pwsh -NoProfile -File scripts\publish-store.ps1 [-Tag vX.Y.Z] [-Account <gcloud account>]
#        (default: the latest stable release)
param([ValidatePattern('^v\d+\.\d+\.\d+$')] [string]$Tag, [string]$Account)
$ErrorActionPreference = 'Stop'
$repository = 'pironjulien/NexusBrowser'
$item = 'fjapmaccbgdfneoccclmlpgknbbfkaco'
$publisher = 'cws-publisher@antigravity-493509.iam.gserviceaccount.com'

if (-not $Tag) {
    $Tag = gh release view -R $repository --json tagName -q .tagName
    if ($LASTEXITCODE -or $Tag -notmatch '^v\d+\.\d+\.\d+$') { throw "No stable release found ($Tag)." }
}
$work = Join-Path $HOME ".nexus\build\nexus-browser\store-publish\$Tag"
if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
New-Item -ItemType Directory -Force $work | Out-Null
try {
    gh release download $Tag -R $repository -p 'nexus-browser-extension-*.zip' -p 'SHA256SUMS.txt' -D $work
    if ($LASTEXITCODE) { throw "Release ${Tag}: download failed." }
    $zips = @(Get-ChildItem -LiteralPath $work -Filter 'nexus-browser-extension-*.zip')
    if ($zips.Count -ne 1) { throw "Release ${Tag}: one extension zip expected, found $($zips.Count)." }
    $zip = $zips[0]
    $hash = (Get-FileHash -LiteralPath $zip.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $listed = Get-Content -LiteralPath (Join-Path $work 'SHA256SUMS.txt') | Where-Object { $_ -match "^$hash\s+\*?$([regex]::Escape($zip.Name))$" }
    if (-not $listed) { throw "$($zip.Name) differs from the release's SHA256SUMS.txt." }

    $accounts = if ($Account) { @($Account) } else { @(gcloud auth list --format='value(account)' 2>$null) }
    $token = $null
    foreach ($candidate in $accounts) {
        $token = gcloud auth print-access-token --account=$candidate --impersonate-service-account=$publisher --scopes=https://www.googleapis.com/auth/chromewebstore 2>$null
        if (-not $LASTEXITCODE -and $token) { break }
        $token = $null
    }
    if (-not $token) { throw "No gcloud account may act as $publisher (gcloud auth login with the store's account, which has the tokenCreator role)." }
    $headers = @{ Authorization = "Bearer $token"; 'x-goog-api-version' = '2' }

    Write-Host "Sending $($zip.Name) ($Tag) to the Chrome Web Store..."
    $upload = Invoke-RestMethod -Method Put -Uri "https://www.googleapis.com/upload/chromewebstore/v1.1/items/$item" -Headers $headers -InFile $zip.FullName -ContentType 'application/zip'
    if ($upload.uploadState -notin 'SUCCESS', 'IN_PROGRESS') {
        $details = @($upload.itemError | ForEach-Object { $_.error_detail }) -join ' | '
        if ($details -match '(?i)pending review|ready to publish') {
            Write-Host "Not sent: an earlier version is still in Google's review. Send $Tag again once it is published." -ForegroundColor Yellow
            return
        }
        if ($details -match '(?i)version') {
            Write-Host "Not sent: the store already has this extension version (only the engine changed in $Tag)." -ForegroundColor Yellow
            return
        }
        throw "Upload refused: $details"
    }
    $publish = Invoke-RestMethod -Method Post -Uri "https://www.googleapis.com/chromewebstore/v1.1/items/$item/publish" -Headers $headers -Body ''
    $status = @($publish.status)
    if (-not ($status | Where-Object { $_ -match 'OK|PENDING_REVIEW' })) { throw "Submission refused: $($status -join ', ') $(@($publish.statusDetail) -join ' | ')" }
    Write-Host "$($zip.Name) submitted for review ($($status -join ', ')): Google decides when users get it." -ForegroundColor Green
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
