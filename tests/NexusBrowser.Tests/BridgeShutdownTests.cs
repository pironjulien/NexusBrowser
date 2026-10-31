using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using NexusBrowser.Native;
using Xunit;

namespace NexusBrowser.Tests;

public sealed class BridgeShutdownTests : IDisposable
{
    private readonly TempDir _dir = new();
    public void Dispose() => _dir.Dispose();

    [Fact]
    public async Task ShutdownRequiresAuthenticationExactInstanceAndUnownedTabsInEveryProfile()
    {
        string tokenFile = _dir["token"];
        string token = BridgeSecurity.LoadOrCreateToken(tokenFile);
        await using var bridge = new BridgeServer(port: 0, tokenFile: tokenFile, allowedOrigins: [FakeExtension.Origin]);
        bridge.Start();
        using var ws = await FakeExtension.ConnectAsync(bridge.WsPort);
        var (_, _, channel) = await FakeExtension.HandshakeAsync(ws, token, "native", "service_worker");
        int ownership = 0;
        var received = new List<JsonObject>();
        using var stop = new CancellationTokenSource();
        var responder = FakeExtension.RespondAsync(ws, channel, received, _ => ownership == 1 ? new JsonArray(new JsonObject()) :
            new JsonArray(new JsonObject { ["id"] = 17, ["owner"] = ownership == 0 ? "Codex" : null, ["state"] = ownership == 0 ? "other" : "user" }), stop.Token);
        // A newer profile with no owned tab becomes SelectTarget: the earlier profile must still be checked.
        using var otherProfile = await FakeExtension.ConnectAsync(bridge.WsPort);
        var (_, _, otherChannel) = await FakeExtension.HandshakeAsync(otherProfile, token, "native", "service_worker");
        var otherResponder = FakeExtension.RespondAsync(otherProfile, otherChannel, [], _ => new JsonArray(), stop.Token);
        using var http = new HttpClient();
        string url = $"http://127.0.0.1:{bridge.HttpPort}";
        using (var empty = new StringContent("{}"))
        using (var anonymous = await http.PostAsync(url + "/api/shutdown", empty, TestContext.Current.CancellationToken))
            Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);
        http.DefaultRequestHeaders.Add(BridgeSecurity.TokenHeader, token);
        var state = JsonNode.Parse(await http.GetStringAsync(url + "/api/status", TestContext.Current.CancellationToken))!;
        async Task<HttpResponseMessage> Shutdown(string instance)
        {
            using var body = new StringContent(new JsonObject { ["pid"] = Environment.ProcessId, ["instance_id"] = instance }.ToJsonString(), Encoding.UTF8, "application/json");
            return await http.PostAsync(url + "/api/shutdown", body, TestContext.Current.CancellationToken);
        }
        foreach (string malformed in new[] { "[]", "{}", "{\"instance_id\":4,\"pid\":\"x\"}" })
        {
            using var body = new StringContent(malformed);
            using var refused = await http.PostAsync(url + "/api/shutdown", body, TestContext.Current.CancellationToken);
            Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        }
        using (var wrong = await Shutdown("another-instance")) Assert.Equal(HttpStatusCode.Conflict, wrong.StatusCode);
        using (var busy = await Shutdown(state["instance_id"]!.ToString())) Assert.Equal(HttpStatusCode.Conflict, busy.StatusCode);
        Assert.False(bridge.ShutdownRequested.IsCompleted);
        Assert.Equal("list_tabs", Assert.Single(received)["action"]!.ToString()); // ownership read only, no tab closed
        ownership = 1;
        using (var malformedOwnership = await Shutdown(state["instance_id"]!.ToString())) Assert.Equal(HttpStatusCode.Conflict, malformedOwnership.StatusCode);
        Assert.False(bridge.ShutdownRequested.IsCompleted);
        ownership = 2;
        using (var accepted = await Shutdown(state["instance_id"]!.ToString())) Assert.Equal(HttpStatusCode.OK, accepted.StatusCode);
        await bridge.ShutdownRequested.WaitAsync(TimeSpan.FromSeconds(3), TestContext.Current.CancellationToken);
        await Assert.ThrowsAsync<InvalidOperationException>(() => bridge.SendCommandToChromeAsync("create_tab"));
        Assert.All(received, command => Assert.Equal("list_tabs", command["action"]!.ToString()));
        stop.Cancel();
        await Task.WhenAll(responder, otherResponder);
    }

    [Fact]
    public async Task RunningCommandFinishesBeforeShutdownCanBeAccepted()
    {
        string tokenFile = _dir["token"];
        string token = BridgeSecurity.LoadOrCreateToken(tokenFile);
        await using var bridge = new BridgeServer(port: 0, tokenFile: tokenFile, allowedOrigins: [FakeExtension.Origin]);
        bridge.Start();
        using var ws = await FakeExtension.ConnectAsync(bridge.WsPort);
        var (_, _, channel) = await FakeExtension.HandshakeAsync(ws, token, "native", "service_worker");
        var arrived = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        using var stop = new CancellationTokenSource();
        var responder = FakeExtension.RespondAsync(ws, channel, [], command =>
        {
            if (command["action"]!.ToString() == "eval") { arrived.TrySetResult(); Assert.True(release.Wait(TimeSpan.FromSeconds(10))); return new JsonObject { ["finished"] = true }; }
            return new JsonArray();
        }, stop.Token);
        using var http = new HttpClient();
        http.DefaultRequestHeaders.Add(BridgeSecurity.TokenHeader, token);
        string url = $"http://127.0.0.1:{bridge.HttpPort}";
        var state = JsonNode.Parse(await http.GetStringAsync(url + "/api/status", TestContext.Current.CancellationToken))!;
        var running = bridge.SendCommandToChromeAsync("eval", new JsonObject(), 10, ("Codex", "codex-active-call"));
        try
        {
            await arrived.Task.WaitAsync(TimeSpan.FromSeconds(3), TestContext.Current.CancellationToken);
            using var body = new StringContent(new JsonObject { ["pid"] = Environment.ProcessId, ["instance_id"] = state["instance_id"]!.ToString() }.ToJsonString(), Encoding.UTF8, "application/json");
            using var refusal = await http.PostAsync(url + "/api/shutdown", body, TestContext.Current.CancellationToken);
            Assert.Equal(HttpStatusCode.Conflict, refusal.StatusCode);
            Assert.False(bridge.ShutdownRequested.IsCompleted);
        }
        finally { release.Set(); }
        Assert.True((bool)(await running)!["finished"]!);
        stop.Cancel();
        await responder;
    }

    [Fact]
    public void InstallerNeverTerminatesAnExistingBridgeOrDaemon()
    {
        string install = File.ReadAllText(Repo.File("install.ps1")) + File.ReadAllText(Repo.File("scripts", "install-native.ps1"));
        Assert.DoesNotContain("Stop-Process", install);
        Assert.DoesNotContain("Stop-ScheduledTask", install);
        Assert.Contains("--shutdown-bridge", install);
        Assert.Contains("--expected-pid", install);
    }

    [Fact]
    public async Task TargetedBridgeProcessExitsNormallyOnlyAfterItsOwnershipIsFree()
    {
        string tokenFile = _dir["token"];
        string token = BridgeSecurity.LoadOrCreateToken(tokenFile);
        using var bridge = new ChildProcess(NativeExe.Path, ["--bridge", "--port", "0", "--token-file", tokenFile]);
        async Task<string> Line() => await bridge.Process.StandardOutput.ReadLineAsync(TestContext.Current.CancellationToken).AsTask()
            .WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken) ?? throw new InvalidOperationException(bridge.Stderr);
        await Line(); await Line();
        int wsPort = new Uri((await Line()).Trim()["WebSocket: ".Length..]).Port;
        int httpPort = new Uri((await Line()).Trim()["HTTP REST: ".Length..]).Port;
        using var ws = await FakeExtension.ConnectAsync(wsPort);
        var (_, _, channel) = await FakeExtension.HandshakeAsync(ws, token, "native", "service_worker");
        bool owned = true;
        using var stop = new CancellationTokenSource();
        var responder = FakeExtension.RespondAsync(ws, channel, [], _ => new JsonArray(new JsonObject { ["id"] = 17, ["owner"] = owned ? "Codex" : null, ["state"] = owned ? "other" : "user" }), stop.Token);
        using var http = new HttpClient();
        var refusal = await BridgeShutdown.RunAsync(http, httpPort, tokenFile, bridge.Process.Id, 3, ct: TestContext.Current.CancellationToken);
        Assert.Equal(3, refusal.Code);
        Assert.False(bridge.Process.HasExited);
        owned = false;
        var accepted = await BridgeShutdown.RunAsync(http, httpPort, tokenFile, bridge.Process.Id, 3, ct: TestContext.Current.CancellationToken);
        Assert.Equal(0, accepted.Code);
        Assert.True(bridge.Process.HasExited);
        Assert.Equal(0, bridge.Process.ExitCode);
        stop.Cancel();
        await responder;
    }

    private sealed class LegacyBridge : HttpMessageHandler
    {
        public int Posts;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.Method == HttpMethod.Post) Posts++;
            return Task.FromResult(Online());
        }

        // The caller (HttpClient) owns and disposes the response.
        private static HttpResponseMessage Online() => new(HttpStatusCode.OK) { Content = new StringContent("""{"status":"online","version":"2.33.0"}""") };
    }

    [Fact]
    public async Task OlderBridgeWithoutCooperativeProtocolIsDeferredWithoutAStopRequest()
    {
        string tokenFile = _dir["token"];
        BridgeSecurity.LoadOrCreateToken(tokenFile);
        using var handler = new LegacyBridge();
        using var http = new HttpClient(handler);
        var result = await BridgeShutdown.RunAsync(http, 9225, tokenFile, 123, 1, _ => true, TestContext.Current.CancellationToken);
        Assert.Equal(3, result.Code);
        Assert.False((bool)result.Report["stopped"]!);
        Assert.Equal(0, handler.Posts);
    }
}
