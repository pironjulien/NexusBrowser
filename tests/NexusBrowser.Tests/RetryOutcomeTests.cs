using System.Text.Json.Nodes;
using NexusBrowser.Native;
using Xunit;

namespace NexusBrowser.Tests;

/// <summary>A failed call says whether resending it is safe: retry_safe, and outcome "not_done" (nothing reached the
/// page), "unknown" (it may have acted) or "partial" (a batch stopped after earlier steps). No real Chrome.</summary>
public sealed class RetryOutcomeTests
{
    private static JsonObject Outcome(JsonObject answer, bool idempotent) =>
        (JsonObject)JsonNode.Parse(McpServer.WithOutcome(answer.ToJsonString(), idempotent))!;

    private static JsonObject Error(string message) => new() { ["status"] = "error", ["error"] = message };

    [Theory]
    [InlineData("<button> is covered by <div.cookie-banner>: no point of the element is reachable, no mouse action sent. Nothing was sent.")]
    [InlineData("Mark #4 is stale: the page replaced its element and no button \"Pay\" is left: run browser_interactive_map or browser_axtree again. Nothing was sent.")]
    [InlineData("No element matches the locator {\"role\":\"button\",\"name\":\"Next\"}")]
    [InlineData("Invalid tool arguments: arguments.tab_id: integer expected")]
    [InlineData("No Chrome browser extension connected to the NexusBrowser bridge. Make sure the extension is active in Chrome.")]
    [InlineData("URL refused: file:///C:/x (http, https, data: or about:blank only; never file://, chrome://, javascript:).")]
    public void AFailureBeforeThePageIsNotDoneAndSafeToResend(string message)
    {
        var answer = Outcome(Error(message), idempotent: false);
        Assert.Equal("not_done", (string?)answer["outcome"]);
        Assert.True((bool)answer["retry_safe"]!);
        Assert.Equal(message, (string?)answer["error"]);
    }

    [Theory]
    [InlineData("Command 'click' timed out after 15s.")]
    [InlineData("No response from the NexusBrowser bridge for 'click': the command may have run. It is not resent automatically; check the page state before running it again.")]
    [InlineData("Chrome Extension disconnected while processing request")]
    [InlineData("Command 'type-keys' cancelled while running: emergency stop")]
    public void AFailureAfterTheCommandLeftIsUnknownAndNeverSafe(string message)
    {
        var answer = Outcome(Error(message), idempotent: false);
        Assert.Equal("unknown", (string?)answer["outcome"]);
        Assert.False((bool)answer["retry_safe"]!);
    }

    [Fact]
    public void AnIdempotentToolIsAlwaysSafeAndAnUnrecognizedErrorIsNotGuessed()
    {
        var read = Outcome(Error("Command 'axtree' timed out after 20s."), idempotent: true);
        Assert.True((bool)read["retry_safe"]!);
        Assert.Null(read["outcome"]);
        var odd = Outcome(Error("Something unexpected"), idempotent: false);
        Assert.Null(odd["outcome"]);
        Assert.Null(odd["retry_safe"]);
        var success = new JsonObject { ["status"] = "success", ["data"] = new JsonObject() };
        Assert.Equal(success.ToJsonString(), McpServer.WithOutcome(success.ToJsonString(), idempotent: false));
    }

    [Fact]
    public void ABatchStoppedAfterEarlierStepsIsPartialAndAtItsFirstStepTakesThatStepsOutcome()
    {
        JsonObject Batch(int stoppedAt, JsonObject last) => new()
        {
            ["status"] = "error", ["stopped_at"] = stoppedAt,
            ["steps"] = new JsonArray(new JsonObject { ["tool"] = "browser_click", ["status"] = "error", ["result"] = last }),
        };
        var late = Outcome(Batch(2, Error("x")), idempotent: false);
        Assert.Equal("partial", (string?)late["outcome"]);
        Assert.False((bool)late["retry_safe"]!);
        Assert.Contains("Steps 0 to 1 ran", (string?)late["note"]);
        var first = Outcome(Batch(0, new JsonObject { ["status"] = "error", ["outcome"] = "not_done", ["retry_safe"] = true }), idempotent: false);
        Assert.Equal("not_done", (string?)first["outcome"]);
        Assert.True((bool)first["retry_safe"]!);
    }

    [Fact]
    public async Task ToolCallsCarryTheOutcomeAndTheSnapshotOptionsReachTheBridge()
    {
        using var bridge = new FakeBridge((action, p) => action switch
        {
            "navigate" => throw new InvalidOperationException("Command 'navigate' timed out after 20s."),
            "axtree" => new JsonObject { ["echo"] = p.DeepClone() },
            _ => new JsonObject(),
        });
        using var server = new McpServer("Codex", bridge.Port, bridge.TokenFile);
        async Task<JsonObject> Call(string tool, JsonObject args)
        {
            string line = new JsonObject
            {
                ["jsonrpc"] = "2.0", ["id"] = 1, ["method"] = "tools/call",
                ["params"] = new JsonObject { ["name"] = tool, ["arguments"] = args },
            }.ToJsonString();
            var response = await server.HandleJsonRpcLineAsync(line, ("Codex", "codex-retry"), null);
            return (JsonObject)JsonNode.Parse((string)response!["result"]!["content"]![0]!["text"]!)!;
        }
        var navigate = await Call("browser_navigate", new JsonObject { ["tab_id"] = 3, ["url"] = "https://example.com/" });
        Assert.Equal("unknown", (string?)navigate["outcome"]);
        Assert.False((bool)navigate["retry_safe"]!);
        var invalid = await Call("browser_navigate", new JsonObject { ["tab_id"] = "three", ["url"] = "https://example.com/" });
        Assert.Equal("not_done", (string?)invalid["outcome"]);
        var snapshot = await Call("browser_axtree", new JsonObject
        {
            ["tab_id"] = 3, ["mode"] = "snapshot", ["selector"] = "form#checkout", ["changes_only"] = true,
        });
        var sent = (JsonObject)snapshot["data"]!["echo"]!;
        Assert.Equal("form#checkout", (string?)sent["selector"]);
        Assert.True((bool)sent["changesOnly"]!);
    }
}
