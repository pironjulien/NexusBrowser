# Shared MCP token of the Nexus daemons (common rule of 30/10/2026, the same for Relay, Android and Browser):
#  1. file of truth: the explicit file (-TokenFile, NEXUS_MCP_TOKEN_FILE, then the token_file setting), otherwise
#     %USERPROFILE%\.nexus\mcp-token.txt;
#  2. a stable sibling .lock file serializes reading and initializing the token (32 random bytes in hex when empty);
#     the token itself stays readable by consumers, and an existing non-empty token is never regenerated;
#  3. the user variable NEXUS_MCP_TOKEN is aligned on it (clients read ${NEXUS_MCP_TOKEN}, never a written token);
#  4. the daemon reads the same file (spec env NEXUS_MCP_TOKEN_FILE).
# Relay 1.9.0 to 1.10.1 created its own ~\.nexus\nexus-relay\token.txt: that one is no longer a file of truth; when the
# shared file does not exist yet, it is created with that token, so those installs keep their token.
function Resolve-NexusTokenFile {
    param([string[]]$Explicit, [string]$UserHome = $env:USERPROFILE, [string]$Legacy)
    $chosen = @($Explicit | Where-Object { $_ -and (-not $Legacy -or [IO.Path]::GetFullPath($_) -ne [IO.Path]::GetFullPath($Legacy)) }) | Select-Object -First 1
    $path = if ($chosen) { $chosen } else { Join-Path $UserHome '.nexus\mcp-token.txt' }
    New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null
    $stream = $null
    foreach ($attempt in 1..50) {
        try {
            # Keep this lock file: deleting it could split concurrent installers between different file identities.
            # Never lock the token itself: consumers read it after this helper returns, while another installer runs.
            $stream = [IO.File]::Open("$path.lock", [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            break
        } catch [IO.IOException] {
            if ($attempt -eq 50) { throw }
            Start-Sleep -Milliseconds 100
        }
    }
    try {
        $existing = if (Test-Path -LiteralPath $path) { ([IO.File]::ReadAllText($path)).Trim() } else { '' }
        if (-not $existing) {
            $token = if ($Legacy -and (Test-Path -LiteralPath $Legacy) -and ([IO.File]::ReadAllText($Legacy)).Trim().Length -ge 32) { ([IO.File]::ReadAllText($Legacy)).Trim() } else {
                $bytes = New-Object byte[] 32
                $random = [Security.Cryptography.RandomNumberGenerator]::Create()
                try { $random.GetBytes($bytes) } finally { $random.Dispose() }
                -join ($bytes | ForEach-Object { $_.ToString('x2') })
            }
            [IO.File]::WriteAllText($path, $token, [Text.UTF8Encoding]::new($false))
        }
    } finally { $stream.Dispose() }
    (Resolve-Path -LiteralPath $path).Path
}

function Set-NexusTokenVariable {
    param([string]$Token)
    if ([Environment]::GetEnvironmentVariable('NEXUS_MCP_TOKEN', 'User') -ne $Token) {
        [Environment]::SetEnvironmentVariable('NEXUS_MCP_TOKEN', $Token, 'User')
        return $true
    }
    return $false
}
