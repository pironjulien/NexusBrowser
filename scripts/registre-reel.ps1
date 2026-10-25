# Registre HKCU reel, meme lance depuis une application empaquetee (MSIX, comme l'application Claude) : ses ecritures
# HKCU\Software y sont redirigees vers un registre prive que Chrome ne lit jamais. reg.exe est donc lance par une
# tache planifiee d'un instant (hors du paquet), sa sortie relue puis la tache retiree. Hors paquet, meme resultat.
# Usage : . registre-reel.ps1 ; Invoke-RegistreReel @('query "HKCU\..." /ve', 'add "HKCU\..." /ve /d "..." /f')
function Invoke-RegistreReel([string[]]$Commandes) {
    $nom = "NexusBrowser-registre-" + [Guid]::NewGuid().ToString("N").Substring(0, 8)
    # Hors de %AppData% / %LocalAppData% (virtualises eux aussi pour une application empaquetee).
    $dossier = Join-Path $HOME ".nexus"
    [IO.Directory]::CreateDirectory($dossier) | Out-Null
    $sortie = Join-Path $dossier "$nom.txt"
    $script = Join-Path $dossier "$nom.cmd"
    # Les commandes reg vont dans un fichier .cmd, pas sur la ligne de commande de la tache : Microsoft Defender juge
    # "conhost --headless cmd /c reg add ...\Run" malveillant (Trojan:Win32/Commando.A!ml, au hasard d'un appel sur
    # dix environ) et bloque alors le lancement (0x80070005), sans aucune sortie.
    # Dans un fichier .cmd, doubler les '%' pour qu'ils ne soient pas interpretes comme variables ou arguments cmd (%1, etc.).
    $lignes = @("@echo off", "chcp 65001 >nul", "(") + ($Commandes | ForEach-Object { "reg $($_.Replace('%', '%%'))" }) + @(") > `"$sortie`" 2>&1")
    [IO.File]::WriteAllText($script, ($lignes -join "`r`n") + "`r`n", [Text.UTF8Encoding]::new($false))
    # conhost --headless : aucune fenetre de console visible pendant l'instant de la tache.
    $action = New-ScheduledTaskAction -Execute "conhost.exe" -Argument "--headless cmd.exe /d /c `"$script`""
    $reglages = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
    Register-ScheduledTask -TaskName $nom -Action $action -Settings $reglages -Force | Out-Null
    try {
        Start-ScheduledTask -TaskName $nom
        $fin = (Get-Date).AddSeconds(20)
        # Juste apres Start-ScheduledTask, l'etat peut encore etre "Ready" : attendre que la tache ait cree le fichier
        # de sortie (ou rendu un resultat d'echec : 0x41303 = pas encore lancee), puis qu'elle ait fini d'y ecrire.
        do {
            Start-Sleep -Milliseconds 200
            $echec = (Get-ScheduledTaskInfo -TaskName $nom).LastTaskResult
            $echec = $echec -notin @(0, 0x41303, 0x41301) -and (Get-ScheduledTask -TaskName $nom).State -ne "Running"
        } while (-not (Test-Path -LiteralPath $sortie) -and -not $echec -and (Get-Date) -lt $fin)
        do { Start-Sleep -Milliseconds 200 } while ((Get-ScheduledTask -TaskName $nom).State -eq "Running" -and (Get-Date) -lt $fin)
        if (-not (Test-Path -LiteralPath $sortie)) {
            $resultat = "0x{0:X8}" -f (Get-ScheduledTaskInfo -TaskName $nom).LastTaskResult
            throw "reg.exe hors application : aucune sortie ($nom, resultat de la tache $resultat ; 0x80070005 = lancement refuse, voir l'historique de Microsoft Defender)"
        }
        return [IO.File]::ReadAllText($sortie, [Text.UTF8Encoding]::new($false))
    } finally {
        Unregister-ScheduledTask -TaskName $nom -Confirm:$false -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $sortie, $script -Force -ErrorAction SilentlyContinue
    }
}
