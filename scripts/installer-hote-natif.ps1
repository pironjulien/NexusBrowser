param([Parameter(Mandatory = $true)][string]$Exe, [switch]$CheckOnly, [string]$ConfigurationRoot,
    [string]$RegistryKey = "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.nexus.browser_auth")
# Hote natif com.nexus.browser_auth : l'extension Chrome fait calculer au moteur (NexusBrowser.exe, lance par Chrome)
# les preuves d'authentification du pont local (HMAC du jeton ~/.nexus/nexus-browser/bridge-token) ; le jeton n'est
# jamais livre a Chrome. Declare pour l'utilisateur courant seulement (HKCU), pour les identifiants d'extension de
# native\resources\bridge_config.json. Manifeste hors OneDrive. Fichier en ASCII (Windows PowerShell 5.1).
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime.ps1")
# Cle ecrite et relue dans le registre reel (registre-reel.ps1) : depuis l'application Claude (MSIX), une ecriture
# directe partait dans son registre prive et Chrome ne trouvait pas l'hote natif ("native messaging host not found").
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
    $registered = Invoke-RegistreReel @("query `"$RegistryKey`" /ve")
    if (-not $registered.Contains($manifestPath)) { throw "Hote natif $hostName non declare a Chrome : reexecuter install.ps1" }
    # Compare par le contenu : ConvertTo-Json ne met pas en forme pareil sous Windows PowerShell 5.1 et sous pwsh 7.
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
$registered = Invoke-RegistreReel @("add `"$RegistryKey`" /ve /t REG_SZ /d `"$manifestPath`" /f", "query `"$RegistryKey`" /ve")
if (-not $registered.Contains($manifestPath)) { throw "Hote natif $hostName : cle du registre non ecrite ($registered)" }
Write-Host "Hote natif $hostName declare a Chrome ($manifestPath -> $Exe)."
