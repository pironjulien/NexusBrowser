# Real HKCU registry, even when run from a packaged app (MSIX): there, HKCU\Software writes are redirected to a private
# registry Chrome never reads. Outside a package (the usual case: NexusSystem maintenance, the workstation sync started
# by WMI, a terminal), the .NET registry API is used in this very process: no external program at all. Inside a package,
# this same file runs once outside it, in a one-shot scheduled task (powershell.exe -File, never cmd.exe nor reg.exe),
# its JSON answer read back, then the task removed.
# Why no reg.exe: "conhost --headless cmd /c reg add|delete ...\Run" looks like a persistence trick to Microsoft
# Defender's cloud heuristics (Trojan:Win32/Commando.A!ml once); on 07/11/2026 such tasks were held more than 20 s before
# writing anything, without any detection, ASR, Smart App Control or AppLocker event, and the install timed out.
# The file and function names are a contract: NexusInfra's NexusPoste dot-sources this path and calls these functions.
# Keys are written "HKCU\..." (or "HKEY_CURRENT_USER\..."). ASCII file (Windows PowerShell 5.1). Usage:
#   . registre-reel.ps1
#   Get-RegistreReel 'HKCU\Software\...'           # default value (string), or $null when absent
#   Set-RegistreReel 'HKCU\Software\...' 'value'    # writes the default value (REG_SZ), returns the value read back
#   Remove-RegistreReel 'HKCU\Software\...'         # removes the key and its subkeys; $true when it existed
# Worker mode (out of package only): powershell -File registre-reel.ps1 -NexusRegistreRequete <json> -NexusRegistreReponse <json>
param([string]$NexusRegistreRequete, [string]$NexusRegistreReponse)

function ConvertTo-RegistreSousCle([string]$Cle) {
    if ($Cle -match '^(HKCU|HKEY_CURRENT_USER)\\(.+)$') { return $Matches[2].TrimEnd('\') }
    throw "Only HKCU keys are handled here: $Cle"
}

# Each operation is @{ action = 'get'|'set'|'remove'; cle = 'HKCU\...'; valeur = '...' }; one result per operation.
function Invoke-RegistreLocal([object[]]$Operations) {
    $resultats = New-Object System.Collections.Generic.List[object]
    foreach ($operation in $Operations) {
        $sousCle = ConvertTo-RegistreSousCle $operation.cle
        $racine = [Microsoft.Win32.Registry]::CurrentUser
        switch ($operation.action) {
            'get' {
                $cle = $racine.OpenSubKey($sousCle)
                try { $resultats.Add($(if ($cle) { $cle.GetValue('', $null, 'DoNotExpandEnvironmentNames') } else { $null })) }
                finally { if ($cle) { $cle.Dispose() } }
            }
            'set' {
                $cle = $racine.CreateSubKey($sousCle)
                try {
                    $cle.SetValue('', [string]$operation.valeur, [Microsoft.Win32.RegistryValueKind]::String)
                    $resultats.Add($cle.GetValue('', $null, 'DoNotExpandEnvironmentNames'))
                } finally { $cle.Dispose() }
            }
            'remove' {
                $cle = $racine.OpenSubKey($sousCle)
                $existait = [bool]$cle
                if ($cle) { $cle.Dispose(); $racine.DeleteSubKeyTree($sousCle, $false) }
                $resultats.Add($existait)
            }
            default { throw "Unknown registry operation: $($operation.action)" }
        }
    }
    return , $resultats.ToArray()
}

# True when the HKCU seen here may be a packaged app's private registry (MSIX). This process's own package identity is
# not enough: the Claude app starts its shells without one, yet they still see its private registry (07/11/2026: its
# shells and a WMI-started process listed different HKCU\...\Run values). Any still running ancestor with a package
# identity therefore counts. A packaged ancestor whose children break away (Windows Terminal) only costs the slower
# out-of-package path, never a write to the wrong registry. Reflection.Emit rather than Add-Type: under Windows
# PowerShell 5.1, Add-Type starts csc.exe, another external program.
function Test-RegistreEmpaquete {
    $type = 'NexusBrowser.RegistreAppModel' -as [type]
    if (-not $type) {
        $assembly = [Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly(
            [Reflection.AssemblyName]::new('NexusBrowser.RegistreAppModel'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
        $builder = $assembly.DefineDynamicModule('NexusBrowser.RegistreAppModel').DefineType('NexusBrowser.RegistreAppModel', 'Public,Sealed,Abstract')
        foreach ($signature in @(
                @('OpenProcess', [IntPtr], [Type[]]@([uint32], [bool], [int])),
                @('GetPackageFullName', [int], [Type[]]@([IntPtr], [uint32].MakeByRefType(), [IntPtr])),
                @('CloseHandle', [bool], [Type[]]@([IntPtr])))) {
            $method = $builder.DefinePInvokeMethod($signature[0], 'kernel32.dll',
                [Reflection.MethodAttributes]'Public,Static,PinvokeImpl', [Reflection.CallingConventions]::Standard,
                $signature[1], $signature[2], [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
            $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
        }
        $type = $builder.CreateType()
    }
    $processes = @{}
    foreach ($process in Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate) { $processes[[int]$process.ProcessId] = $process }
    $id = $PID
    $vus = @{}
    while ($processes.ContainsKey($id) -and -not $vus.ContainsKey($id)) {
        $vus[$id] = $true
        $handle = $type::OpenProcess(0x1000, $false, $id)  # PROCESS_QUERY_LIMITED_INFORMATION
        if ($handle -ne [IntPtr]::Zero) {
            try {
                [uint32]$longueur = 0
                if ($type::GetPackageFullName($handle, [ref]$longueur, [IntPtr]::Zero) -ne 15700) { return $true }  # APPMODEL_ERROR_NO_PACKAGE
            } finally { $null = $type::CloseHandle($handle) }
        }
        $parent = $processes[[int]$processes[$id].ParentProcessId]
        # A parent id reused by a younger process is not the real parent: the chain ends there.
        if (-not $parent -or $parent.CreationDate -gt $processes[$id].CreationDate) { break }
        $id = [int]$parent.ProcessId
    }
    return $false
}

function Invoke-RegistreHorsPaquet([object[]]$Operations, [string]$Fichier) {
    $nom = "NexusBrowser-registre-" + [Guid]::NewGuid().ToString("N").Substring(0, 8)
    # Outside %AppData% / %LocalAppData% (virtualized as well for a packaged app), so the task sees these files.
    $dossier = Join-Path $HOME ".nexus"
    [IO.Directory]::CreateDirectory($dossier) | Out-Null
    $script = Join-Path $dossier "$nom.ps1"
    $requete = Join-Path $dossier "$nom.request.json"
    $reponse = Join-Path $dossier "$nom.json"
    $utf8 = New-Object Text.UTF8Encoding $false
    [IO.File]::WriteAllText($script, [IO.File]::ReadAllText($Fichier), $utf8)
    [IO.File]::WriteAllText($requete, (ConvertTo-Json -InputObject @($Operations) -Depth 4), $utf8)
    # conhost --headless: no console window shown during the task's instant.
    $action = New-ScheduledTaskAction -Execute "conhost.exe" -Argument ("--headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " +
        "`"$script`" -NexusRegistreRequete `"$requete`" -NexusRegistreReponse `"$reponse`"")
    $reglages = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
    Register-ScheduledTask -TaskName $nom -Action $action -Settings $reglages -Force | Out-Null
    try {
        Start-ScheduledTask -TaskName $nom
        # The answer file appears in one rename once the work is done. A busy PC can delay a task start by tens of seconds.
        $fin = (Get-Date).AddSeconds(90)
        do {
            Start-Sleep -Milliseconds 200
            $info = Get-ScheduledTaskInfo -TaskName $nom
            $termine = $info.LastTaskResult -notin @(0x41303, 0x41301, 0x41325) -and (Get-ScheduledTask -TaskName $nom).State -ne "Running"
        } while (-not (Test-Path -LiteralPath $reponse) -and -not $termine -and (Get-Date) -lt $fin)
        if (-not (Test-Path -LiteralPath $reponse)) {
            $etat = "{0} (0x{1:X8})" -f (Get-ScheduledTask -TaskName $nom).State, (Get-ScheduledTaskInfo -TaskName $nom).LastTaskResult
            throw "Real registry out of package: no answer from task $nom within 90 s (task $etat)"
        }
        $answer = [IO.File]::ReadAllText($reponse, $utf8) | ConvertFrom-Json
        if (-not $answer.ok) { throw "Real registry out of package: $($answer.erreur)" }
        return , @($answer.resultats)
    } finally {
        Stop-ScheduledTask -TaskName $nom -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $nom -Confirm:$false -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $script, $requete, $reponse, "$reponse.tmp" -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-RegistreReelOperations([object[]]$Operations) {
    if (Test-RegistreEmpaquete) { return , (Invoke-RegistreHorsPaquet $Operations $MyInvocation.MyCommand.ScriptBlock.File) }
    return , (Invoke-RegistreLocal $Operations)
}

function Get-RegistreReel([Parameter(Mandatory)][string]$Cle) {
    (Invoke-RegistreReelOperations @(@{ action = 'get'; cle = $Cle }))[0]
}

function Set-RegistreReel([Parameter(Mandatory)][string]$Cle, [Parameter(Mandatory)][AllowEmptyString()][string]$Valeur) {
    (Invoke-RegistreReelOperations @(@{ action = 'set'; cle = $Cle; valeur = $Valeur }))[0]
}

function Remove-RegistreReel([Parameter(Mandatory)][string]$Cle) {
    [bool](Invoke-RegistreReelOperations @(@{ action = 'remove'; cle = $Cle }))[0]
}

if ($NexusRegistreRequete) {
    # Worker mode, outside the package: same code, then one atomic rename of the answer.
    $utf8 = New-Object Text.UTF8Encoding $false
    $answer = try {
        # ForEach-Object unrolls the array that Windows PowerShell 5.1's ConvertFrom-Json writes as a single object.
        $operations = @([IO.File]::ReadAllText($NexusRegistreRequete, $utf8) | ConvertFrom-Json | ForEach-Object { $_ })
        [ordered]@{ ok = $true; resultats = (Invoke-RegistreLocal $operations) }
    } catch { [ordered]@{ ok = $false; erreur = "$_" } }
    [IO.File]::WriteAllText("$NexusRegistreReponse.tmp", (ConvertTo-Json -InputObject $answer -Depth 4), $utf8)
    Move-Item -LiteralPath "$NexusRegistreReponse.tmp" -Destination $NexusRegistreReponse -Force
    exit $(if ($answer.ok) { 0 } else { 1 })
}
