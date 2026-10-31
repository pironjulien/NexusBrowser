using System.Text.Json.Nodes;
using NexusBrowser.Native;
using Xunit;

namespace NexusBrowser.Tests;

/// <summary>Smaller read answers: output_path, json_path after the masking, console filters, include_changes after an
/// action. Fake bridge, no real Chrome.</summary>
public sealed class ReadShapingTests : IDisposable
{
    private readonly string _folder = Path.Join(Path.GetTempPath(), "nexus-shaping-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_folder)) Directory.Delete(_folder, recursive: true);
    }

    private static JsonObject Payload(JsonObject result) => (JsonObject)JsonNode.Parse((string)result["content"]![0]!["text"]!)!;
    private static JsonObject Args(string json) => (JsonObject)JsonNode.Parse(json)!;

    [Theory]
    [InlineData("$.data.items[0].name", "\"a\"")]
    [InlineData("data.items[-1].name", "\"b\"")]
    [InlineData("$.data.items[*].name", "[\"a\",\"b\"]")]
    [InlineData("$['data']['count']", "2")]
    [InlineData("$.data.*", "[[{\"name\":\"a\"},{\"name\":\"b\"}],2]")]
    public void AJsonPathSelectsOnePartOrEveryMatch(string path, string expected)
    {
        var document = JsonNode.Parse("""{"data":{"items":[{"name":"a"},{"name":"b"}],"count":2}}""");
        Assert.Equal(expected, McpServer.JsonPathSelect(document, path)!.ToJsonString());
    }

    [Theory]
    [InlineData("$.data.missing")]
    [InlineData("$.data.items[5]")]
    [InlineData("$.data[x]")]
    public void AJsonPathWithNothingThereIsAClearError(string path)
    {
        var document = JsonNode.Parse("""{"data":{"items":[]}}""");
        Assert.StartsWith("json_path:", Assert.Throws<ArgumentException>(() => McpServer.JsonPathSelect(document, path)).Message);
    }

    [Fact]
    public void LogsAreFilteredByLevelTimeAndCountWithoutStacksUnlessAsked()
    {
        var entries = Args("""
            {"e":[
              {"timestamp":100,"method":"Runtime.consoleAPICalled","params":{"type":"log","args":[],"stackTrace":{"callFrames":[]}}},
              {"timestamp":200,"method":"Runtime.consoleAPICalled","params":{"type":"warning","args":[]}},
              {"timestamp":300,"method":"Log.entryAdded","params":{"entry":{"level":"error","text":"boom","stackTrace":{"callFrames":[]}}}},
              {"timestamp":400,"method":"Runtime.consoleAPICalled","params":{"type":"debug","args":[]}}
            ]}
            """)["e"]!.AsArray();
        var all = McpServer.FilterLogs(entries, null, null, null, includeStack: false);
        Assert.Equal(["log", "warning", "error", "debug"], all.Select(e => (string)e!["level"]!));
        Assert.Null(all[0]!["params"]!["stackTrace"]);
        Assert.Null(all[2]!["params"]!["entry"]!["stackTrace"]);
        Assert.NotNull(McpServer.FilterLogs(entries, null, null, null, includeStack: true)[0]!["params"]!["stackTrace"]);
        Assert.Equal([200.0, 300.0], McpServer.FilterLogs(entries, "warning", null, null, false).Select(e => (double)e!["timestamp"]!));
        Assert.Equal([300.0, 400.0], McpServer.FilterLogs(entries, null, 250, null, false).Select(e => (double)e!["timestamp"]!));
        Assert.Equal([400.0], McpServer.FilterLogs(entries, null, null, 1, false).Select(e => (double)e!["timestamp"]!));
        Assert.Throws<ArgumentException>(() => McpServer.FilterLogs(entries, "fatal", null, null, false));
    }

    [Fact]
    public async Task JsonPathReadsTheWholeMaskedBodyThenCutsToMaxBytes()
    {
        // The extension masked the token before answering: the path can never bring it back.
        string body = """)]}'""" + "\n" + """{"user":{"name":"Ada","access_token":"[masked]"},"items":[1,2,3]}""";
        using var session = new EngineSession((_, _) => new JsonObject
        {
            ["request_id"] = "1", ["url"] = "https://example.com/api", ["status"] = 200, ["mimeType"] = "application/json",
            ["base64Encoded"] = false, ["binary"] = false, ["size"] = body.Length, ["truncated"] = false, ["body"] = body, ["masked"] = 1,
        });
        var user = Payload(await session.CallAsync("browser_network_response", Args("""{"tab_id":1,"request_id":"1","json_path":"$.user"}""")));
        Assert.Equal("""{"name":"Ada","access_token":"[masked]"}""", (string)user["data"]!["body"]!);
        Assert.Equal(5 * 1024 * 1024, (int)session.Commands[0]["params"]!["maxBytes"]!);
        var items = Payload(await session.CallAsync("browser_network_response", Args("""{"tab_id":1,"request_id":"1","json_path":"$.items[*]","max_bytes":3}""")));
        Assert.Equal("[1,", (string)items["data"]!["body"]!);
        Assert.True((bool)items["data"]!["truncated"]!);
        Assert.Equal(3, (int)items["data"]!["matches"]!);
        var missing = await session.CallAsync("browser_network_response", Args("""{"tab_id":1,"request_id":"1","json_path":"$.nope"}"""));
        Assert.True((bool)missing["isError"]!);
    }

    [Fact]
    public async Task OutputPathWritesThePayloadAndAnswersPathSizeAndExcerpt()
    {
        string content = new('x', 5000);
        using var session = new EngineSession((action, _) => action switch
        {
            "export-content" => new JsonObject { ["url"] = "https://example.com", ["title"] = "T", ["format"] = "markdown", ["content"] = content, ["chars"] = content.Length },
            "logs" => new JsonArray(new JsonObject { ["timestamp"] = 1, ["method"] = "Runtime.consoleAPICalled", ["params"] = new JsonObject { ["type"] = "error" } }),
            _ => new JsonObject { ["url"] = "https://example.com", ["title"] = "T", ["refs"] = 1, ["snapshot"] = "- button \"Go\" [#1]" },
        });
        string file = Path.Join(_folder, "page.md");
        var export = Payload(await session.CallAsync("browser_export", Args($$"""{"tab_id":1,"output_path":{{System.Text.Json.JsonSerializer.Serialize(file)}}}""")));
        Assert.Equal(content, await File.ReadAllTextAsync(file, TestContext.Current.CancellationToken));
        Assert.Null(export["data"]!["content"]);
        Assert.Equal(file, (string)export["data"]!["output_path"]!);
        Assert.Equal(5000, (int)export["data"]!["size_bytes"]!);
        Assert.Equal(618, ((string)export["data"]!["excerpt"]!).Length);

        string logs = Path.Join(_folder, "logs.json");
        var logAnswer = await session.CallAsync("browser_logs", Args($$"""{"tab_id":1,"output_path":{{System.Text.Json.JsonSerializer.Serialize(logs)}}}"""));
        Assert.False((bool)logAnswer["isError"]!, logAnswer.ToJsonString());
        Assert.Equal(1, (int)Payload(logAnswer)["data"]!["count"]!);
        Assert.Contains("\"level\":\"error\"", await File.ReadAllTextAsync(logs, TestContext.Current.CancellationToken));

        string snapshot = Path.Join(_folder, "snap.txt");
        await session.CallAsync("browser_axtree", Args($$"""{"tab_id":1,"mode":"snapshot","output_path":{{System.Text.Json.JsonSerializer.Serialize(snapshot)}}}"""));
        Assert.Equal("- button \"Go\" [#1]", await File.ReadAllTextAsync(snapshot, TestContext.Current.CancellationToken));

        var relative = await session.CallAsync("browser_export", Args("""{"tab_id":1,"output_path":"page.md"}"""));
        Assert.True((bool)relative["isError"]!);
        Assert.Contains("absolute", (string)Payload(relative)["error"]!);
    }

    [Fact]
    public async Task IncludeChangesAddsTheSnapshotDiffAfterTheAction()
    {
        using var session = new EngineSession((action, _) => action switch
        {
            "axtree" => new JsonObject { ["url"] = "https://example.com", ["title"] = "T", ["refs"] = 2, ["changes"] = "diff", ["added"] = "- dialog \"Saved\"", ["removed"] = "" },
            "wait-network-idle" => new JsonObject { ["idle"] = true },
            // Outward-action check of the click: a plain "Go" button.
            "cdp-send" => new JsonObject { ["result"] = new JsonObject { ["value"] = new JsonObject { ["success"] = true, ["label"] = "Go", ["clickable"] = true } } },
            _ => new JsonObject { ["success"] = true, ["method"] = "cdp" },
        });
        var plain = Payload(await session.CallAsync("browser_click", Args("""{"tab_id":1,"selector":"#go"}""")));
        Assert.Null(plain["changes"]);
        Assert.DoesNotContain("axtree", session.Actions);
        var click = Payload(await session.CallAsync("browser_click", Args("""{"tab_id":1,"selector":"#go","include_changes":true}""")));
        Assert.Equal("diff", (string)click["changes"]!["changes"]!);
        Assert.Equal("- dialog \"Saved\"", (string)click["changes"]!["added"]!);
        Assert.True((bool)session.Commands.Last(c => (string)c["action"]! == "axtree")["params"]!["changesOnly"]!);

        int before = session.Actions.Count(a => a == "axtree");
        var batch = Payload(await session.CallAsync("browser_batch", Args("""
            {"tab_id":1,"include_changes":true,"steps":[{"tool":"browser_press_key","args":{"key":"Escape"}},{"tool":"browser_press_key","args":{"key":"Tab"}}]}
            """)));
        Assert.Equal("diff", (string)batch["changes"]!["changes"]!);
        Assert.Equal(before + 1, session.Actions.Count(a => a == "axtree"));  // one diff after the last step
    }
}
