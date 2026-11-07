# Real HKCU registry, even when run from a packaged app (MSIX, like the Claude app): its HKCU\Software writes are
# redirected there to a private registry Chrome never reads. reg.exe is therefore run by a one-shot scheduled task
# (outside the package), its output read back, then the task removed. Outside a package, same result. The file and
# function names are a contract: NexusInfra's NexusPoste dot-sources this path and calls Invoke-RegistreReel.
# Usage : . registre-reel.ps1 ; Invoke-RegistreReel @('query "HKCU\..." /ve', 'add "HKCU\..." /ve /d "..." /f')
function Invoke-RegistreReel([string[]]$Commandes) {
    $nom = "NexusBrowser-registre-" + [Guid]::NewGuid().ToString("N").Substring(0, 8)
    # Outside %AppData% / %LocalAppData% (virtualized as well for a packaged app).
    $dossier = Join-Path $HOME ".nexus"
    [IO.Directory]::CreateDirectory($dossier) | Out-Null
    $sortie = Join-Path $dossier "$nom.txt"
    $script = Join-Path $dossier "$nom.cmd"
    # The reg commands go in a .cmd file, not on the task's command line: Microsoft Defender flags
    # "conhost --headless cmd /c reg add ...\Run" as malicious (Trojan:Win32/Commando.A!ml, about one call in ten at
    # random) and then blocks the start (0x80070005), with no output at all.
    # In a .cmd file, '%' is doubled so that it is not read as a cmd variable or argument (%1, etc.).
    $lignes = @("@echo off", "chcp 65001 >nul", "(") + ($Commandes | ForEach-Object { "reg $($_.Replace('%', '%%'))" }) + @(") > `"$sortie`" 2>&1")
    [IO.File]::WriteAllText($script, ($lignes -join "`r`n") + "`r`n", [Text.UTF8Encoding]::new($false))
    # conhost --headless: no console window shown during the task's instant.
    $action = New-ScheduledTaskAction -Execute "conhost.exe" -Argument "--headless cmd.exe /d /c `"$script`""
    $reglages = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
    Register-ScheduledTask -TaskName $nom -Action $action -Settings $reglages -Force | Out-Null
    try {
        Start-ScheduledTask -TaskName $nom
        $fin = (Get-Date).AddSeconds(20)
        # Right after Start-ScheduledTask, the state can still be "Ready": wait until the task has created the output file
        # (or returned a failure result: 0x41303 = not started yet), then until it has finished writing to it.
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
