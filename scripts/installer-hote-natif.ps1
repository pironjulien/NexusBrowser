param([switch]$CheckOnly, [string]$RegistryKey = "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.nexus.browser_auth")
# Hote natif com.nexus.browser_auth : l'extension Chrome lui fait calculer les preuves d'authentification du pont
# local (HMAC du jeton ~/.nexus/nexus-browser/bridge-token) ; le jeton n'est jamais livre a Chrome. Declare pour l'utilisateur
# courant seulement (HKCU), pour les identifiants d'extension de native-host\bridge_config.json. Fichiers hors OneDrive.
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "runtime.ps1")
# Cle ecrite et relue dans le registre reel (registre-reel.ps1) : depuis l'application Claude (MSIX), une ecriture
# directe partait dans son registre prive et Chrome ne trouvait pas l'hote natif ("native messaging host not found").
. (Join-Path $PSScriptRoot "registre-reel.ps1")
$hostName = "com.nexus.browser_auth"
$python = $pythonExe
$hostScript = Join-Path $repositoryRoot "native-host\auth_host.py"
$hostDirectory = Join-Path $localRoot "native-host"
$launcher = Join-Path $hostDirectory "nexus_browser_auth.cmd"
$manifestPath = Join-Path $hostDirectory "$hostName.json"
$utf8 = [Text.UTF8Encoding]::new($false)

$origins = @((Get-Content (Join-Path $repositoryRoot "native-host\bridge_config.json") -Raw | ConvertFrom-Json).allowed_origins)
if (-not $origins) { throw "Aucune origine d'extension dans native-host\bridge_config.json" }
# -I : ni variables PYTHON*, ni site utilisateur ; -B : aucun bytecode ecrit a cote des sources (OneDrive).
$launcherText = "@echo off`r`n`"$python`" -I -B `"$hostScript`" %*`r`n"
$manifestText = ([ordered]@{
    name = $hostName
    description = "NexusBrowser : preuves d'authentification du pont local (jeton jamais livre a Chrome)"
    path = $launcher
    type = "stdio"
    allowed_origins = $origins
} | ConvertTo-Json -Depth 4) + "`n"

if ($CheckOnly) {
    $registered = Invoke-RegistreReel @("query `"$RegistryKey`" /ve")
    if (-not $registered.Contains($manifestPath)) { throw "Hote natif $hostName non declare a Chrome : reexecuter install.ps1" }
    # Le manifeste est compare par son contenu : ConvertTo-Json ne met pas en forme pareil sous Windows PowerShell 5.1
    # et sous pwsh 7, et install.ps1 peut avoir tourne sous l'un ou l'autre.
    $canonical = { param($text) $text | ConvertFrom-Json | ConvertTo-Json -Depth 4 -Compress }
    foreach ($pair in @(@($launcher, $launcherText, $false), @($manifestPath, $manifestText, $true))) {
        $aligned = Test-Path -LiteralPath $pair[0]
        if ($aligned) {
            $current = [IO.File]::ReadAllText($pair[0], $utf8)
            $aligned = if ($pair[2]) { (& $canonical $current) -ceq (& $canonical $pair[1]) } else { $current -ceq $pair[1] }
        }
        if (-not $aligned) { throw "Hote natif $hostName non aligne ($($pair[0])) : reexecuter install.ps1" }
    }
    Write-Host "Hote natif $hostName : OK."
    return
}

if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw "Runtime local absent : executer install.ps1" }
[IO.Directory]::CreateDirectory($hostDirectory) | Out-Null
[IO.File]::WriteAllText($launcher, $launcherText, $utf8)
[IO.File]::WriteAllText($manifestPath, $manifestText, $utf8)
$registered = Invoke-RegistreReel @("add `"$RegistryKey`" /ve /t REG_SZ /d `"$manifestPath`" /f", "query `"$RegistryKey`" /ve")
if (-not $registered.Contains($manifestPath)) { throw "Hote natif $hostName : cle du registre non ecrite ($registered)" }
Write-Host "Hote natif $hostName declare a Chrome ($manifestPath)."
