# Registers the native messaging host "com.nexusagy.bridge_auth" for the current user (HKCU), so that the extension can
# have its authentication proofs computed without ever receiving the bridge token. Allowed extension origins are read
# from bridge_config.json. Run it again after changing bridge_config.json or moving the repository.
# Usage: pwsh -NoProfile -File native-host\install-native-host.ps1 [-Python <path to python.exe>] [-CheckOnly]
param([string]$Python = "", [switch]$CheckOnly)
$ErrorActionPreference = "Stop"
$hostName = "com.nexusagy.bridge_auth"
$registryKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
$hostScript = Join-Path $PSScriptRoot "auth_host.py"
$hostDirectory = Join-Path $env:USERPROFILE ".nexusagy\native-host"
$launcher = Join-Path $hostDirectory "nexusagy_bridge_auth.cmd"
$manifestPath = Join-Path $hostDirectory "$hostName.json"

if (-not $Python) { $Python = (Get-Command python.exe -ErrorAction SilentlyContinue).Source }
if (-not $Python -or -not (Test-Path -LiteralPath $Python -PathType Leaf)) { throw "python.exe not found: pass -Python <path>." }
$origins = @((Get-Content (Join-Path $PSScriptRoot "bridge_config.json") -Raw | ConvertFrom-Json).allowed_origins)
if (-not $origins) { throw "No extension origin in native-host\bridge_config.json." }

$utf8 = [Text.UTF8Encoding]::new($false)
# -I: ignore PYTHON* variables and the user site; -B: no bytecode written next to the sources.
$launcherText = "@echo off`r`n`"$Python`" -I -B `"$hostScript`" %*`r`n"
$manifestText = ([ordered]@{
    name = $hostName
    description = "Authentication proofs for the local Antigravity Browser Bridge (the token never reaches Chrome)"
    path = $launcher
    type = "stdio"
    allowed_origins = $origins
} | ConvertTo-Json -Depth 4) + "`n"

if ($CheckOnly) {
    $registered = (Get-ItemProperty -LiteralPath $registryKey -ErrorAction SilentlyContinue).'(default)'
    if ($registered -ne $manifestPath) { throw "$hostName is not registered with Chrome: run this script without -CheckOnly." }
    foreach ($pair in @(@($launcher, $launcherText), @($manifestPath, $manifestText))) {
        if (-not (Test-Path -LiteralPath $pair[0]) -or [IO.File]::ReadAllText($pair[0], $utf8) -cne $pair[1]) {
            throw "$hostName is out of date ($($pair[0])): run this script without -CheckOnly."
        }
    }
    Write-Host "$hostName : OK."
    return
}

[IO.Directory]::CreateDirectory($hostDirectory) | Out-Null
[IO.File]::WriteAllText($launcher, $launcherText, $utf8)
[IO.File]::WriteAllText($manifestPath, $manifestText, $utf8)
New-Item -Path $registryKey -Force | Out-Null
Set-Item -Path $registryKey -Value $manifestPath
Write-Host "$hostName registered with Chrome ($manifestPath). Reload the extension in chrome://extensions."
