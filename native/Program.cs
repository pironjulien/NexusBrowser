using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace NexusBrowser.Native;

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        try { return await RunAsync(args); }
        catch (Exception error)
        {
            // A failed second daemon must report its occupied port and exit, not open a Windows crash dialog.
            Console.Error.WriteLine($"NexusBrowser: {error.Message}");
            try
            {
                string directory = BridgeSecurity.DefaultDataDir(); Directory.CreateDirectory(directory);
                File.AppendAllText(Path.Combine(directory, "engine.log"), $"{DateTimeOffset.Now:o} pid={Environment.ProcessId} {error}\n", new UTF8Encoding(false));
            }
            catch { }
            return 1;
        }
    }

    private static async Task<int> RunAsync(string[] args)
    {
        // Chrome starts this WinExe through cmd.exe with native-messaging pipes.
        // Attaching its console replaces those inherited handles with CONIN$/CONOUT$,
        // so the host waits forever instead of answering Chrome. Never attach a console:
        // native messaging is binary and MCP stdio must remain JSON-only.
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);

        if (args.Contains("--selftest", StringComparer.OrdinalIgnoreCase))
        {
            return await RunSelfTestAsync();
        }

        string? tokenFile = GetArgValue(args, "--token-file");
        string? logFile = GetArgValue(args, "--log-file");
        string? agent = GetArgValue(args, "--agent");

        if (args.Contains("--rotate", StringComparer.OrdinalIgnoreCase))
        {
            BridgeSecurity.RotateToken(tokenFile);
            return 0;
        }

        if (args.Contains("--auth-host", StringComparer.OrdinalIgnoreCase) ||
            (!HasAnyModeFlag(args) && NativeAuthHost.CallerExtensionId(args) is not null))
        {
            return NativeAuthHost.Run(args, tokenFile: tokenFile);
        }

        if (args.Contains("--bridge", StringComparer.OrdinalIgnoreCase))
        {
            logFile ??= Path.Combine(BridgeSecurity.DefaultDataDir(), "bridge.log");
            int port = BridgeServer.DefaultPort;
            if (GetArgValue(args, "--port") is { } pStr && int.TryParse(pStr, out int pVal) && pVal > 0)
                port = pVal;

            await using var server = new BridgeServer(port: port, tokenFile: tokenFile, logFile: logFile);
            using var cts = new CancellationTokenSource();
            Console.CancelKeyPress += (_, e) =>
            {
                e.Cancel = true;
                cts.Cancel();
            };
            await server.RunForeverAsync(cts.Token);
            return 0;
        }

        if (args.Contains("--http", StringComparer.OrdinalIgnoreCase))
        {
            int httpPort = 16182;
            if (GetArgValue(args, "--http") is { } hpStr && int.TryParse(hpStr, out int hpVal) && hpVal > 0)
                httpPort = hpVal;

            using var mcp = new McpServer(agent: agent, tokenFile: tokenFile);
            using var cts = new CancellationTokenSource();
            Console.CancelKeyPress += (_, e) =>
            {
                e.Cancel = true;
                cts.Cancel();
            };
            await mcp.RunHttpAsync(httpPort, cts.Token);
            return 0;
        }

        // Default or --mcp: stdio MCP server
        using (var mcp = new McpServer(agent: agent, tokenFile: tokenFile))
        {
            using var cts = new CancellationTokenSource();
            Console.CancelKeyPress += (_, e) =>
            {
                e.Cancel = true;
                cts.Cancel();
            };
            await mcp.RunStdioAsync(ct: cts.Token);
        }
        return 0;
    }

    private static bool HasAnyModeFlag(string[] args)
    {
        foreach (var a in args)
        {
            if (a.Equals("--bridge", StringComparison.OrdinalIgnoreCase) ||
                a.Equals("--mcp", StringComparison.OrdinalIgnoreCase) ||
                a.Equals("--http", StringComparison.OrdinalIgnoreCase) ||
                a.Equals("--rotate", StringComparison.OrdinalIgnoreCase) ||
                a.Equals("--selftest", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        return false;
    }

    private static string? GetArgValue(string[] args, string flag)
    {
        for (int i = 0; i < args.Length; i++)
        {
            if (string.Equals(args[i], flag, StringComparison.OrdinalIgnoreCase))
            {
                if (i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal))
                    return args[i + 1];
                return null;
            }
            if (args[i].StartsWith(flag + "=", StringComparison.OrdinalIgnoreCase))
            {
                return args[i][(flag.Length + 1)..];
            }
        }
        return null;
    }

    // =========================================================================
    // Comprehensive Self-Test (--selftest)
    // =========================================================================

    private static void AssertTrue(bool condition, string message)
    {
        if (!condition)
            throw new InvalidOperationException($"Selftest assertion failed: {message}");
    }

    private static async Task<int> RunSelfTestAsync()
    {
        string tempDir = Path.Combine(Path.GetTempPath(), $"nexus-browser-selftest-{Environment.ProcessId}-{Guid.NewGuid():N}");
        Directory.CreateDirectory(tempDir);
        string? prevJournalHome = Environment.GetEnvironmentVariable("NEXUS_JOURNAL_HOME");
        string? prevSharedHome = Environment.GetEnvironmentVariable("NEXUS_SHARED_HOME");

        try
        {
            Environment.SetEnvironmentVariable("NEXUS_JOURNAL_HOME", Path.Combine(tempDir, "journal"));
            Environment.SetEnvironmentVariable("NEXUS_SHARED_HOME", Path.Combine(tempDir, "shared"));

            string tokenFile = Path.Combine(tempDir, "bridge-token");
            string token = BridgeSecurity.LoadOrCreateToken(tokenFile);
            AssertTrue(token.Length >= 43, "Token length >= 43");

            // 1. Test BridgeAuth & Channel & PairingStore
            TestAuthAndChannel(token, tempDir);

            // 2. Test NativeAuthHost (--auth-host) over stream
            TestNativeAuthHost(token, tokenFile);

            // 3. Test BridgeSecurity (UploadRefusal, CheckIdentity, CheckPid, ProcessRunning)
            TestBridgeSecurity();

            // 4 & 5. Test BridgeServer + simulated WebSocket extensions + McpServer stdio
            await TestBridgeAndMcpEndToEndAsync(token, tokenFile, tempDir);

            Console.WriteLine("OK: NexusBrowser C# unified engine selftest passed (5/5 suites)");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"FAIL: {ex}");
            return 1;
        }
        finally
        {
            Environment.SetEnvironmentVariable("NEXUS_JOURNAL_HOME", prevJournalHome);
            Environment.SetEnvironmentVariable("NEXUS_SHARED_HOME", prevSharedHome);
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static void TestAuthAndChannel(string token, string tempDir)
    {
        string extId = "blcgddmjdkobmgakjffjpgiicjlflgjf";
        string cNonce = BridgeAuth.NewNonce();
        string sNonce = BridgeAuth.NewNonce();
        AssertTrue(BridgeAuth.CheckNonce(cNonce, "c") == cNonce, "Valid client nonce");
        AssertTrue(BridgeAuth.CheckExtensionId(extId) == extId, "Valid extension id");
        AssertTrue(BridgeAuth.CheckRole("service_worker") == "service_worker", "Valid role");

        string sp = BridgeAuth.ServerProof(token, cNonce, sNonce, "service_worker", extId);
        string cp = BridgeAuth.ClientProof(token, cNonce, sNonce, "service_worker", extId);
        AssertTrue(sp != cp, "Server and client proofs must differ");

        byte[] key = BridgeAuth.SessionKey(token, cNonce, sNonce, "service_worker", extId);
        var s2c = new BridgeAuth.Channel(key, "s2c", "c2s");
        var c2s = new BridgeAuth.Channel(key, "c2s", "s2c");

        var frame1 = s2c.Seal("{\"type\":\"auth_ok\"}");
        AssertTrue(c2s.Open(frame1) == "{\"type\":\"auth_ok\"}", "Channel open matches sealed body");

        // Replay seq must fail
        bool replayCaught = false;
        try { c2s.Open(frame1); } catch (AuthError) { replayCaught = true; }
        AssertTrue(replayCaught, "Replayed sequence number must throw AuthError");

        // Tampered body must fail
        var frame2 = s2c.Seal("{\"action\":\"ping\"}");
        frame2["body"] = "{\"action\":\"eval\"}";
        bool tamperCaught = false;
        try { c2s.Open(frame2); } catch (AuthError) { tamperCaught = true; }
        AssertTrue(tamperCaught, "Tampered body must throw AuthError");

        // PairingStore lifecycle
        var store = new PairingStore(Path.Combine(tempDir, "paired-extensions.json"));
        var offer = store.Offer();
        string secret = offer["secret"]!.GetValue<string>();
        AssertTrue(secret.Length == 43, "Offer secret length == 43");
        AssertTrue(store.PendingSecret() == secret, "PendingSecret returns active secret");
        string derivedKey = store.Complete(cNonce, sNonce, extId);
        AssertTrue(store.KeyFor(extId) == derivedKey, "KeyFor returns saved paired key");
        AssertTrue(store.Revoke(extId) == 1, "Revoke removes paired key");
    }

    private static void TestNativeAuthHost(string token, string tokenFile)
    {
        string extId = "blcgddmjdkobmgakjffjpgiicjlflgjf";
        string cNonce = BridgeAuth.NewNonce();
        string sNonce = BridgeAuth.NewNonce();
        string sp = BridgeAuth.ServerProof(token, cNonce, sNonce, "service_worker", extId);

        var req = new JsonObject
        {
            ["op"] = "handshake",
            ["client_nonce"] = cNonce,
            ["server_nonce"] = sNonce,
            ["role"] = "service_worker",
            ["extension_id"] = extId,
            ["server_proof"] = sp,
        };

        using var input = new MemoryStream();
        NativeAuthHost.WriteMessage(input, req);
        input.Position = 0;
        using var output = new MemoryStream();

        int rc = NativeAuthHost.Run([$"chrome-extension://{extId}/"], input, output, tokenFile);
        AssertTrue(rc == 0, "NativeAuthHost returns 0");
        output.Position = 0;
        var reply = NativeAuthHost.ReadMessage(output) as JsonObject;
        AssertTrue(reply != null && reply["ok"]?.GetValue<bool>() == true, "NativeAuthHost handshake ok");
        AssertTrue(
            reply!["client_proof"]?.GetValue<string>() == BridgeAuth.ClientProof(token, cNonce, sNonce, "service_worker", extId),
            "NativeAuthHost client_proof matches");

        // Bad server proof must be rejected without leaking client_proof
        req["server_proof"] = BridgeAuth.NewNonce();
        using var badIn = new MemoryStream();
        NativeAuthHost.WriteMessage(badIn, req);
        badIn.Position = 0;
        using var badOut = new MemoryStream();
        NativeAuthHost.Run([$"chrome-extension://{extId}/"], badIn, badOut, tokenFile);
        badOut.Position = 0;
        var badReply = NativeAuthHost.ReadMessage(badOut) as JsonObject;
        AssertTrue(badReply != null && badReply["ok"]?.GetValue<bool>() == false, "Bad server proof rejected");
        AssertTrue(!badReply!.ContainsKey("client_proof"), "No client_proof on rejection");
    }

    private static void TestBridgeSecurity()
    {
        AssertTrue(BridgeSecurity.ProcessRunning(Environment.ProcessId), "Current process is running");
        AssertTrue(BridgeSecurity.CheckPid("1234") == 1234, "CheckPid valid");
        AssertTrue(BridgeSecurity.CheckPid("0") is null, "CheckPid 0 rejected");
        AssertTrue(BridgeSecurity.CheckPid("-5") is null, "CheckPid negative rejected");
        AssertTrue(BridgeSecurity.CheckIdentity("Claude", "claude-123456") is not null, "CheckIdentity valid");

        string home = BridgeSecurity.HomeDir();
        string[] forbiddenPaths =
        [
            Path.Combine(home, ".ssh", "id_ed25519"),
            Path.Combine(home, ".ssh.", "id_ed25519"),
            Path.Combine(home, ".nexus", "nexus-browser", "bridge-token"),
            Path.Combine(home, "Documents", "NexusSecure", "secret.txt"),
            @"\\127.0.0.1\c$" + Path.Combine(home, ".ssh", "id_rsa")[2..],
            @"\\?\" + Path.Combine(home, ".codex", "auth.json"),
        ];

        foreach (var path in forbiddenPaths)
        {
            string? refusal = BridgeSecurity.UploadRefusal([path]);
            AssertTrue(refusal != null && refusal.Contains("secrets folder", StringComparison.Ordinal), $"Must refuse protected path: {path}");
        }

        string safeFile = Path.Combine(Path.GetTempPath(), "safe-upload.txt");
        AssertTrue(BridgeSecurity.UploadRefusal([safeFile]) is null, "Safe temp path allowed");

        string allowed = "--lang=fr-FR --accept-lang=fr-FR,fr,en-US,en --variations-override-country=us --disable-features=GlicCountryFiltering,GlicLocaleFiltering --force-dark-mode";
        string forbidden = "--disable-web-security --headless --user-data-dir=C:/temp --load-extension=C:/x --remote-debugging-port=9222 --lang=fr;calc --force-dark-mode=1 --LANG=fr --disable-features=GlicX,IsolateOrigins https://example.com";
        AssertTrue(ChromeLauncher.LaunchArguments(allowed).SequenceEqual(new[] { "--profile-directory=Default" }.Concat(allowed.Split(' '))), "Chrome keeps the safe opt-in flags and real Default profile");
        AssertTrue(ChromeLauncher.LaunchArguments(forbidden).SequenceEqual(new[] { "--profile-directory=Default" }), "Chrome refuses profile replacement, headless, code loading and security changes");
        int launches = 0;
        var closedChrome = new ChromeLauncher(() => false, () => @"C:\Chrome\chrome.exe", info =>
        {
            launches++;
            AssertTrue(info.FileName == @"C:\Chrome\chrome.exe" && !info.UseShellExecute, "Chrome launched directly without a shell");
            AssertTrue(info.ArgumentList[0] == "--profile-directory=Default", "Chrome uses its installed profile");
            return true;
        });
        AssertTrue(!closedChrome.EnsureStarted(allowStart: false) && launches == 0, "Read-only checks never start Chrome");
        AssertTrue(closedChrome.EnsureStarted() && launches == 1, "Closed Chrome is started once");
        var openChrome = new ChromeLauncher(() => true, () => throw new InvalidOperationException("must not locate"), _ => throw new InvalidOperationException("must not launch"));
        AssertTrue(openChrome.EnsureStarted(), "Running Chrome is preserved");
        var missingChrome = new ChromeLauncher(() => false, () => null, _ => throw new InvalidOperationException("must not launch"));
        AssertTrue(!missingChrome.EnsureStarted(), "Missing Chrome is reported without fabricating success");
    }

    private static async Task TestBridgeAndMcpEndToEndAsync(string token, string tokenFile, string tempDir)
    {
        string extId = "blcgddmjdkobmgakjffjpgiicjlflgjf";
        string origin = $"chrome-extension://{extId}";

        await using var bridge = new BridgeServer(
            port: 0,
            httpPort: 0,
            tokenFile: tokenFile,
            allowedOrigins: [origin]);
        bridge.Start();

        using var http = new HttpClient();
        http.DefaultRequestHeaders.Add(BridgeSecurity.TokenHeader, token);

        // 1. Disallowed origin closes with 1008
        using (var badWs = new ClientWebSocket())
        {
            badWs.Options.SetRequestHeader("Origin", "https://evil.example");
            await badWs.ConnectAsync(new Uri($"ws://127.0.0.1:{bridge.WsPort}"), CancellationToken.None);
            var buf = new byte[1024];
            var res = await badWs.ReceiveAsync(buf, CancellationToken.None);
            AssertTrue(res.MessageType == WebSocketMessageType.Close && (int?)res.CloseStatus == 1008, "Evil origin closed with 1008");
        }

        // 2. Pairing over HTTP + WebSocket "pair" then "paired"
        var pairResp = await http.PostAsync($"http://127.0.0.1:{bridge.HttpPort}/api/pair", new StringContent("{}", Encoding.UTF8, "application/json"));
        var pairJson = JsonNode.Parse(await pairResp.Content.ReadAsStringAsync()) as JsonObject;
        string pairSecret = pairJson!["secret"]!.GetValue<string>();

        string pairedKey;
        using (var pairWs = new ClientWebSocket())
        {
            pairWs.Options.SetRequestHeader("Origin", origin);
            await pairWs.ConnectAsync(new Uri($"ws://127.0.0.1:{bridge.WsPort}"), CancellationToken.None);
            var (cNonce, sNonce, _) = await PerformExtensionHandshakeAsync(pairWs, pairSecret, "pair", "pairing", extId);
            pairedKey = PairingStore.PairedKey(pairSecret, cNonce, sNonce, extId);
        }

        // 3. Connect offscreen (paired) and service_worker (native), verify service_worker wins target selection
        using var offscreenWs = new ClientWebSocket();
        offscreenWs.Options.SetRequestHeader("Origin", origin);
        await offscreenWs.ConnectAsync(new Uri($"ws://127.0.0.1:{bridge.WsPort}"), CancellationToken.None);
        var (_, _, offscreenChan) = await PerformExtensionHandshakeAsync(offscreenWs, pairedKey, "paired", "offscreen", extId);

        using var workerWs = new ClientWebSocket();
        workerWs.Options.SetRequestHeader("Origin", origin);
        await workerWs.ConnectAsync(new Uri($"ws://127.0.0.1:{bridge.WsPort}"), CancellationToken.None);
        var (_, _, workerChan) = await PerformExtensionHandshakeAsync(workerWs, token, "native", "service_worker", extId);

        // Start responder loop on service_worker
        var receivedCommands = new List<JsonObject>();
        using var responderCts = new CancellationTokenSource();
        var responderTask = Task.Run(async () =>
        {
            var buf = new byte[65536];
            while (!responderCts.Token.IsCancellationRequested && workerWs.State == WebSocketState.Open)
            {
                WebSocketReceiveResult r;
                try
                {
                    r = await workerWs.ReceiveAsync(buf, responderCts.Token);
                }
                catch
                {
                    break;
                }
                if (r.MessageType == WebSocketMessageType.Close)
                    break;
                string raw = Encoding.UTF8.GetString(buf, 0, r.Count);
                string inner = workerChan.Open(JsonNode.Parse(raw));
                var cmd = (JsonNode.Parse(inner) as JsonObject)!;
                lock (receivedCommands)
                    receivedCommands.Add(cmd);

                string reqId = cmd["requestId"]!.GetValue<string>();
                string act = cmd["action"]!.GetValue<string>();
                JsonNode data = act switch
                {
                    "list_tabs" => new JsonArray(new JsonObject
                        {
                            ["id"] = 42,
                            ["url"] = "https://example.com",
                            ["title"] = "Example",
                            ["active"] = true,
                            ["mine"] = true,
                            ["state"] = "mine",
                        }),
                    "create_tab" => new JsonObject
                    {
                        ["id"] = 43,
                        ["url"] = cmd["params"]?["url"]?.GetValue<string>() ?? "about:blank",
                        ["group"] = cmd["params"]?["group"]?.GetValue<string>(),
                    },
                    _ => new JsonObject { ["ok"] = true },
                };

                var replyPayload = new JsonObject
                {
                    ["requestId"] = reqId,
                    ["success"] = true,
                    ["data"] = data,
                };
                var sealedReply = workerChan.Seal(replyPayload.ToJsonString());
                await workerWs.SendAsync(Encoding.UTF8.GetBytes(sealedReply.ToJsonString()), WebSocketMessageType.Text, true, responderCts.Token);
            }
        });

        // 4. Dead PID detection: spawn a short-lived process, register its PID on bridge, wait for exit, then call from new session of same agent
        int deadPid;
        using (var proc = Process.Start(new ProcessStartInfo("cmd.exe", "/c exit 0") { CreateNoWindow = true, UseShellExecute = false })!)
        {
            deadPid = proc.Id;
            proc.WaitForExit(5000);
        }
        bridge.NoteSession(("Claude", "claude-oldsession"), deadPid);

        // 5. Exercise McpServer against our live BridgeServer
        using var mcp = new McpServer(agent: "Claude", bridgeHttpPort: bridge.HttpPort, tokenFile: tokenFile);
        var ident = ("Claude", "claude-newsession");

        // 5a. server/discover
        var discoverResp = await mcp.HandleJsonRpcLineAsync("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"server/discover\"}", ident, Environment.ProcessId);
        AssertTrue(discoverResp?["result"]?["protocolVersion"]?.GetValue<string>() == "2026-07-28", "server/discover returns 2026-07-28");

        // 5b. tools/list
        var listResp = await mcp.HandleJsonRpcLineAsync("{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}", ident, Environment.ProcessId);
        var toolsArr = listResp?["result"]?["tools"] as JsonArray;
        AssertTrue(toolsArr != null && toolsArr.Count == 49, $"Expected 49 tools, got {toolsArr?.Count}");

        // 5c. tools/call browser_list_tabs
        var callListResp = await mcp.HandleJsonRpcLineAsync(
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"browser_list_tabs\",\"arguments\":{}}}",
            ident,
            Environment.ProcessId);
        AssertTrue(callListResp?["result"]?["isError"]?.GetValue<bool>() == false, "browser_list_tabs succeeded");
        AssertTrue(callListResp?["result"]?["structuredContent"]?["status"]?.GetValue<string>() == "success", "structuredContent populated");

        // Verify dead session was reported in "gone" to the extension
        lock (receivedCommands)
        {
            AssertTrue(receivedCommands.Count >= 1, "Extension received command");
            var firstCmd = receivedCommands[0];
            var goneArr = firstCmd["gone"] as JsonArray;
            AssertTrue(goneArr != null && goneArr.Any(x => x?.GetValue<string>() == "claude-oldsession"), "Dead session reported in gone");
        }

        // 5d. tools/call browser_new_tab
        var callNewTabResp = await mcp.HandleJsonRpcLineAsync(
            "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"browser_new_tab\",\"arguments\":{\"url\":\"https://example.com\"}}}",
            ident,
            Environment.ProcessId);
        AssertTrue(callNewTabResp?["result"]?["isError"]?.GetValue<bool>() == false, "browser_new_tab succeeded");

        // Verify journal file was written
        string journalDir = Path.Combine(tempDir, "journal", "browser", "claude");
        AssertTrue(Directory.Exists(journalDir) && Directory.GetFiles(journalDir, "*.jsonl").Length > 0, "Journal file created for claude");

        responderCts.Cancel();
        try { await responderTask; } catch { }
    }

    private static async Task<(string ClientNonce, string ServerNonce, BridgeAuth.Channel Channel)> PerformExtensionHandshakeAsync(
        ClientWebSocket ws,
        string key,
        string authMode,
        string role,
        string extensionId)
    {
        string cNonce = BridgeAuth.NewNonce();
        var hello = new JsonObject
        {
            ["type"] = "auth_hello",
            ["protocol"] = BridgeAuth.Protocol,
            ["client_nonce"] = cNonce,
            ["role"] = role,
            ["extension_id"] = extensionId,
            ["auth"] = authMode,
        };
        await ws.SendAsync(Encoding.UTF8.GetBytes(hello.ToJsonString()), WebSocketMessageType.Text, true, CancellationToken.None);

        var buf = new byte[4096];
        var res = await ws.ReceiveAsync(buf, CancellationToken.None);
        var challenge = (JsonNode.Parse(Encoding.UTF8.GetString(buf, 0, res.Count)) as JsonObject)!;
        string sNonce = challenge["server_nonce"]!.GetValue<string>();
        string expectedSp = BridgeAuth.ServerProof(key, cNonce, sNonce, role, extensionId);
        AssertTrue(challenge["server_proof"]?.GetValue<string>() == expectedSp, "Server proof valid");

        var proofMsg = new JsonObject
        {
            ["type"] = "auth_proof",
            ["client_proof"] = BridgeAuth.ClientProof(key, cNonce, sNonce, role, extensionId),
        };
        await ws.SendAsync(Encoding.UTF8.GetBytes(proofMsg.ToJsonString()), WebSocketMessageType.Text, true, CancellationToken.None);

        var chan = new BridgeAuth.Channel(BridgeAuth.SessionKey(key, cNonce, sNonce, role, extensionId), "c2s", "s2c");
        res = await ws.ReceiveAsync(buf, CancellationToken.None);
        string okInner = chan.Open(JsonNode.Parse(Encoding.UTF8.GetString(buf, 0, res.Count)));
        var okObj = JsonNode.Parse(okInner) as JsonObject;
        AssertTrue(okObj?["type"]?.GetValue<string>() == "auth_ok", "Received signed auth_ok");

        return (cNonce, sNonce, chan);
    }
}
