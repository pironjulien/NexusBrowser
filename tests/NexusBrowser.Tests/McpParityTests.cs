using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using NexusBrowser.Native;
using SkiaSharp;
using Xunit;

namespace NexusBrowser.Tests;

/// <summary>An MCP engine (in-process McpServer) wired to a disposable FakeBridge: no browser, token, service or journal
/// of the user is involved.</summary>
internal sealed class EngineSession : IDisposable
{
    private int _id;
    public FakeBridge Bridge { get; }
    public McpServer Server { get; }
    public (string Agent, string Id) Identity { get; } = McpServer.SessionIdentity("Codex", Guid.NewGuid().ToString("N"));

    public EngineSession(Func<string, JsonObject, JsonNode?> answer)
    {
        Bridge = new FakeBridge(answer);
        Server = new McpServer(agent: "Codex", bridgeHttpPort: Bridge.Port, tokenFile: Bridge.TokenFile);
    }

    public List<JsonObject> Commands => Bridge.Commands;
    public List<string> Actions => Bridge.Actions;

    public static string Request(int id, string name, JsonObject arguments) => new JsonObject
    {
        ["jsonrpc"] = "2.0",
        ["id"] = id,
        ["method"] = "tools/call",
        ["params"] = new JsonObject { ["name"] = name, ["arguments"] = arguments.DeepClone() },
    }.ToJsonString();

    public async Task<JsonObject> CallAsync(string name, JsonObject? arguments = null)
    {
        int id = Interlocked.Increment(ref _id);
        var response = await Server.HandleJsonRpcLineAsync(Request(id, name, arguments ?? new JsonObject()), Identity, Environment.ProcessId, TestContext.Current.CancellationToken);
        Assert.NotNull(response);
        Assert.Equal(id, (int)response["id"]!);
        Assert.False(response.ContainsKey("error"), response.ToJsonString());
        Assert.Equal(0, Bridge.Unauthorized);
        return (JsonObject)response["result"]!;
    }

    public void Dispose()
    {
        Server.Dispose();
        Bridge.Dispose();
    }
}

/// <summary>Black-box regressions of the native MCP tool handlers and guardrails (tests/test_native_parity.py, in-process).</summary>
public sealed partial class McpParityTests
{
    [GeneratedRegex("accord=\"([a-f0-9]+)\"")]
    private static partial Regex AccordToken();

    private static JsonObject Payload(JsonObject result) => (JsonObject)JsonNode.Parse((string)result["content"]![0]!["text"]!)!;

    private static string Accord(JsonObject result)
    {
        var answer = Payload(result);
        Assert.True(answer["accord_required"]?.GetValue<bool>() == true, answer.ToJsonString());
        var found = AccordToken().Match((string)answer["error"]!);
        Assert.True(found.Success, answer.ToJsonString());
        return found.Groups[1].Value;
    }

    private static JsonObject Args(string json) => (JsonObject)JsonNode.Parse(json)!;

    private static JsonObject With(JsonObject arguments, params (string Key, JsonNode? Value)[] extra)
    {
        var copy = (JsonObject)arguments.DeepClone();
        foreach (var (key, value) in extra) copy[key] = value;
        return copy;
    }

    private static JsonObject Trigger(string label = "Send", JsonArray? recipients = null) => new()
    {
        ["result"] = new JsonObject
        {
            ["value"] = new JsonObject
            {
                ["success"] = true,
                ["label"] = label,
                ["clickable"] = true,
                ["form"] = true,
                ["fields"] = new JsonArray(new JsonObject { ["label"] = "Message", ["type"] = "text", ["value"] = "Hello" }),
                ["recipients"] = recipients ?? new JsonArray("recipient@example.test"),
                ["tabUrl"] = "https://example.test/send?token=never-shown",
            },
        },
    };

    [Theory]
    [InlineData("browser_click", """{"selector":"button"}""")]
    [InlineData("browser_fill", """{"selector":"input","value":"Hello","keys":["Enter"]}""")]
    [InlineData("browser_press_key", """{"key":"Control+Enter"}""")]
    [InlineData("browser_type_keys", """{"text":"Hello\n"}""")]
    [InlineData("browser_drag_and_drop", """{"from_selector":"#slider","to_selector":"#end"}""")]
    public async Task OutwardGesturesAreReadThenRefused(string name, string arguments)
    {
        using var session = new EngineSession((_, _) => Trigger());
        var result = await session.CallAsync(name, With(Args(arguments), ("tab_id", 7)));
        Accord(result);
        Assert.NotEmpty(session.Actions);
        Assert.All(session.Actions, action => Assert.Equal("cdp-send", action));
        Assert.DoesNotContain("never-shown", (string)Payload(result)["error"]!);
    }

    [Fact]
    public async Task AccordIsBoundSingleUseAndRestoredForAnUnsentGesture()
    {
        string recipient = "first@example.test";
        bool covered = false;
        using var session = new EngineSession((action, _) =>
        {
            if (action == "cdp-send") return Trigger(recipients: new JsonArray(recipient));
            if (covered) throw new InvalidOperationException("Element is covered. Nothing was sent.");
            return new JsonObject { ["method"] = "cdp" };
        });
        var click = Args("""{"tab_id":7,"selector":"button"}""");

        string token = Accord(await session.CallAsync("browser_click", click));
        recipient = "changed@example.test";
        var changed = await session.CallAsync("browser_click", With(click, ("confirm", true), ("accord", token)));
        Assert.Contains("action changed", (string)Payload(changed)["error"]!);
        Assert.DoesNotContain("click", session.Actions);

        token = Accord(changed);
        covered = true;
        var blocked = await session.CallAsync("browser_click", With(click, ("confirm", true), ("accord", token)));
        Assert.True(Payload(blocked)["accord_kept"]?.GetValue<bool>(), Payload(blocked).ToJsonString());

        covered = false;
        var accepted = await session.CallAsync("browser_click", With(click, ("confirm", true), ("accord", token)));
        Assert.False((bool)accepted["isError"]!, accepted.ToJsonString());

        // Single use: the same token is spent.
        Accord(await session.CallAsync("browser_click", With(click, ("confirm", true), ("accord", token))));
        Assert.Equal(2, session.Actions.Count(a => a == "click"));
    }

    [Fact]
    public async Task UnreadableTriggerDoesNotSendAndNeutralClickStaysAvailable()
    {
        bool readable = false;
        using var session = new EngineSession((action, _) =>
            action == "cdp-send"
                ? readable ? Trigger(label: "Next") : new JsonObject { ["exceptionDetails"] = new JsonObject { ["text"] = "unreachable" } }
                : new JsonObject { ["method"] = "cdp" });
        var click = Args("""{"tab_id":7,"selector":"button"}""");

        var failed = await session.CallAsync("browser_click", click);
        Assert.True((bool)failed["isError"]!);
        Assert.Contains("trigger could not be read", (string)Payload(failed)["error"]!);
        Assert.DoesNotContain("click", session.Actions);

        readable = true;
        var neutral = await session.CallAsync("browser_click", click);
        Assert.False((bool)neutral["isError"]!, neutral.ToJsonString());
        Assert.Contains("click", session.Actions);
    }

    [Fact]
    public async Task CancelledRequestNeverSendsAGestureAfterALateProbe()
    {
        using var reading = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        using var session = new EngineSession((_, _) =>
        {
            reading.Set();
            release.Wait(TimeSpan.FromSeconds(5));
            return Trigger(label: "Next");
        });
        try
        {
            var call = session.Server.HandleJsonRpcLineAsync(
                EngineSession.Request(1, "browser_click", Args("""{"tab_id":7,"selector":"button"}""")), session.Identity, Environment.ProcessId, TestContext.Current.CancellationToken);
            Assert.True(reading.Wait(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken), "the trigger probe never reached the bridge");
            Assert.Null(await session.Server.HandleJsonRpcLineAsync(
                """{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}""", session.Identity, Environment.ProcessId, TestContext.Current.CancellationToken));
            var response = await call.WaitAsync(TimeSpan.FromSeconds(3), TestContext.Current.CancellationToken);
            Assert.NotNull(response);
            Assert.Equal(1, (int)response["id"]!);
            Assert.True(response["result"]?["isError"]?.GetValue<bool>(), response.ToJsonString());
            release.Set();
            await Task.Delay(300, TestContext.Current.CancellationToken); // a late probe answer must not trigger anything
            Assert.All(session.Actions, action => Assert.Equal("cdp-send", action));
        }
        finally { release.Set(); }
    }

    [Fact]
    public async Task FillFormValidatesBeforeGesturesAndReadsFinalValues()
    {
        bool laterFieldFilled = false;
        using var session = new EngineSession((action, parameters) =>
        {
            int mark = (int)parameters["mark"]!;
            if (action == "fill")
            {
                laterFieldFilled |= mark == 2;
                return new JsonObject { ["verified"] = true };
            }
            Assert.Equal("field-state", action);
            return new JsonObject { ["verified"] = !(mark == 1 && laterFieldFilled), ["value"] = "changed" };
        });

        var invalid = await session.CallAsync("browser_fill_form", Args("""{"tab_id":7,"fields":[{"mark":1,"value":"a"},{"mark":2}]}"""));
        Assert.True((bool)invalid["isError"]!);
        Assert.Empty(session.Commands);

        var failed = await session.CallAsync("browser_fill_form", Args("""{"tab_id":7,"fields":[{"mark":1,"value":"a"},{"mark":2,"value":"b"}]}"""));
        var data = Payload(failed)["data"]!;
        Assert.True((bool)failed["isError"]!);
        Assert.False((bool)data["all_verified"]!);
        Assert.False((bool)data["fields"]![0]!["final_verified"]!);
        Assert.True((bool)data["fields"]![1]!["final_verified"]!);
        Assert.Equal(["fill", "field-state", "fill", "field-state", "field-state", "field-state"], session.Actions);
    }

    [Fact]
    public async Task FillFormStopsAfterAnUnverifiedGesture()
    {
        using var session = new EngineSession((action, _) => new JsonObject { ["verified"] = action != "fill" });
        var result = await session.CallAsync("browser_fill_form", Args("""{"tab_id":7,"fields":[{"mark":1,"value":"a"},{"mark":2,"value":"b"}]}"""));
        Assert.True((bool)result["isError"]!);
        Assert.Equal(1, session.Actions.Count(a => a == "fill"));
    }

    [Fact]
    public async Task DataSchemaRejectsAWrongShapeWithoutLosingTheAnswer()
    {
        JsonNode data = new JsonArray();
        using var session = new EngineSession((_, _) => data);

        var good = await session.CallAsync("browser_list_tabs");
        Assert.True(JsonNode.DeepEquals(new JsonArray(), good["structuredContent"]?["data"]), good.ToJsonString());

        data = new JsonObject { ["tabs"] = new JsonArray() };
        var wrong = await session.CallAsync("browser_list_tabs");
        Assert.True((bool)wrong["isError"]!);
        Assert.Contains("output schema", (string)Payload(wrong)["error"]!);
        Assert.True(JsonNode.DeepEquals(data, Payload(wrong)["data"]), Payload(wrong).ToJsonString());
        Assert.False(wrong.ContainsKey("structuredContent"));

        var stopped = await session.CallAsync("browser_batch", Args(
            """{"steps":[{"tool":"browser_list_tabs","args":{}},{"tool":"browser_close_tab","args":{"tab_id":7}}]}"""));
        Assert.True((bool)stopped["isError"]!);
        Assert.Equal(0, (int)Payload(stopped)["stopped_at"]!);
        Assert.DoesNotContain(session.Actions, a => a.Contains("close", StringComparison.Ordinal));
    }

    [Fact]
    public async Task WebMcpUsesAnIsolatedProbeChecksTheSchemaAndRequiresAccord()
    {
        bool called = false;
        using var session = new EngineSession((action, parameters) =>
        {
            Assert.Equal("cdp-send", action);
            string expression = (string)parameters["commandParams"]!["expression"]!;
            int split = expression.LastIndexOf(")(", StringComparison.Ordinal);
            var spec = (JsonObject)JsonNode.Parse(expression[(split + 2)..^1])!;
            var page = new JsonObject { ["supported"] = true, ["url"] = "https://example.test/mail" };
            if (spec.ContainsKey("key"))
            {
                called = true;
                page["success"] = true;
                page["output"] = "{\"sent\":true}";
                return new JsonObject { ["result"] = new JsonObject { ["value"] = page } };
            }
            page["tool"] = new JsonObject
            {
                ["name"] = "send_email",
                ["origin"] = "https://example.test",
                ["annotations"] = new JsonObject { ["readOnlyHint"] = true },
                ["inputSchema"] = Args("""{"type":"object","required":["to"],"properties":{"to":{"type":"string"}}}"""),
                ["key"] = "stable-definition",
            };
            return new JsonObject { ["result"] = new JsonObject { ["value"] = page } };
        });

        var invalid = await session.CallAsync("browser_webmcp_call", Args("""{"tab_id":7,"tool":"send_email","input":{"to":42}}"""));
        Assert.True((bool)invalid["isError"]!);
        Assert.Contains("inputSchema", (string)Payload(invalid)["error"]!);
        Assert.False(called);

        var arguments = Args("""{"tab_id":7,"tool":"send_email","input":{"to":"recipient@example.test"}}""");
        string token = Accord(await session.CallAsync("browser_webmcp_call", arguments));
        Assert.False(called); // a readOnlyHint declared by the page never waives the accord

        var completed = await session.CallAsync("browser_webmcp_call", With(arguments, ("confirm", true), ("accord", token)));
        Assert.False((bool)completed["isError"]!, completed.ToJsonString());
        Assert.True(JsonNode.DeepEquals(new JsonObject { ["sent"] = true }, Payload(completed)["data"]!["output"]));
        Assert.True(called);
    }

    [Fact]
    public async Task InlineCaptureIsResizedAttachedDeduplicatedAndZoomable()
    {
        string dataUrl;
        using (var bitmap = new SKBitmap(4000, 1800))
        {
            bitmap.Erase(SKColors.White);
            using var png = bitmap.Encode(SKEncodedImageFormat.Png, 100);
            dataUrl = "data:image/png;base64," + Convert.ToBase64String(png.ToArray());
        }
        using var session = new EngineSession((action, _) =>
        {
            Assert.Equal("screenshot", action);
            return new JsonObject { ["dataUrl"] = dataUrl, ["devicePixelRatio"] = 1, ["zoom"] = 1 };
        });
        var inline = Args("""{"tab_id":7,"inline":true}""");

        var first = await session.CallAsync("browser_screenshot", inline);
        var block = first["content"]![1]!;
        Assert.Equal("image", (string?)block["type"]);
        Assert.Equal("image/webp", (string?)block["mimeType"]);
        byte[] encoded = Convert.FromBase64String((string)block["data"]!);
        Assert.True(encoded.Length <= 500_000, $"{encoded.Length} bytes");
        using (var image = SKBitmap.Decode(encoded))
        {
            Assert.NotNull(image);
            Assert.True(Math.Max(image.Width, image.Height) <= 2000, $"{image.Width}x{image.Height}");
            Assert.True(image.Width * image.Height <= 2_560_000, $"{image.Width}x{image.Height}");
        }

        var again = await session.CallAsync("browser_screenshot", inline);
        Assert.Single(again["content"]!.AsArray());
        Assert.True((bool)Payload(again)["data"]!["image"]!["unchanged"]!);

        Assert.Equal(2, (await session.CallAsync("browser_screenshot", With(inline, ("force", true))))["content"]!.AsArray().Count);

        var zoomed = await session.CallAsync("browser_screenshot", With(inline, ("region", new JsonArray(0, 0, 100, 100))));
        Assert.False((bool)zoomed["isError"]!, zoomed.ToJsonString());
        Assert.Equal(200, (int)session.Commands[^1]["params"]!["region"]!["width"]!);
    }

    [Fact]
    public async Task GSuiteBinaryIsWrittenWithoutBase64InTheAnswer()
    {
        using var session = new EngineSession((action, _) =>
        {
            Assert.Equal("export-gsuite", action);
            return new JsonObject
            {
                ["binary"] = true,
                ["base64"] = Convert.ToBase64String("export bytes"u8.ToArray()),
                ["filename"] = "report.docx",
                ["extension"] = "docx",
            };
        });
        var result = await session.CallAsync("browser_export_gsuite", Args("""{"tab_id":7}"""));
        Assert.False((bool)result["isError"]!, result.ToJsonString());
        var data = (JsonObject)Payload(result)["data"]!;
        Assert.False(data.ContainsKey("base64"));
        string destination = Path.GetFullPath((string)data["output_path"]!);
        try
        {
            Assert.Equal("export bytes"u8.ToArray(), File.ReadAllBytes(destination));
            // Written in the (test-isolated) engine data folder, never next to the caller.
            Assert.StartsWith(Path.GetFullPath(BridgeSecurity.DefaultDataDir()) + Path.DirectorySeparatorChar, destination, StringComparison.OrdinalIgnoreCase);
            Assert.StartsWith(TestEnvironment.Root, destination, StringComparison.OrdinalIgnoreCase);
        }
        finally { File.Delete(destination); }
    }

    [Fact]
    public async Task DownloadTimestampKeepsAll64Bits()
    {
        const long since = 1_793_307_654_321;
        using var session = new EngineSession((_, _) => new JsonObject());
        var result = await session.CallAsync("browser_wait_download", Args($$"""{"tab_id":7,"since_ms":{{since}}}"""));
        Assert.False((bool)result["isError"]!, result.ToJsonString());
        Assert.Equal(since, (long)session.Commands[0]["params"]!["since"]!);
    }

    [Fact]
    public async Task MissingExtensionIsNotReplayedNorUsedToOpenChrome()
    {
        using var session = new EngineSession((_, _) => throw new InvalidOperationException("No Chrome browser extension connected to the NexusBrowser bridge."));
        var result = await session.CallAsync("browser_new_tab", Args("""{"url":"about:blank"}"""));
        Assert.True((bool)result["isError"]!);
        Assert.Contains("no action was sent", (string)Payload(result)["error"]!);
        Assert.Equal(["create-tab"], session.Actions);
    }
}
