using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using NexusBrowser.Native;
using Xunit;

namespace NexusBrowser.Tests;

public sealed class DaemonRestartTests : IDisposable
{
    private readonly TempDir _dir = new();
    public void Dispose() => _dir.Dispose();

    [Fact]
    public async Task AValidIdleSessionWithNoTabsSurvivesThreeRestartPollsAndDeleteThenAllowsNormalExit()
    {
        using var bridge = new FakeBridge((_, _) => new JsonArray());
        using var daemon = await Daemon.StartAsync(bridge, _dir);
        string sid = await daemon.OpenSessionAsync("antigravity");
        Assert.Equal(HttpStatusCode.OK, await daemon.ListToolsAsync("antigravity", sid));
        using var http = new HttpClient();
        using (var anonymous = await http.GetAsync(daemon.Base + "/restart-capabilities", TestContext.Current.CancellationToken)) Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);
        string tokenFile = _dir["mcp-token"];
        File.WriteAllText(tokenFile, daemon.Token);
        var requested = await ChildProcess.RunAsync(NativeExe.Path, ["--restart-daemon", "--port", new Uri(daemon.Base).Port.ToString(),
            "--expected-pid", daemon.Process.Process.Id.ToString(), "--request-file", daemon.RestartPath, "--target-fingerprint", new string('a', 64),
            "--mcp-token-file", tokenFile, "--wait-seconds", "0.1"]);
        Assert.Equal(3, requested.Code);
        Assert.True(JsonNode.Parse(requested.Stdout)!["requested"]!.GetValue<bool>());
        await Task.Delay(4200, TestContext.Current.CancellationToken); // production watcher: t=0,2,4 seconds
        Assert.False(daemon.Process.Process.HasExited);
        Assert.Empty(bridge.Commands); // no tabs, no ongoing bridge calls
        Assert.Equal(HttpStatusCode.OK, await daemon.ListToolsAsync("antigravity", sid));
        using (var deleted = await daemon.SendAsync(HttpMethod.Delete, "antigravity", null, sid)) Assert.Equal(HttpStatusCode.OK, deleted.StatusCode);
        await daemon.Process.Process.WaitForExitAsync(TestContext.Current.CancellationToken).WaitAsync(TimeSpan.FromSeconds(4), TestContext.Current.CancellationToken);
        Assert.Equal(0, daemon.Process.Process.ExitCode);
    }

    [Fact]
    public async Task IdleSessionExpiryAlsoAllowsNormalRestartWithoutAClientDelete()
    {
        using var bridge = new FakeBridge((_, _) => new JsonArray());
        using var daemon = await Daemon.StartAsync(bridge, _dir, idleSeconds: "0.3");
        string sid = await daemon.OpenSessionAsync("codex");
        File.WriteAllText(daemon.RestartPath, "force");
        await daemon.Process.Process.WaitForExitAsync(TestContext.Current.CancellationToken).WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        Assert.Equal(0, daemon.Process.Process.ExitCode);
        Assert.Contains($"session {sid[..8]} (Codex) expired", daemon.Process.Stderr);
    }

    private sealed class Capabilities(string json, HttpStatusCode status = HttpStatusCode.OK) : HttpMessageHandler
    {
        public int Requests;
        public string? Authorization;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests++; Authorization = request.Headers.Authorization?.ToString();
            Assert.Equal(HttpMethod.Get, request.Method);
            Assert.EndsWith("/restart-capabilities", request.RequestUri!.AbsolutePath);
            return Task.FromResult(Answer());
        }

        // The caller (HttpClient) owns and disposes the response.
        private HttpResponseMessage Answer() => new(status) { Content = new StringContent(json) };
    }

    [Theory]
    [InlineData("legacy2330")]
    [InlineData("legacy2332")]
    [InlineData("wrong-pid")]
    [InlineData("missing-instance")]
    [InlineData("wrong-schema")]
    [InlineData("no-guarantee")]
    [InlineData("malformed")]
    [InlineData("unauthorized")]
    public async Task LegacyUnknownOrMismatchedDaemonNeverGetsARequestFile(string scenario)
    {
        string json = """{"service":"nexus-browser","preserve_http_sessions":true,"request_schema":1,"pid":123,"instance_id":"0123456789abcdef0123456789abcdef"}""";
        if (scenario.StartsWith("legacy")) json = "{\"status\":\"ok\",\"version\":\"" + (scenario == "legacy2330" ? "2.33.0" : "2.33.2") + "\"}";
        else if (scenario == "wrong-pid") json = json.Replace("123", "456");
        else if (scenario == "missing-instance") json = json.Replace("0123456789abcdef0123456789abcdef", "");
        else if (scenario == "wrong-schema") json = json.Replace("\"request_schema\":1", "\"request_schema\":2");
        else if (scenario == "no-guarantee") json = json.Replace("true", "false");
        else if (scenario == "malformed") json = "[]";
        using var handler = new Capabilities(json, scenario == "unauthorized" ? HttpStatusCode.Unauthorized : HttpStatusCode.OK);
        using var http = new HttpClient(handler);
        string path = _dir["restart.request"];
        var result = await DaemonRestart.RunAsync(http, 16182, new string('s', 64), 123, path, new string('a', 64), 0.1, _ => true, TestContext.Current.CancellationToken);
        Assert.Equal(3, result.Code);
        Assert.False(result.Report["requested"]!.GetValue<bool>());
        Assert.False(File.Exists(path));
        Assert.Equal("Bearer " + new string('s', 64), handler.Authorization);
    }

    [Fact]
    public void EveryInstallerPathUsesTheCurrentControllerAndNeverWritesALegacyRequest()
    {
        string install = File.ReadAllText(Repo.File("scripts", "install-native.ps1"));
        Assert.Equal(2, install.Split("$restart = Invoke-Native $controlExe @('--restart-daemon'").Length - 1);
        Assert.DoesNotContain("WriteAllText($restartRequest", install);
        Assert.DoesNotContain("Stop-Process", install);
        Assert.DoesNotContain("Stop-ScheduledTask", install);
    }
}

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class HttpRestartRaceTests : IDisposable
{
    private readonly TempDir _dir = new();
    public void Dispose() => _dir.Dispose();

    private async Task WaitUntilAsync(Func<bool> condition)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (!condition()) await Task.Delay(10, timeout.Token);
    }

    private static HttpRequestMessage Rpc(string url, string method, string? sid = null)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, url + "/mcp?agent=codex")
        { Content = new StringContent($"{{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"{method}\",\"params\":{{\"protocolVersion\":\"2025-06-18\"}}}}", Encoding.UTF8, "application/json") };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", new string('r', 64));
        if (sid is not null) request.Headers.Add("mcp-session-id", sid);
        return request;
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AnAdmittedResponsePreventsRestartEvenAfterDeleteOrWhileInitializeIsStillUnflushed(bool initialize)
    {
        using var bridge = new FakeBridge((_, _) => new JsonArray());
        using var env = new EnvScope(("NEXUS_MCP_TOKEN", new string('r', 64)), ("NEXUS_BROWSER_SESSION_IDLE_SECONDS", "1"),
            ("NEXUS_BROWSER_RESTART_REQUEST", _dir["restart.request"]));
        using var server = new McpServer("Codex", bridge.Port, bridge.TokenFile) { RestartPollSeconds = 0.02 };
        using var stop = new CancellationTokenSource();
        int port = Ports.Free(); string url = $"http://127.0.0.1:{port}";
        var running = server.RunHttpAsync(port, stop.Token);
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        string? sid = null;
        if (!initialize)
        {
            using var open = Rpc(url, "initialize"); using var opened = await http.SendAsync(open, TestContext.Current.CancellationToken);
            sid = opened.Headers.GetValues("mcp-session-id").Single();
        }
        server.BeforeHttpReplyAsync = () => { reached.TrySetResult(); return release.Task; };
        try
        {
            using var request = Rpc(url, initialize ? "initialize" : "tools/list", sid);
            var responseTask = http.SendAsync(request, TestContext.Current.CancellationToken);
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(3), TestContext.Current.CancellationToken);
            Assert.Equal(0, server.RunningCalls); // RPC is done; only HTTP transport still holds the response
            File.WriteAllText(_dir["restart.request"], "force");
            if (!initialize)
            {
                using var delete = new HttpRequestMessage(HttpMethod.Delete, url + "/mcp?agent=codex");
                delete.Headers.Authorization = new AuthenticationHeaderValue("Bearer", new string('r', 64));
                delete.Headers.Add("mcp-session-id", sid);
                using var deleted = await http.SendAsync(delete, TestContext.Current.CancellationToken); Assert.Equal(HttpStatusCode.OK, deleted.StatusCode);
            }
            await Task.Delay(1200, TestContext.Current.CancellationToken); // > two polls and the short session idle lease
            Assert.False(running.IsCompleted);
            release.TrySetResult();
            using var response = await responseTask;
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.NotNull(JsonNode.Parse(await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken))!["result"]);
            if (!initialize) Assert.Equal(49, JsonNode.Parse(await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken))!["result"]!["tools"]!.AsArray().Count);
            if (initialize)
            {
                server.BeforeHttpReplyAsync = null;
                sid = response.Headers.GetValues("mcp-session-id").Single();
                using var next = Rpc(url, "tools/list", sid); using var nextResponse = await http.SendAsync(next, TestContext.Current.CancellationToken);
                Assert.Equal(HttpStatusCode.OK, nextResponse.StatusCode); // never return a dangling initialize SID
                using var delete = new HttpRequestMessage(HttpMethod.Delete, url + "/mcp?agent=codex");
                delete.Headers.Authorization = new AuthenticationHeaderValue("Bearer", new string('r', 64)); delete.Headers.Add("mcp-session-id", sid);
                using var deleted = await http.SendAsync(delete, TestContext.Current.CancellationToken); Assert.Equal(HttpStatusCode.OK, deleted.StatusCode);
            }
            await running.WaitAsync(TimeSpan.FromSeconds(3), TestContext.Current.CancellationToken);
        }
        finally { release.TrySetResult(); stop.Cancel(); await running; }
    }

    [Fact]
    public async Task AnIdleSessionDelaysRestartOnlyForTheGracePeriod()
    {
        using var bridge = new FakeBridge((_, _) => new JsonArray());
        using var env = new EnvScope(("NEXUS_MCP_TOKEN", new string('r', 64)), ("NEXUS_BROWSER_RESTART_REQUEST", _dir["restart.request"]));
        using var server = new McpServer("Codex", bridge.Port, bridge.TokenFile) { RestartPollSeconds = 0.02, RestartGraceSeconds = 0.5 };
        using var stop = new CancellationTokenSource();
        int port = Ports.Free(); string url = $"http://127.0.0.1:{port}";
        var running = server.RunHttpAsync(port, stop.Token);
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
            using var open = Rpc(url, "initialize"); using var opened = await http.SendAsync(open, TestContext.Current.CancellationToken);
            Assert.Equal(HttpStatusCode.OK, opened.StatusCode);
            File.WriteAllText(_dir["restart.request"], "force");
            await Task.Delay(200, TestContext.Current.CancellationToken); // the idle session is still waited for
            Assert.False(running.IsCompleted);
            await running.WaitAsync(TimeSpan.FromSeconds(3), TestContext.Current.CancellationToken);
        }
        finally { stop.Cancel(); await running; }
    }

    [Fact]
    public async Task InitializeAlreadyAdmittedButStillReadingItsBodyWinsAgainstDrainAndKeepsItsSid()
    {
        using var bridge = new FakeBridge((_, _) => new JsonArray());
        using var env = new EnvScope(("NEXUS_MCP_TOKEN", new string('r', 64)), ("NEXUS_BROWSER_RESTART_REQUEST", _dir["restart.request"]));
        using var server = new McpServer("Codex", bridge.Port, bridge.TokenFile) { RestartPollSeconds = 0.02 };
        using var stop = new CancellationTokenSource();
        int port = Ports.Free(); string url = $"http://127.0.0.1:{port}";
        var running = server.RunHttpAsync(port, stop.Token);
        try
        {
            using var client = new System.Net.Sockets.TcpClient();
            await client.ConnectAsync(IPAddress.Loopback, port, TestContext.Current.CancellationToken);
            var stream = client.GetStream();
            const string body = """{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}""";
            string head = $"POST /mcp?agent=codex HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {new string('r', 64)}\r\nContent-Length: {Encoding.UTF8.GetByteCount(body)}\r\n\r\n";
            await stream.WriteAsync(Encoding.UTF8.GetBytes(head + body[..1]), TestContext.Current.CancellationToken);
            await WaitUntilAsync(() => server.ActiveHttpTransports == 1);
            File.WriteAllText(_dir["restart.request"], "force");
            await Task.Delay(150, TestContext.Current.CancellationToken); // many restart polls while initialize has not reached the session lock yet
            Assert.False(running.IsCompleted);
            await stream.WriteAsync(Encoding.UTF8.GetBytes(body[1..]), TestContext.Current.CancellationToken);
            using var reader = new StreamReader(stream);
            string reply = await reader.ReadToEndAsync(TestContext.Current.CancellationToken).WaitAsync(TimeSpan.FromSeconds(3), TestContext.Current.CancellationToken);
            Assert.StartsWith("HTTP/1.1 200", reply);
            string sid = reply.Split("\r\n").Single(l => l.StartsWith("mcp-session-id:", StringComparison.OrdinalIgnoreCase)).Split(':', 2)[1].Trim();
            using var http = new HttpClient();
            using var next = Rpc(url, "tools/list", sid); using var tools = await http.SendAsync(next, TestContext.Current.CancellationToken);
            Assert.Equal(HttpStatusCode.OK, tools.StatusCode);
            using var delete = new HttpRequestMessage(HttpMethod.Delete, url + "/mcp?agent=codex");
            delete.Headers.Authorization = new AuthenticationHeaderValue("Bearer", new string('r', 64)); delete.Headers.Add("mcp-session-id", sid);
            using var deleted = await http.SendAsync(delete, TestContext.Current.CancellationToken); Assert.Equal(HttpStatusCode.OK, deleted.StatusCode);
            await running.WaitAsync(TimeSpan.FromSeconds(3), TestContext.Current.CancellationToken);
            // Drain won now: a later initialize cannot receive a success and an already-dead SID.
            using var late = Rpc(url, "initialize");
            await Assert.ThrowsAsync<HttpRequestException>(() => http.SendAsync(late, TestContext.Current.CancellationToken));
        }
        finally { stop.Cancel(); await running; }
    }
}
