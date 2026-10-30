# Bind a rollback to the exact prior payload observed before the update. No script from that payload is executed.
param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'
$resolved = (Resolve-Path -LiteralPath $Path).Path.TrimEnd('\')
if ((Get-Item -LiteralPath $resolved -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Payload root must not be a reparse point.' }
$items = @(Get-ChildItem -LiteralPath $resolved -Force -Recurse)
if ($items | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Rollback payload contains a reparse point.' }
$manifest = @($items | Where-Object { -not $_.PSIsContainer } | Sort-Object FullName | ForEach-Object {
    $relative = $_.FullName.Substring($resolved.Length + 1).Replace('\', '/')
    $stream = [IO.File]::OpenRead($_.FullName)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose(); $stream.Dispose() }
    $relative + ':' + $hash
}) -join "`n"
$digest = [Security.Cryptography.SHA256]::Create()
try { ([BitConverter]::ToString($digest.ComputeHash([Text.Encoding]::UTF8.GetBytes($manifest)))).Replace('-', '').ToLowerInvariant() }
finally { $digest.Dispose() }
