# Release package of one architecture: NexusBrowser-<rid>.zip, what get.ps1 unpacks into %LOCALAPPDATA%\NexusBrowser\app.
# engine\ (self-contained single-file NexusBrowser.exe, no .NET needed), extension\, the installer and its scripts, the
# Antigravity plugin and the skill, native\resources\bridge_config.json (extension IDs). No sources, no tests.
# -Mcpb: also the Claude Desktop extension nexus-browser.mcpb (server type binary: this engine, --mcp), packed by the
# official mcpb CLI (Node). Used by the release workflow and the Install CI; outputs outside the repository.
param([Parameter(Mandatory = $true)][ValidateSet('win-x64', 'win-arm64')][string]$Runtime,
    [Parameter(Mandatory = $true)][string]$OutDir, [switch]$Mcpb)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime.ps1')
$version = (Get-Content (Join-Path $repositoryRoot 'VERSION') -Raw).Trim()
$work = Join-Path $buildRoot "package\$Runtime"
if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
$stage = Join-Path $work 'app'
& (Join-Path $PSScriptRoot 'build-native.ps1') -OutputDirectory (Join-Path $stage 'engine') -Runtime $Runtime
foreach ($item in 'extension', 'plugins', 'skills', 'install.ps1', 'get.ps1', 'verify.ps1', 'VERSION', 'LICENSE', 'README.md', 'CHANGELOG.md') {
    Copy-Item -LiteralPath (Join-Path $repositoryRoot $item) -Destination $stage -Recurse
}
New-Item -ItemType Directory -Force (Join-Path $stage 'scripts'), (Join-Path $stage 'native\resources') | Out-Null
Get-ChildItem -LiteralPath $PSScriptRoot -Filter *.ps1 | Where-Object Name -notin 'package-release.ps1', 'build-native.ps1' |
    Copy-Item -Destination (Join-Path $stage 'scripts')
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'native\resources\bridge_config.json') -Destination (Join-Path $stage 'native\resources')
New-Item -ItemType Directory -Force $OutDir | Out-Null
$zip = Join-Path ([IO.Path]::GetFullPath($OutDir)) "NexusBrowser-$Runtime.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
Write-Output $zip

if ($Mcpb) {
    $bundle = Join-Path $work 'mcpb'
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'mcpb') -Destination $bundle -Recurse
    $manifest = Get-Content (Join-Path $bundle 'manifest.json') -Raw | ConvertFrom-Json
    if ($manifest.version -ne $version) { throw "mcpb/manifest.json is $($manifest.version), VERSION is $version." }
    New-Item -ItemType Directory -Force (Join-Path $bundle 'server') | Out-Null
    Copy-Item -LiteralPath (Join-Path $stage 'engine\NexusBrowser.exe') -Destination (Join-Path $bundle 'server')
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'native\THIRD-PARTY-NOTICES.txt') -Destination (Join-Path $bundle 'server')
    $out = Join-Path ([IO.Path]::GetFullPath($OutDir)) 'nexus-browser.mcpb'
    & npx --yes '@anthropic-ai/mcpb@2.1.2' pack $bundle $out
    if ($LASTEXITCODE) { throw 'mcpb pack failed.' }
    Write-Output $out
}
