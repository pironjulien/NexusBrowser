# Is the legacy "Antigravity Browser Bridge" extension (NexusAGY's bridge) still loaded in a Chrome profile?
# READ-ONLY look at the profile's preferences (Secure Preferences, Preferences: extensions.settings), never changed.
# Writes one line per extension found ("profile : name (id)"); nothing when there is none. Chrome is not started.
param([string]$UserData = (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'))
$ErrorActionPreference = 'Stop'
$names = @('Antigravity Browser Bridge')
if (-not (Test-Path -LiteralPath $UserData)) { exit 0 }
$profs = Get-ChildItem -LiteralPath $UserData -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile *' }
foreach ($prof in $profs) {
    $seen = @{}
    foreach ($file in 'Secure Preferences', 'Preferences') {
        $path = Join-Path $prof.FullName $file
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        try { $prefs = [IO.File]::ReadAllText($path) | ConvertFrom-Json -AsHashtable } catch { continue }
        $extensions = $prefs['extensions']
        $settings = if ($extensions -is [Collections.IDictionary]) { $extensions['settings'] } else { $null }
        if (-not $settings) { continue }
        foreach ($id in $settings.Keys) {
            $entry = $settings[$id]
            if ($entry -isnot [Collections.IDictionary]) { continue }
            $name = if ($entry['manifest'] -is [Collections.IDictionary]) { $entry['manifest']['name'] } else { $null }
            if (-not $name -and $entry['path']) {
                # Unpacked extension: name read from its manifest (read only).
                $manifest = Join-Path ([string]$entry['path']) 'manifest.json'
                if (Test-Path -LiteralPath $manifest -PathType Leaf) {
                    try { $name = ([IO.File]::ReadAllText($manifest) | ConvertFrom-Json).name } catch {}
                }
            }
            $disabled = $entry['state'] -eq 0 -or ($entry['disable_reasons'] -and @($entry['disable_reasons']).Count)
            if ($name -in $names -and -not $disabled -and -not $seen[$id]) {
                $seen[$id] = $true
                Write-Output "$($prof.Name) : $name ($id)"
            }
        }
    }
}
exit 0
