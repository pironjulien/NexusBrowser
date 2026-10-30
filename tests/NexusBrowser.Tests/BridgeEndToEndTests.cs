using System.Diagnostics;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using NexusBrowser.Native;
using Xunit;

namespace NexusBrowser.Tests;

/// <summary>
/// In-process BridgeServer + simulated extension WebSockets + McpServer (former --selftest, suites 4 and 5). Runs in the
/// process-environment collection because it points the journal at its own folder to prove a line was written.
/// </summary>
[Collection(ProcessEnvironmentCollection.Name)]
public sealed class BridgeEndToEndTests : IDisposable
{
    private const string ExtensionId = FakeExtension.Id;
    private readonly TempDir _dir = new();
    private readonly EnvScope _env;
    private readonly string _tokenFile;
    private readonly string _token;

    public BridgeEndToEndTests()
    {
        _env = new EnvScope(("NEXUS_JOURNAL_HOME", Path.Combine(_dir.Path, "journal")), ("NEXUS_SHARED_HOME", Path.Combine(_dir.Path, "shared")));
        _tokenFile = _dir["bridge-token"];
        _token = BridgeSecurity.LoadOrCreateToken(_tokenFile);
    }

    public void Dispose()
    {
        _env.Dispose();
        _dir.Dispose();
    }

    private BridgeServer StartBridge()
    {
        var bridge = new BridgeServer(port: 0, httpPort: 0, tokenFile: _tokenFile, allowedOrigins: [FakeExtension.Origin]);
        bridge.Start();
        return bridge;
    }

    private HttpClient Http()
    {
        var http = new HttpClient();
        http.DefaultRequestHeaders.Add(BridgeSecurity.TokenHeader, _token);
        return http;
    }

    [Fact]
    public async Task DisallowedOriginIsClosedWithPolicyViolation()
    {
        await using var bridge = StartBridge();
        using var ws = await FakeExtension.ConnectAsync(bridge.WsPort, "https://evil.example");
        var result = await ws.ReceiveAsync(new byte[1024], TestContext.Current.CancellationToken);
        Assert.Equal(WebSocketMessageType.Close, result.MessageType);
        Assert.Equal(WebSocketCloseStatus.PolicyViolation, result.CloseStatus); // 1008
    }

    [Fact]
    public async Task StatusNeedsTheTokenAndDescribesTheBridge()
    {
        await using var bridge = StartBridge();
        using var anonymous = new HttpClient();
        using (var refused = await anonymous.GetAsync($"http://127.0.0.1:{bridge.HttpPort}/api/status", TestContext.Current.CancellationToken))
            Assert.Equal(HttpStatusCode.Unauthorized, refused.StatusCode);
        using var http = Http();
        var status = JsonNode.Parse(await http.GetStringAsync($"http://127.0.0.1:{bridge.HttpPort}/api/status", TestContext.Current.CancellationToken))!;
        Assert.Equal("online", (string?)status["status"]);
        Assert.Equal(BridgeSecurity.Version, (string?)status["version"]);
        Assert.Equal(0, (int)status["connected_clients"]!);
        Assert.Equal(bridge.WsPort, (int)status["port"]!);
        Assert.IsType<bool>(status["chrome_running"]!.GetValue<bool>());
    }

    [Fact]
    public async Task PairingThenServiceWorkerWinsAndMcpCallsReachTheExtension()
    {
        await using var bridge = StartBridge();
        using var http = Http();
        var ct = TestContext.Current.CancellationToken;

        // Pairing over HTTP, then the WebSocket "pair" handshake derives the paired key.
        using var pairResponse = await http.PostAsync($"http://127.0.0.1:{bridge.HttpPort}/api/pair", new StringContent("{}", Encoding.UTF8, "application/json"), ct);
        Assert.Equal(HttpStatusCode.OK, pairResponse.StatusCode);
        string pairSecret = (string)JsonNode.Parse(await pairResponse.Content.ReadAsStringAsync(ct))!["secret"]!;
        string pairedKey;
        using (var pairWs = await FakeExtension.ConnectAsync(bridge.WsPort))
        {
            var (c, s, _) = await FakeExtension.HandshakeAsync(pairWs, pairSecret, "pair", PairingStore.PairingRole);
            pairedKey = PairingStore.PairedKey(pairSecret, c, s, ExtensionId);
        }

        // An offscreen document on the paired key, then the service worker on the native token.
        using var offscreenWs = await FakeExtension.ConnectAsync(bridge.WsPort);
        await FakeExtension.HandshakeAsync(offscreenWs, pairedKey, "paired", "offscreen");
        using var workerWs = await FakeExtension.ConnectAsync(bridge.WsPort);
        var (_, _, workerChannel) = await FakeExtension.HandshakeAsync(workerWs, _token, "native", "service_worker");

        var status = JsonNode.Parse(await http.GetStringAsync($"http://127.0.0.1:{bridge.HttpPort}/api/status", ct))!;
        Assert.Equal(2, (int)status["connected_clients"]!);
        Assert.Equal("service_worker", (string?)status["target"]?["role"]);

        var received = new List<JsonObject>();
        using var responder = new CancellationTokenSource();
        var responderTask = FakeExtension.RespondAsync(workerWs, workerChannel, received, command => (string?)command["action"] switch
        {
            "list_tabs" => new JsonArray(new JsonObject
            {
                ["id"] = 42, ["url"] = "https://example.com", ["title"] = "Example", ["active"] = true, ["mine"] = true, ["state"] = "mine",
            }),
            "create_tab" => new JsonObject
            {
                ["id"] = 43,
                ["url"] = (string?)command["params"]?["url"] ?? "about:blank",
                ["group"] = (string?)command["params"]?["group"],
            },
            _ => new JsonObject { ["ok"] = true },
        }, responder.Token);

        // A session of the same agent whose process is gone is reported to the extension.
        int deadPid;
        using (var process = Process.Start(new ProcessStartInfo("cmd.exe", "/c exit 0") { CreateNoWindow = true, UseShellExecute = false })!)
        {
            deadPid = process.Id;
            process.WaitForExit(5000);
        }
        bridge.NoteSession(("Claude", "claude-oldsession"), deadPid);

        using var mcp = new McpServer(agent: "Claude", bridgeHttpPort: bridge.HttpPort, tokenFile: _tokenFile);
        var identity = ("Claude", "claude-newsession");

        var discover = await mcp.HandleJsonRpcLineAsync("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"server/discover\"}", identity, Environment.ProcessId, ct);
        Assert.Equal("2026-07-28", (string?)discover?["result"]?["protocolVersion"]);

        var list = await mcp.HandleJsonRpcLineAsync("{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}", identity, Environment.ProcessId, ct);
        Assert.Equal(49, (list?["result"]?["tools"] as JsonArray)?.Count);

        var tabs = await mcp.HandleJsonRpcLineAsync(
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"browser_list_tabs\",\"arguments\":{}}}", identity, Environment.ProcessId, ct);
        Assert.False((bool)tabs!["result"]!["isError"]!);
        Assert.Equal("success", (string?)tabs["result"]!["structuredContent"]?["status"]);
        Assert.Equal(42, (int)tabs["result"]!["structuredContent"]!["data"]![0]!["id"]!);

        JsonObject first;
        lock (received)
        {
            Assert.NotEmpty(received);
            first = received[0];
        }
        Assert.Equal("list_tabs", (string?)first["action"]);
        Assert.Contains("claude-oldsession", (first["gone"] as JsonArray ?? []).Select(x => (string?)x));

        var newTab = await mcp.HandleJsonRpcLineAsync(
            "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"browser_new_tab\",\"arguments\":{\"url\":\"https://example.com\"}}}", identity, Environment.ProcessId, ct);
        Assert.False((bool)newTab!["result"]!["isError"]!, newTab.ToJsonString());
        lock (received)
            Assert.Contains(received, c => (string?)c["action"] == "create_tab" && (string?)c["params"]?["url"] == "https://example.com");

        string journal = Path.Combine(_dir.Path, "journal", "browser", "claude");
        Assert.True(Directory.Exists(journal) && Directory.GetFiles(journal, "*.jsonl").Length > 0, $"no journal in {journal}");

        responder.Cancel();
        try { await responderTask; } catch (OperationCanceledException) { }
    }

    [Fact]
    public async Task UploadFromASecretsFolderIsRefusedBeforeReachingTheExtension()
    {
        await using var bridge = StartBridge();
        using var http = Http();
        var ct = TestContext.Current.CancellationToken;
        using var request = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{bridge.HttpPort}/api/command")
        {
            Content = new StringContent(new JsonObject
            {
                ["action"] = "upload",
                ["params"] = new JsonObject { ["files"] = new JsonArray(Path.Combine(BridgeSecurity.HomeDir(), ".ssh", "id_ed25519")), ["tab_id"] = 7 },
                ["timeout"] = 5.0,
            }.ToJsonString(), Encoding.UTF8, "application/json"),
        };
        request.Headers.Add(BridgeSecurity.AgentHeader, "Claude");
        request.Headers.Add(BridgeSecurity.ClientHeader, "claude-test1234");
        using var response = await http.SendAsync(request, ct);
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }
}

/// <summary>Self-update routes of the native bridge (test_update.py, bridge part): token required, a developer checkout
/// is refused honestly with 409 and its state stays idle.</summary>
[Collection(ProcessEnvironmentCollection.Name)]
public sealed class BridgeUpdateTests : IDisposable
{
    private readonly TempDir _dir = new();
    private readonly EnvScope _env;
    private readonly string _tokenFile;
    private readonly string _token;
    private string StatusFile => Path.Combine(_dir.Path, "status", "browser.json");

    public BridgeUpdateTests()
    {
        _env = new EnvScope(("NEXUS_STATUS_DIR", Path.Combine(_dir.Path, "status")));
        _tokenFile = _dir["bridge-token"];
        _token = BridgeSecurity.LoadOrCreateToken(_tokenFile);
    }

    public void Dispose()
    {
        _env.Dispose();
        _dir.Dispose();
    }

    private async Task<(HttpStatusCode Code, JsonObject Body)> UpdateAsync(BridgeServer bridge, HttpMethod method, string? token)
    {
        using var http = new HttpClient();
        using var request = new HttpRequestMessage(method, $"http://127.0.0.1:{bridge.HttpPort}/api/update");
        if (method == HttpMethod.Post) request.Content = new StringContent("{}", Encoding.UTF8, "application/json");
        if (token is not null) request.Headers.Add(BridgeSecurity.TokenHeader, token);
        using var response = await http.SendAsync(request, TestContext.Current.CancellationToken);
        return (response.StatusCode, (JsonObject)JsonNode.Parse(await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken))!);
    }

    private BridgeServer StartBridge()
    {
        var bridge = new BridgeServer(port: 0, httpPort: 0, tokenFile: _tokenFile, allowedOrigins: [FakeExtension.Origin]);
        bridge.Start();
        return bridge;
    }

    [Fact]
    public async Task GetReportsTheStoredStatus()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(StatusFile)!);
        File.WriteAllText(StatusFile, new JsonObject { ["version"] = BridgeSecurity.Version, ["latest"] = "99.0.0" }.ToJsonString());
        await using var bridge = StartBridge();
        var (code, body) = await UpdateAsync(bridge, HttpMethod.Get, _token);
        Assert.Equal(HttpStatusCode.OK, code);
        Assert.Equal("browser", (string?)body["product"]);
        Assert.Equal("99.0.0", (string?)body["latest"]);
        Assert.Equal(BridgeSecurity.Version, (string?)body["version"]);
        Assert.Equal("idle", (string?)body["state"]);
        Assert.True((bool)body["success"]!);
    }

    [Fact]
    public async Task GetWithoutStatusFileDefaultsToTheRunningVersion()
    {
        await using var bridge = StartBridge();
        var (code, body) = await UpdateAsync(bridge, HttpMethod.Get, _token);
        Assert.Equal(HttpStatusCode.OK, code);
        Assert.Equal("browser", (string?)body["product"]);
        Assert.Equal(BridgeSecurity.Version, (string?)body["version"]);
        Assert.Equal("idle", (string?)body["state"]);
    }

    [Fact]
    public async Task PostOnADeveloperCheckoutIsRefusedWithConflict()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(StatusFile)!);
        File.WriteAllText(StatusFile, new JsonObject { ["version"] = BridgeSecurity.Version, ["latest"] = "99.0.0" }.ToJsonString());
        await using var bridge = StartBridge();
        var (code, body) = await UpdateAsync(bridge, HttpMethod.Post, _token);
        Assert.Equal(HttpStatusCode.Conflict, code);
        Assert.False((bool)body["success"]!);
        Assert.Contains("Developer checkout", (string?)body["message"]);
        Assert.Contains("git", (string?)body["message"]);
        Assert.Equal("idle", (string?)JsonNode.Parse(File.ReadAllText(StatusFile))!["state"]);
    }

    [Fact]
    public async Task UpdateRoutesNeedTheToken()
    {
        await using var bridge = StartBridge();
        Assert.Equal(HttpStatusCode.Unauthorized, (await UpdateAsync(bridge, HttpMethod.Get, "faux")).Code);
        Assert.Equal(HttpStatusCode.Unauthorized, (await UpdateAsync(bridge, HttpMethod.Post, null)).Code);
        Assert.False(File.Exists(StatusFile));
    }

    [Fact]
    public async Task OtherMethodsAreNotAllowed()
    {
        await using var bridge = StartBridge();
        Assert.Equal(HttpStatusCode.MethodNotAllowed, (await UpdateAsync(bridge, HttpMethod.Put, _token)).Code);
    }
}
