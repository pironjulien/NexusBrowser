# Chrome Web Store package, built from the repository, nothing by hand (store/README.md).
#  - <OutDir>\nexus-browser-extension-<version>.zip: extension\ as Chrome loads it, the manifest's "key" removed (the
#    store signs the package with its own key and gives it its own ID; "key" only fixes the unpacked extension's ID).
#  - -WithoutGmailCounter: the same package without the optional Gmail unread counter (no checkbox in the popup, never
#    read, https://mail.google.com out of the CSP), ready in case the store objects to it (store/SINGLE_PURPOSE.md).
# Each change is checked: a variant that cannot be built is an error, never a silent copy. Prints the zip's path.
# Usage: pwsh -NoProfile -File scripts\store-package.ps1 [-OutDir <folder>] [-WithoutGmailCounter]
param([string]$OutDir, [switch]$WithoutGmailCounter)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$extension = Join-Path $root 'extension'
if (-not $OutDir) { $OutDir = Join-Path $HOME '.nexus\build\nexus-browser\store' }
$utf8 = New-Object Text.UTF8Encoding $false
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

$manifestText = [IO.File]::ReadAllText((Join-Path $extension 'manifest.json'), $utf8)
$manifest = $manifestText | ConvertFrom-Json
$manifest.PSObject.Properties.Remove('key')
if ($WithoutGmailCounter) {
    $policy = $manifest.content_security_policy.extension_pages
    $manifest.content_security_policy.extension_pages = $policy.Replace(' https://mail.google.com', '')
    if ($manifest.content_security_policy.extension_pages -eq $policy) { throw 'manifest.json: https://mail.google.com not found in the CSP, variant not built.' }
}
$suffix = if ($WithoutGmailCounter) { '-without-gmail-counter' } else { '' }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$target = Join-Path $OutDir "nexus-browser-extension-$($manifest.version)$suffix.zip"
if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target }

function Get-Variant([string]$Name, [string]$Text) {
    if ($Name -eq 'popup.html') {
        $changed = [regex]::Replace($Text, '\n[ \t]*<label class="option">\s*<input type="checkbox" id="compteur-gmail">.*?</label>', '', 'Singleline')
    } elseif ($Name -eq 'background.js') {
        $changed = $Text.Replace('const COMPTEUR_GMAIL_DISPONIBLE = true;', 'const COMPTEUR_GMAIL_DISPONIBLE = false;')
    } else { return $Text }
    if ($changed -ceq $Text) { throw "$($Name): the Gmail counter was not found, variant not built." }
    return $changed
}

$archive = [IO.Compression.ZipFile]::Open($target, [IO.Compression.ZipArchiveMode]::Create)
try {
    $files = Get-ChildItem -LiteralPath $extension -Recurse -File | ForEach-Object {
        [pscustomobject]@{ Path = $_.FullName; Name = $_.FullName.Substring($extension.Length + 1).Replace('\', '/') }
    } | Sort-Object Name
    foreach ($file in $files) {
        $entry = $archive.CreateEntry($file.Name, [IO.Compression.CompressionLevel]::Optimal)
        $stream = $entry.Open()
        try {
            if ($file.Name -eq 'manifest.json') {
                $bytes = $utf8.GetBytes(($manifest | ConvertTo-Json -Depth 20) + "`n")
            } elseif ($WithoutGmailCounter -and $file.Name -in 'popup.html', 'background.js') {
                $bytes = $utf8.GetBytes((Get-Variant $file.Name ([IO.File]::ReadAllText($file.Path, $utf8))))
            } else {
                $bytes = [IO.File]::ReadAllBytes($file.Path)
            }
            $stream.Write($bytes, 0, $bytes.Length)
        } finally { $stream.Dispose() }
    }
} finally { $archive.Dispose() }
Write-Output $target
