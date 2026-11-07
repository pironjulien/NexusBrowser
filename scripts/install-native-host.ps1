param([Parameter(Mandatory = $true)][string]$Exe, [switch]$CheckOnly, [string]$ConfigurationRoot,
    [string]$RegistryKey = "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.nexus.browser_auth")
# Native host com.nexus.browser_auth: the Chrome extension has the engine (NexusBrowser.exe, started by Chrome)
# compute the local bridge's authentication proofs (HMAC of the ~/.nexus/nexus-browser/bridge-token token); the token
# is never handed to Chrome. Declared for the current user only (HKCU), for the extension IDs of
# native\resources\bridge_config.json. Manifest outside OneDrive. ASCII file (Windows PowerShell 5.1).
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime.ps1")
# Key written and read back in the real registry (registre-reel.ps1): from the Claude app (MSIX), a direct write went
# to its private registry and Chrome did not find the native host ("native messaging host not found").
. (Join-Path $PSScriptRoot "registre-reel.ps1")
$hostName = "com.nexus.browser_auth"
$hostDirectory = Join-Path $localRoot "native-host"
$manifestPath = Join-Path $hostDirectory "$hostName.json"
$oldLauncher = Join-Path $hostDirectory "nexus_browser_auth.cmd"  # lanceur Python d'avant la 2.33.0
$utf8 = New-Object Text.UTF8Encoding $false

$configuration = if ($ConfigurationRoot) { $ConfigurationRoot } else { $repositoryRoot }
$origins = @((Get-Content (Join-Path $configuration "native\resources\bridge_config.json") -Raw | ConvertFrom-Json).allowed_origins)
if (-not $origins) { throw "Aucune origine d'extension dans native\resources\bridge_config.json" }
# Chrome passes its extension origin to the executable; the engine detects native-messaging mode.
$manifestText = ([ordered]@{
    name = $hostName
    description = "NexusBrowser : preuves d'authentification du pont local (jeton jamais livre a Chrome)"
    path = $Exe
    type = "stdio"
    allowed_origins = $origins
} | ConvertTo-Json -Depth 4) + "`n"

if ($CheckOnly) {
    $registered = Get-RegistreReel $RegistryKey
    if ($registered -ne $manifestPath) { throw "Hote natif $hostName non declare a Chrome : reexecuter install.ps1" }
    # Compared by content: ConvertTo-Json formats differently under Windows PowerShell 5.1 and pwsh 7.
    $canonical = { param($text) $text | ConvertFrom-Json | ConvertTo-Json -Depth 4 -Compress }
    $aligned = (Test-Path -LiteralPath $manifestPath) -and
        ((& $canonical ([IO.File]::ReadAllText($manifestPath, $utf8))) -ceq (& $canonical $manifestText))
    if (-not $aligned) { throw "Hote natif $hostName non aligne ($manifestPath) : reexecuter install.ps1" }
    Write-Host "Hote natif $hostName : OK."
    return
}

if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) { throw "Moteur natif absent ($Exe) : executer install.ps1" }
[IO.Directory]::CreateDirectory($hostDirectory) | Out-Null
[IO.File]::WriteAllText($manifestPath, $manifestText, $utf8)
if (Test-Path -LiteralPath $oldLauncher) { Remove-Item -LiteralPath $oldLauncher -Force }
$registered = Set-RegistreReel $RegistryKey $manifestPath
if ($registered -ne $manifestPath) { throw "Hote natif $hostName : cle du registre non ecrite ($registered)" }
Write-Host "Hote natif $hostName declare a Chrome ($manifestPath -> $Exe)."
