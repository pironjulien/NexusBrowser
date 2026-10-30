# Check of the public install on a clean Windows (CI "Install", after get.ps1): every client found has its entry, the
# shared daemon answers with the user token, then a real MCP stdio round trip engine -> bridge -> extension -> page, run
# as a client would. Not part of test.ps1 (it needs the bridge, the extension and Chrome).
param([switch]$EntriesOnly)
$ErrorActionPreference = 'Stop'
$current = Get-Content (Join-Path $env:LOCALAPPDATA 'NexusBrowser\current.json') -Raw | ConvertFrom-Json
$exe = $current.exe
if (-not (Test-Path -LiteralPath $exe)) { throw "engine missing: $exe" }

# --- Entries: Codex, Claude Desktop, Antigravity plugin, Claude Code.
$codex = Get-Content (Join-Path $HOME '.codex\config.toml') -Raw
$block = "[mcp_servers.nexus-browser]`ncommand = $(ConvertTo-Json $exe)`nargs = [`"--mcp`"]"
if (-not $codex.Replace("`r`n", "`n").Contains($block) -or $codex -notmatch 'NEXUS_BROWSER_AGENT = "Codex"') { throw "Codex entry: $codex" }
foreach ($pair in @(@((Join-Path $HOME '.gemini\antigravity\plugins\nexus-browser\mcp_config.json'), 'Antigravity'),
        @((Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'), 'Claude'))) {
    $server = (Get-Content $pair[0] -Raw | ConvertFrom-Json).mcpServers.'nexus-browser'
    if ($server.command -ne $exe -or ($server.args -join ' ') -ne '--mcp' -or $server.env.NEXUS_BROWSER_AGENT -ne $pair[1]) { throw "entry $($pair[0])" }
}
$global = Join-Path $HOME '.gemini\antigravity\mcp_config.json'
if ((Test-Path $global) -and (Get-Content $global -Raw | ConvertFrom-Json).mcpServers.'nexus-browser') { throw 'Antigravity global duplicate' }
$claude = (& cmd.exe /d /c 'claude mcp get nexus-browser' 2>&1 | Out-String)
if ($LASTEXITCODE -or -not $claude.Contains($exe)) { throw "Claude Code entry: $claude" }
Write-Host 'Entries: Claude Code, Claude Desktop, Codex, Antigravity plugin OK'

# --- Shared daemon: token from the user variable, tools listed over Streamable HTTP.
$token = [Environment]::GetEnvironmentVariable('NEXUS_MCP_TOKEN', 'User')
if (-not $token) { throw 'NEXUS_MCP_TOKEN not set' }
$deadline = (Get-Date).AddSeconds(30)
do { try { $health = Invoke-RestMethod 'http://127.0.0.1:16182/health' -TimeoutSec 2 } catch { Start-Sleep 1 } } while (-not $health -and (Get-Date) -lt $deadline)
if ($health.status -ne 'ok' -or $health.version -ne $current.version) { throw "daemon health: $($health | ConvertTo-Json -Compress)" }
$headers = @{ Authorization = "Bearer $token"; Accept = 'application/json, text/event-stream' }
$init = Invoke-WebRequest -UseBasicParsing -Method Post 'http://127.0.0.1:16182/mcp?agent=codex' -Headers $headers -ContentType 'application/json' `
    -Body '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ci","version":"1"}}}'
if ($init.Headers['mcp-session-id']) { $headers['mcp-session-id'] = [string]$init.Headers['mcp-session-id'] }
$list = Invoke-RestMethod -Method Post 'http://127.0.0.1:16182/mcp?agent=codex' -Headers $headers -ContentType 'application/json' `
    -Body '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
if (@($list.result.tools).Count -ne 49) { throw "daemon tools/list: $(@($list.result.tools).Count)" }
try { Invoke-RestMethod -Method Post 'http://127.0.0.1:16182/mcp?agent=codex' -ContentType 'application/json' -Body '{}' | Out-Null; throw 'no token accepted' }
catch { if ($_.Exception.Message -eq 'no token accepted') { throw } }
Write-Host 'Daemon: health, token, 49 tools OK'
if ($EntriesOnly) { return }

# --- Round trip over stdio, as Claude Desktop or Codex start it.
$info = New-Object Diagnostics.ProcessStartInfo $exe, '--mcp'
$info.UseShellExecute = $false; $info.RedirectStandardInput = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
$info.Environment['NEXUS_BROWSER_AGENT'] = 'CI'
$process = [Diagnostics.Process]::Start($info)
$script:id = 0
function Invoke-Tool([string]$Name, [hashtable]$Arguments) {
    $script:id++
    $request = @{ jsonrpc = '2.0'; id = $script:id; method = 'tools/call'; params = @{ name = $Name; arguments = $Arguments } } | ConvertTo-Json -Depth 10 -Compress
    $process.StandardInput.WriteLine($request); $process.StandardInput.Flush()
    $task = $process.StandardOutput.ReadLineAsync()
    if (-not $task.Wait(120000)) { throw "$Name : no answer" }
    $answer = $task.Result | ConvertFrom-Json
    $payload = $answer.result.content[0].text | ConvertFrom-Json
    if ($answer.result.isError -or $payload.status -ne 'success') { throw "$Name : $($answer.result.content[0].text)" }
    return $payload.data
}
try {
    $tab = (Invoke-Tool 'browser_new_tab' @{ url = 'https://example.com/' }).id
    try {
        Invoke-Tool 'browser_wait_load' @{ tab_id = $tab } | Out-Null
        $exported = Invoke-Tool 'browser_export' @{ tab_id = $tab }
        if ($exported.content -notmatch 'Example Domain') { throw "export: $($exported | ConvertTo-Json -Compress)" }
    } finally { Invoke-Tool 'browser_close_tab' @{ tab_id = $tab } | Out-Null }
} finally {
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(10000)) { $process.Kill() }
}
Write-Host 'Round trip: new tab, export, close OK'
