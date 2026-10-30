using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Reflection;
using System.Text;
using System.Text.Json.Nodes;
using NexusBrowser.Native;
using Xunit;

namespace NexusBrowser.Tests;

/// <summary>A real `NexusBrowser.exe --http` daemon wired to a FakeBridge: sessions, idle expiry, closed sessions
/// announced to the bridge (X-Nexus-Browser-Gone).</summary>
internal sealed class Daemon : IDisposable
{
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(5) };
    public ChildProcess Process { get; }
    public string Base { get; }
    public string Token { get; } = new('d', 64);

    private Daemon(ChildProcess process, string baseUrl)
    {
        Process = process;
        Base = baseUrl;
    }

    public static async Task<Daemon> StartAsync(FakeBridge bridge, TempDir dir, string? idleSeconds = null)
    {
        int port = Ports.Free();
        var env = new Dictionary<string, string?>
        {
            ["NEXUS_MCP_TOKEN"] = new string('d', 64),
            ["NEXUS_BROWSER_HTTP_PORT"] = bridge.Port.ToString(),
            ["NEXUS_BROWSER_TOKEN_FILE"] = bridge.TokenFile,
            ["NEXUS_SHARED_HOME"] = dir["shared"],
            ["NEXUS_JOURNAL_HOME"] = dir["journal"],
            ["NEXUS_BROWSER_SESSION_IDLE_SECONDS"] = idleSeconds,
        };
        var daemon = new Daemon(new ChildProcess(NativeExe.Path, ["--http", port.ToString()], env), $"http://127.0.0.1:{port}");
        bool ready = false;
        try
        {
            var clock = Stopwatch.StartNew();
            while (true)
            {
                try
                {
                    using var health = await daemon._http.GetAsync(daemon.Base + "/health");
                    if (health.IsSuccessStatusCode) { ready = true; return daemon; }
                }
                catch (HttpRequestException) { }
                if (daemon.Process.Process.HasExited || clock.Elapsed > TimeSpan.FromSeconds(10))
                    throw new InvalidOperationException($"daemon not ready; stderr={daemon.Process.Stderr}");
                await Task.Delay(50);
            }
        }
        finally { if (!ready) daemon.Dispose(); }
    }

    public async Task<HttpResponseMessage> SendAsync(HttpMethod method, string agent, string? body, string? session = null)
    {
        using var request = new HttpRequestMessage(method, $"{Base}/mcp?agent={agent}");
        if (body is not null) request.Content = new StringContent(body, Encoding.UTF8, "application/json");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Token);
        if (session is not null) request.Headers.Add("mcp-session-id", session);
        return await _http.SendAsync(request);
    }

    public async Task<string> OpenSessionAsync(string agent)
    {
        using var response = await SendAsync(HttpMethod.Post, agent, """{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}""");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return response.Headers.GetValues("mcp-session-id").Single();
    }

    public async Task<HttpStatusCode> ListToolsAsync(string agent, string session)
    {
        using var response = await SendAsync(HttpMethod.Post, agent, """{"jsonrpc":"2.0","id":2,"method":"tools/list"}""", session);
        if (response.StatusCode == HttpStatusCode.OK)
            Assert.Equal(49, JsonNode.Parse(await response.Content.ReadAsStringAsync())!["result"]!["tools"]!.AsArray().Count);
        return response.StatusCode;
    }

    public async Task<JsonNode> CallToolAsync(string agent, string session, string tool)
    {
        using var response = await SendAsync(HttpMethod.Post, agent,
            EngineSession.Request(3, tool, new JsonObject()), session);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return JsonNode.Parse(await response.Content.ReadAsStringAsync())!;
    }

    public async Task WaitForStderrAsync(string text, TimeSpan timeout)
    {
        var clock = Stopwatch.StartNew();
        while (!Process.Stderr.Contains(text, StringComparison.Ordinal))
        {
            if (clock.Elapsed > timeout) Assert.Fail($"stderr has no \"{text}\":\n{Process.Stderr}");
            await Task.Delay(20);
        }
    }

    public void Dispose()
    {
        _http.Dispose();
        Process.Dispose();
    }
}

public sealed class SessionLifetimeTests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    private static string Identity(string agent, string session) => McpServer.SessionIdentity(agent, session).Id;

    [Fact]
    public void SessionIdentityIsTheAgentAndTheFirst24CharactersOfTheSession()
    {
        string session = "0123abcd-4567-89ef-0123-456789abcdef";
        Assert.Equal(("Claude", "claude-0123abcd456789ef01234567"), McpServer.SessionIdentity("Claude", session));
    }

    [Fact]
    public async Task ExpiredSessionAnswers404AndIsLogged()
    {
        using var bridge = new FakeBridge((_, _) => new JsonArray());
        using var daemon = await Daemon.StartAsync(bridge, _dir, idleSeconds: "1");
        string session = await daemon.OpenSessionAsync("claude");
        await daemon.WaitForStderrAsync($"NexusBrowser: session {session[..8]} (Claude) opened", TimeSpan.FromSeconds(3));
        Assert.Equal(HttpStatusCode.OK, await daemon.ListToolsAsync("claude", session));

        // The daemon's 1 s tick expires it once idle for more than the configured second.
        await daemon.WaitForStderrAsync($"NexusBrowser: session {session[..8]} (Claude) expired after 1 s idle", TimeSpan.FromSeconds(5));
        await bridge.WaitForAsync(r => r.Gone.Contains(Identity("Claude", session)), TimeSpan.FromSeconds(3));
        Assert.Equal(HttpStatusCode.NotFound, await daemon.ListToolsAsync("claude", session));
        await daemon.WaitForStderrAsync($"NexusBrowser: unknown session {session[..8]} (Claude): 404, the client starts a new one", TimeSpan.FromSeconds(3));
    }

    [Fact]
    public async Task WithTheDefaultIdleASessionSurvivesAPause()
    {
        using var bridge = new FakeBridge((_, _) => new JsonArray());
        using var daemon = await Daemon.StartAsync(bridge, _dir);
        string session = await daemon.OpenSessionAsync("claude");
        await Task.Delay(TimeSpan.FromSeconds(3), TestContext.Current.CancellationToken); // three expiry ticks of the daemon
        Assert.Equal(HttpStatusCode.OK, await daemon.ListToolsAsync("claude", session));
        Assert.DoesNotContain("expired", daemon.Process.Stderr);
    }

    [Fact]
    public async Task DeletedSessionIsAnnouncedAtOnceThroughAnotherLiveSession()
    {
        using var bridge = new FakeBridge((action, _) => action == "list-tabs" ? new JsonArray() : new JsonObject());
        using var daemon = await Daemon.StartAsync(bridge, _dir);
        string a = await daemon.OpenSessionAsync("claude");
        string b = await daemon.OpenSessionAsync("claude");
        string idA = Identity("Claude", a), idB = Identity("Claude", b);

        // The daemon's own first beat of B (the next one is ~37 s later): any later heartbeat is the announcement.
        await bridge.WaitForAsync(r => r.Action == "heartbeat" && r.Header(BridgeSecurity.ClientHeader) == idB, TimeSpan.FromSeconds(5));
        int before = bridge.Requests.Count;

        using (var deleted = await daemon.SendAsync(HttpMethod.Delete, "claude", null, a))
            Assert.Equal(HttpStatusCode.OK, deleted.StatusCode);
        await daemon.WaitForStderrAsync($"NexusBrowser: session {a[..8]} (Claude) closed by the client (DELETE)", TimeSpan.FromSeconds(3));

        var clock = Stopwatch.StartNew();
        var announced = await bridge.WaitForAsync(r => bridge.Requests.IndexOf(r) >= before && r.Action == "heartbeat" && r.Gone.Contains(idA), TimeSpan.FromSeconds(3));
        Assert.True(clock.Elapsed < TimeSpan.FromSeconds(3));
        Assert.Equal($"claude-daemon-{daemon.Process.Process.Id}", announced.Header(BridgeSecurity.ClientHeader));
        Assert.Equal("Claude", announced.Header(BridgeSecurity.AgentHeader));
        Assert.DoesNotContain(idB, announced.Gone);

        // B's next tool call still carries A until the extension's silence delay would have declared it dead.
        var result = await daemon.CallToolAsync("claude", b, "browser_list_tabs");
        Assert.False((bool)result["result"]!["isError"]!, result.ToJsonString());
        var call = bridge.Requests.Last(r => r.Action == "list-tabs");
        Assert.Equal(idB, call.Header(BridgeSecurity.ClientHeader));
        Assert.Equal([idA], call.Gone);

        // A is gone for good; another agent never receives Claude's closed sessions.
        using (var again = await daemon.SendAsync(HttpMethod.Post, "claude", """{"jsonrpc":"2.0","id":4,"method":"tools/list"}""", a))
            Assert.Equal(HttpStatusCode.NotFound, again.StatusCode);
        string codex = await daemon.OpenSessionAsync("codex");
        await daemon.CallToolAsync("codex", codex, "browser_list_tabs");
        var codexCall = bridge.Requests.Last(r => r.Action == "list-tabs");
        Assert.Equal(Identity("Codex", codex), codexCall.Header(BridgeSecurity.ClientHeader));
        Assert.Null(codexCall.Header(BridgeSecurity.GoneHeader));
    }

    [Fact]
    public async Task LastSessionIsAnnouncedImmediatelyAndTheNextCallStillCarriesIt()
    {
        using var bridge = new FakeBridge((action, _) => action == "list-tabs" ? new JsonArray() : new JsonObject());
        using var daemon = await Daemon.StartAsync(bridge, _dir);
        string a = await daemon.OpenSessionAsync("claude");
        using (var deleted = await daemon.SendAsync(HttpMethod.Delete, "claude", null, a))
            Assert.Equal(HttpStatusCode.OK, deleted.StatusCode);
        await daemon.WaitForStderrAsync($"session {a[..8]} (Claude) closed by the client (DELETE)", TimeSpan.FromSeconds(3));
        var announced = await bridge.WaitForAsync(r => r.Gone.Contains(Identity("Claude", a)), TimeSpan.FromSeconds(3));
        Assert.Equal($"claude-daemon-{daemon.Process.Process.Id}", announced.Header(BridgeSecurity.ClientHeader));
        Assert.False((bool)announced.Body["params"]!["reclaim"]!);

        string c = await daemon.OpenSessionAsync("claude");
        await daemon.CallToolAsync("claude", c, "browser_list_tabs");
        var call = bridge.Requests.Last(r => r.Action == "list-tabs");
        Assert.Equal([Identity("Claude", a)], call.Gone);
    }
}

/// <summary>Idle lease of the daemon's HTTP sessions (process environment: NEXUS_BROWSER_SESSION_IDLE_SECONDS).</summary>
[Collection(ProcessEnvironmentCollection.Name)]
public sealed class SessionIdleSettingTests
{
    private static double Idle(McpServer server) =>
        (double)typeof(McpServer).GetField("_sessionIdleSeconds", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(server)!;

    [Fact]
    public void DefaultIdleIs1618Seconds()
    {
        using var _ = new EnvScope(("NEXUS_BROWSER_SESSION_IDLE_SECONDS", null));
        using var server = new McpServer(agent: "Claude", bridgeHttpPort: 1);
        Assert.Equal(1618, Idle(server));
    }

    [Theory]
    [InlineData("1618", 1618)]
    [InlineData("0.25", 0.25)]
    public void ConfiguredIdleUpTo1618IsKept(string value, double expected)
    {
        using var _ = new EnvScope(("NEXUS_BROWSER_SESSION_IDLE_SECONDS", value));
        using var server = new McpServer(agent: "Claude", bridgeHttpPort: 1);
        Assert.Equal(expected, Idle(server));
    }

    [Theory]
    [InlineData("1619")]
    [InlineData("0")]
    [InlineData("-1")]
    [InlineData("NaN")]
    [InlineData("soon")]
    public void InvalidIdleIsRefused(string value)
    {
        using var _ = new EnvScope(("NEXUS_BROWSER_SESSION_IDLE_SECONDS", value));
        var error = Assert.Throws<ArgumentException>(() => new McpServer(agent: "Claude", bridgeHttpPort: 1));
        Assert.Contains("at most 1618 seconds", error.Message);
    }
}

/// <summary>The bridge merges X-Nexus-Browser-Gone into the "gone" list it sends to the extension.</summary>
public sealed class BridgeGoneHeaderTests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    [Fact]
    public async Task GoneHeaderIsForwardedWithoutTheCallerOrInvalidIds()
    {
        var ct = TestContext.Current.CancellationToken;
        string tokenFile = _dir["bridge-token"];
        string token = BridgeSecurity.LoadOrCreateToken(tokenFile);
        await using var bridge = new BridgeServer(port: 0, httpPort: 0, tokenFile: tokenFile, allowedOrigins: [FakeExtension.Origin]);
        bridge.Start();
        using var ws = await FakeExtension.ConnectAsync(bridge.WsPort);
        var (_, _, channel) = await FakeExtension.HandshakeAsync(ws, token, "native", "service_worker");
        var received = new List<JsonObject>();
        using var responder = new CancellationTokenSource();
        var responderTask = FakeExtension.RespondAsync(ws, channel, received, _ => new JsonArray(), responder.Token);

        using var http = new HttpClient();
        async Task<JsonObject> Command(string client, string? gone)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{bridge.HttpPort}/api/command")
            {
                Content = new StringContent("""{"action":"list-tabs","params":{},"timeout":5}""", Encoding.UTF8, "application/json"),
            };
            request.Headers.Add(BridgeSecurity.TokenHeader, token);
            request.Headers.Add(BridgeSecurity.AgentHeader, "Claude");
            request.Headers.Add(BridgeSecurity.ClientHeader, client);
            if (gone is not null) request.Headers.TryAddWithoutValidation(BridgeSecurity.GoneHeader, gone);
            int before;
            lock (received) before = received.Count;
            using var response = await http.SendAsync(request, ct);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            lock (received) return received[before];
        }

        var forwarded = await Command("claude-caller0001", " claude-oldsession01 ,claude-caller0001,bad id!,x,claude-oldsession01,claude-oldsession02");
        Assert.Equal(["claude-oldsession01", "claude-oldsession02"], (forwarded["gone"] as JsonArray ?? []).Select(g => (string)g!));

        var many = string.Join(",", Enumerable.Range(0, 40).Select(i => $"claude-old{i:D6}"));
        var capped = await Command("claude-caller0001", many);
        Assert.Equal(Enumerable.Range(0, 32).Select(i => $"claude-old{i:D6}"), (capped["gone"] as JsonArray ?? []).Select(g => (string)g!));

        var none = await Command("claude-caller0001", null);
        Assert.Empty(none["gone"] as JsonArray ?? []);
        var onlyMine = await Command("claude-caller0001", "claude-caller0001");
        Assert.Empty(onlyMine["gone"] as JsonArray ?? []);

        responder.Cancel();
        try { await responderTask; } catch (OperationCanceledException) { }
    }
}
