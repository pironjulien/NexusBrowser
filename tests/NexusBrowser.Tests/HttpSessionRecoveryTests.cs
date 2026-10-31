using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using NexusBrowser.Native;
using Xunit;

namespace NexusBrowser.Tests;

/// <summary>Legacy Streamable HTTP sessions follow the official 2025-06-18 and 2025-11-25 lifecycle: a terminated
/// id remains 404, including on initialize; recovery is a new initialize without that id. A client retaining its
/// stale header cannot recover by repeating the same request. No real Chrome, profile or token is used.</summary>
public sealed class HttpSessionRecoveryTests : IDisposable
{
    private readonly TempDir _dir = new();
    public void Dispose() => _dir.Dispose();

    [Theory]
    [InlineData("2025-06-18")]
    [InlineData("2025-11-25")]
    public async Task ReinitializeWithAnExpiredIdIs404AndWithoutItCreatesAnIsolatedFreshSession(string protocol)
    {
        using var bridge = new FakeBridge((action, _) => action == "list-tabs" ? new JsonArray() : new JsonObject());
        // Long enough that the fresh session never expires between this test's own requests on a loaded CI runner;
        // the first session is left idle on purpose and its expiry is awaited.
        using var daemon = await Daemon.StartAsync(bridge, _dir, idleSeconds: "2");
        string initialize = new JsonObject { ["jsonrpc"] = "2.0", ["id"] = 1, ["method"] = "initialize",
            ["params"] = new JsonObject { ["protocolVersion"] = protocol, ["capabilities"] = new JsonObject(),
                ["clientInfo"] = new JsonObject { ["name"] = "interop-fixture", ["version"] = "1" } } }.ToJsonString();
        string original;
        using (var opened = await daemon.SendAsync(HttpMethod.Post, "codex", initialize))
        {
            Assert.Equal(HttpStatusCode.OK, opened.StatusCode);
            original = opened.Headers.GetValues("mcp-session-id").Single();
        }
        await daemon.CallToolAsync("codex", original, "browser_list_tabs");
        var oldCall = bridge.Requests.Last(r => r.Action == "list-tabs");
        await daemon.WaitForStderrAsync($"session {original[..8]} (Codex) expired", TimeSpan.FromSeconds(15));

        using (var staleInitialize = await daemon.SendAsync(HttpMethod.Post, "codex", initialize, original))
        {
            Assert.Equal(HttpStatusCode.NotFound, staleInitialize.StatusCode);
            Assert.False(staleInitialize.Headers.Contains("mcp-session-id"));
        }
        Assert.Equal(HttpStatusCode.NotFound, await daemon.ListToolsAsync("codex", original));
        string fresh;
        using (var recovered = await daemon.SendAsync(HttpMethod.Post, "codex", initialize))
        {
            Assert.Equal(HttpStatusCode.OK, recovered.StatusCode);
            fresh = recovered.Headers.GetValues("mcp-session-id").Single();
            Assert.NotEqual(original, fresh);
            Assert.Equal(protocol, JsonNode.Parse(await recovered.Content.ReadAsStringAsync(TestContext.Current.CancellationToken))!["result"]!["protocolVersion"]!.ToString());
        }
        Assert.Equal(HttpStatusCode.OK, await daemon.ListToolsAsync("codex", fresh));
        await daemon.CallToolAsync("codex", fresh, "browser_list_tabs");
        var newCall = bridge.Requests.Last(r => r.Action == "list-tabs");
        Assert.NotEqual(oldCall.Header(BridgeSecurity.ClientHeader), newCall.Header(BridgeSecurity.ClientHeader));
        Assert.Contains(oldCall.Header(BridgeSecurity.ClientHeader)!, newCall.Gone);
        using (var anotherAgent = await daemon.SendAsync(HttpMethod.Post, "antigravity", initialize, fresh))
            Assert.Equal(HttpStatusCode.NotFound, anotherAgent.StatusCode);
        using var unauthorizedClient = new HttpClient();
        using var badToken = new HttpRequestMessage(HttpMethod.Post, daemon.Base + "/mcp?agent=codex")
        { Content = new StringContent(initialize, Encoding.UTF8, "application/json") };
        badToken.Headers.Authorization = new AuthenticationHeaderValue("Bearer", new string('x', 64));
        badToken.Headers.Add("mcp-session-id", original);
        using var refused = await unauthorizedClient.SendAsync(badToken, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.Unauthorized, refused.StatusCode);
        Assert.DoesNotContain(bridge.Requests, request => request.Action is "adopt-tab" or "create-tab");
    }

    [Fact]
    public async Task AntigravityKeepsItsExpiredIdBecauseItsClientNeverInitializesAgain()
    {
        using var bridge = new FakeBridge((action, _) => action == "list-tabs" ? new JsonArray() : new JsonObject());
        using var daemon = await Daemon.StartAsync(bridge, _dir, idleSeconds: "2");
        string original = await daemon.OpenSessionAsync("antigravity");
        await daemon.WaitForStderrAsync($"session {original[..8]} (Antigravity) expired", TimeSpan.FromSeconds(15));
        Assert.Equal(HttpStatusCode.NotFound, await daemon.ListToolsAsync("codex", original));  // never another agent's
        Assert.Equal(HttpStatusCode.OK, await daemon.ListToolsAsync("antigravity", original));
        await daemon.WaitForStderrAsync($"session {original[..8]} (Antigravity) resumed", TimeSpan.FromSeconds(3));
        await daemon.CallToolAsync("antigravity", original, "browser_list_tabs");
        Assert.Equal(Identity("Antigravity", original), bridge.Requests.Last(r => r.Action == "list-tabs").Header(BridgeSecurity.ClientHeader));
        Assert.Equal(HttpStatusCode.NotFound, await daemon.ListToolsAsync("antigravity", "not-a-daemon-session-id"));
    }

    [Fact]
    public async Task ClaudeKeepsItsExpiredIdButNeverOneItClosed()
    {
        using var bridge = new FakeBridge((action, _) => action == "list-tabs" ? new JsonArray() : new JsonObject());
        using var daemon = await Daemon.StartAsync(bridge, _dir, idleSeconds: "2");
        string kept = await daemon.OpenSessionAsync("claude"), closed = await daemon.OpenSessionAsync("claude");
        using (var deleted = await daemon.SendAsync(HttpMethod.Delete, "claude", null, closed))
            Assert.Equal(HttpStatusCode.OK, deleted.StatusCode);
        await daemon.WaitForStderrAsync($"session {kept[..8]} (Claude) expired", TimeSpan.FromSeconds(15));
        // Parallel calls after a pause reach one session again, so the conversation keeps its own tabs.
        Assert.Equal(HttpStatusCode.OK, await daemon.ListToolsAsync("claude", kept));
        await daemon.WaitForStderrAsync($"session {kept[..8]} (Claude) resumed", TimeSpan.FromSeconds(3));
        Assert.Equal(HttpStatusCode.NotFound, await daemon.ListToolsAsync("claude", closed));
    }

    private static string Identity(string agent, string session) => McpServer.SessionIdentity(agent, session).Id;
}
