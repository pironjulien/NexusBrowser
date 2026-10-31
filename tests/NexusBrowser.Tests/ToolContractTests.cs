using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using NexusBrowser.Native;
using Xunit;

namespace NexusBrowser.Tests;

/// <summary>The tools the native engine publishes (tools/list) and what they really do: English texts, four
/// annotations, read-only hints that the bridge treats as reads, output schemas only on data tools, names that fit
/// Antigravity, honest documentation of browser_eval (ports of test_english.py, test_sdk2_annotations.py,
/// test_output_schemas.py and test_cross_review.py, for the native engine).</summary>
public sealed partial class ToolContractTests
{
    private static readonly Lazy<Dictionary<string, JsonObject>> Listed = new(() =>
    {
        using var server = new McpServer(agent: "Codex", bridgeHttpPort: 1);
        var response = server.HandleJsonRpcLineAsync("""{"jsonrpc":"2.0","id":1,"method":"tools/list"}""", ("Codex", "codex-toolcontract"), null).GetAwaiter().GetResult();
        return response!["result"]!["tools"]!.AsArray().Select(t => (JsonObject)t!).ToDictionary(t => (string)t["name"]!);
    });

    private static Dictionary<string, JsonObject> Tools => Listed.Value;
    private static JsonObject Hints(string tool) => (JsonObject)Tools[tool]["annotations"]!;
    private static bool Hint(string tool, string hint) => (bool)Hints(tool)[hint]!;

    private static JsonObject Payload(JsonObject result) => (JsonObject)JsonNode.Parse((string)result["content"]![0]!["text"]!)!;
    private static JsonObject Args(string json) => (JsonObject)JsonNode.Parse(json)!;

    // ---------------------------------------------------------------------------------------------
    // Names and annotations
    // ---------------------------------------------------------------------------------------------

    [Fact]
    public void FortyNineToolsWithUniqueNames()
    {
        Assert.Equal(49, Tools.Count);
        Assert.All(Tools.Keys, name => Assert.StartsWith("browser_", name));
    }

    [Fact]
    public void SelectingATabExposesOptionalWindowFocusDefaultingToFalse()
    {
        var schema = Tools["browser_select_tab"]["inputSchema"]!;
        var focus = schema["properties"]!["focus_window"]!;
        Assert.Equal("boolean", (string?)focus["type"]);
        Assert.False((bool)focus["default"]!);
        Assert.DoesNotContain(schema["required"]!.AsArray(), item => (string?)item == "focus_window");
    }

    [Fact]
    public void EveryToolNameFitsAntigravityOncePrefixed()
    {
        // Antigravity publishes mcp_<plugin>_<server>_<tool> and silently drops a name outside ^[a-zA-Z0-9_-]{1,64}$.
        const string prefix = "mcp_nexus-browser_nexus-browser_";
        Assert.DoesNotContain(Tools.Keys, name => !Regex.IsMatch(prefix + name, "^[a-zA-Z0-9_-]{1,64}$"));
    }

    [Fact]
    public void EveryToolHasItsFourAnnotationsAndAUniqueTitle()
    {
        foreach (var (name, _) in Tools)
        {
            var hints = Hints(name);
            foreach (string hint in new[] { "readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint" })
                Assert.True(hints[hint] is JsonValue v && v.TryGetValue<bool>(out _), $"{name}.{hint}");
            Assert.False(Hint(name, "readOnlyHint") && Hint(name, "destructiveHint"), name);
            Assert.False(string.IsNullOrWhiteSpace((string?)hints["title"]), name);
        }
        Assert.Equal(Tools.Count, Tools.Keys.Select(n => (string)Hints(n)["title"]!).Distinct().Count());
        Assert.True(JsonNode.DeepEquals(new JsonObject
        {
            ["title"] = "Click", ["readOnlyHint"] = false, ["destructiveHint"] = true, ["idempotentHint"] = false, ["openWorldHint"] = true,
        }, Hints("browser_click")), Hints("browser_click").ToJsonString());
    }

    [Fact]
    public void AnnotationsMatchWhatEachToolDoes()
    {
        var readOnly = Tools.Keys.Where(n => Hint(n, "readOnlyHint")).ToHashSet();
        var destructive = Tools.Keys.Where(n => Hint(n, "destructiveHint")).ToHashSet();
        Assert.Superset(new HashSet<string> { "browser_content", "browser_axtree", "browser_screenshot", "browser_find", "browser_interactive_map",
            "browser_network_response", "browser_export", "browser_list_tabs", "browser_get_cookies" }, readOnly);
        // The user's real sessions: a click, a key, a checkbox, a script can send, delete or confirm.
        Assert.Superset(new HashSet<string> { "browser_click", "browser_fill", "browser_fill_form", "browser_press_key", "browser_check",
            "browser_handle_dialog", "browser_eval", "browser_cdp_send", "browser_drag_and_drop", "browser_upload", "browser_close_tab" }, destructive);
        Assert.DoesNotContain(new[] { "browser_hover", "browser_scroll", "browser_navigate", "browser_new_tab" }, n => readOnly.Contains(n) || destructive.Contains(n));
        var local = Tools.Keys.Where(n => !Hint(n, "openWorldHint")).ToHashSet();
        Assert.Superset(new HashSet<string> { "browser_list_tabs", "browser_active_tab", "browser_group_tabs", "browser_release_tab" }, local);
        Assert.DoesNotContain("browser_navigate", local);
        Assert.DoesNotContain("browser_eval", local);
    }

    // ---------------------------------------------------------------------------------------------
    // English texts
    // ---------------------------------------------------------------------------------------------

    private const string Accents = "àâçéèêëîïôöûùüÀÂÇÉÈÊËÎÏÔÖÛÙÜ«»";

    [GeneratedRegex(@"\b(le|la|les|des|une|est|sont|pas|avec|sans|pour|dans|aucun|aucune|onglet|onglets|jamais|seulement|puis|lorsque|quand|selon|jeton|pont)\b", RegexOptions.IgnoreCase)]
    private static partial Regex FrenchWord();

    private static List<string> FrenchMarkers(string text) =>
        [.. Accents.Where(text.Contains).Select(c => c.ToString()), .. FrenchWord().Matches(text).Select(m => m.Value).Distinct()];

    private static IEnumerable<string> Descriptions(JsonNode? schema) => schema switch
    {
        JsonObject o => o.Where(p => p.Key is "description" or "title" && p.Value is JsonValue v && v.TryGetValue<string>(out _)).Select(p => (string)p.Value!)
            .Concat(o.SelectMany(p => Descriptions(p.Value))),
        JsonArray a => a.SelectMany(Descriptions),
        _ => [],
    };

    [Fact]
    public void MarkersCatchFrench()
    {
        Assert.NotEmpty(FrenchMarkers("Ouvre un nouvel onglet dans Chrome"));
        Assert.NotEmpty(FrenchMarkers("tab_id manquant : ouvrir d'abord un onglet avec browser_new_tab"));
        Assert.NotEmpty(FrenchMarkers("« requête »"));
        Assert.Empty(FrenchMarkers("Opens a new Chrome tab at the given URL (or about:blank) and returns its id."));
    }

    [Fact]
    public void ToolTextsAndInstructionsAreEnglish()
    {
        var texts = new List<(string Where, string Text)> { ("instructions", McpServer.Instructions) };
        foreach (var (name, tool) in Tools)
        {
            texts.Add((name, (string?)tool["description"] ?? ""));
            texts.Add(($"{name}.title", (string?)tool["annotations"]?["title"] ?? ""));
            texts.AddRange(Descriptions(tool["inputSchema"]).Select(t => ($"{name}.inputSchema", t)));
            texts.AddRange(Descriptions(tool["outputSchema"]).Select(t => ($"{name}.outputSchema", t)));
        }
        var problems = texts.Select(t => (t.Where, Markers: FrenchMarkers(t.Text), t.Text))
            .Where(t => t.Markers.Count > 0).Select(t => $"{t.Where}: [{string.Join(",", t.Markers)}] {t.Text[..Math.Min(120, t.Text.Length)]}").ToList();
        Assert.Empty(problems);
    }

    private static void AssertEnglishError(JsonObject result)
    {
        var payload = Payload(result);
        Assert.Equal("error", (string?)payload["status"]);
        string error = (string)payload["error"]!;
        Assert.False(string.IsNullOrWhiteSpace(error));
        Assert.True(FrenchMarkers(error).Count == 0, $"[{string.Join(",", FrenchMarkers(error))}] {error}");
    }

    [Fact]
    public async Task ArgumentErrorsAreEnglishAndNothingIsSent()
    {
        using var session = new EngineSession((_, _) => throw new InvalidOperationException("must not be reached"));
        AssertEnglishError(await session.CallAsync("browser_click", Args("""{"selector":"#a"}""")));
        AssertEnglishError(await session.CallAsync("browser_click", Args("""{"selector":"#a","tab_id":0}""")));
        AssertEnglishError(await session.CallAsync("browser_wait_load", Args("""{"tab_id":1,"timeout_ms":999999}""")));
        AssertEnglishError(await session.CallAsync("browser_wait_load", Args("""{"tab_id":1,"timeout_ms":-1}""")));
        AssertEnglishError(await session.CallAsync("browser_group_tabs", Args("""{"tab_ids":[]}""")));
        foreach (string fields in new[] { "[]", "[\"x\"]", """[{"label":"Ville","value":"Lyon"}]""", """[{"mark":1}]""", """[{"mark":1,"checked":"oui"}]""",
                     """[{"mark":1,"value":["a"]}]""", """[{"mark":1,"option":" "}]""" })
            AssertEnglishError(await session.CallAsync("browser_fill_form", Args($$"""{"tab_id":1,"fields":{{fields}}}""")));
        AssertEnglishError(await session.CallAsync("browser_fill_form", Args("""{"tab_id":0,"fields":[{"mark":1,"value":"x"}]}""")));
        AssertEnglishError(await session.CallAsync("browser_upload", Args($$"""{"tab_id":1,"files":[{{JsonValue.Create(Path.Join(BridgeSecurity.HomeDir(), ".ssh", "id_ed25519"))!.ToJsonString()}}]}""")));
        AssertEnglishError(await session.CallAsync("browser_upload", Args("""{"tab_id":1,"files":[]}""")));
        Assert.Empty(session.Commands);
    }

    [Fact]
    public async Task BridgeFailuresAreEnglish()
    {
        // No bridge listening (port 1): unreachable, never started for an isolated port.
        using var tokenOnly = new FakeBridge((_, _) => null);
        using (var server = new McpServer(agent: "Codex", bridgeHttpPort: 1, tokenFile: tokenOnly.TokenFile))
        {
            var response = await server.HandleJsonRpcLineAsync(EngineSession.Request(1, "browser_list_tabs", new JsonObject()), ("Codex", "codex-english1"), null, TestContext.Current.CancellationToken);
            AssertEnglishError((JsonObject)response!["result"]!);
        }
        using var session = new EngineSession((action, _) => action == "cdp-send"
            ? new JsonObject { ["result"] = new JsonObject { ["value"] = new JsonObject { ["success"] = true, ["label"] = "Next", ["clickable"] = true } } }
            : throw new InvalidOperationException("No Chrome browser extension connected to the NexusBrowser bridge."));
        AssertEnglishError(await session.CallAsync("browser_list_tabs"));
        AssertEnglishError(await session.CallAsync("browser_click", Args("""{"selector":"#a","tab_id":1}""")));
    }

    [Fact]
    public async Task FormAndExportReportsAreEnglish()
    {
        JsonNode? answer = new JsonObject { ["dialogOpened"] = true, ["dialog"] = new JsonObject { ["type"] = "confirm", ["message"] = "Sure?" } };
        using var session = new EngineSession((_, _) => answer?.DeepClone());
        AssertEnglishError(await session.CallAsync("browser_fill_form", Args("""{"tab_id":1,"fields":[{"mark":1,"value":"x"}]}""")));
        answer = new JsonObject { ["verified"] = false, ["value"] = "" };
        AssertEnglishError(await session.CallAsync("browser_fill_form", Args("""{"tab_id":1,"fields":[{"mark":1,"value":"x"},{"mark":2,"value":"y"}]}""")));
        answer = new JsonObject { ["binary"] = true };
        AssertEnglishError(await session.CallAsync("browser_export_gsuite", Args("""{"tab_id":1,"format":"pdf"}""")));
    }

    [Fact]
    public void EmergencyStopMessageIsEnglish()
    {
        string message = EmergencyStop.Message(12.0);
        Assert.False(string.IsNullOrWhiteSpace(message));
        Assert.Empty(FrenchMarkers(message));
    }

    // ---------------------------------------------------------------------------------------------
    // browser_eval documented as full page access; masked values announced
    // ---------------------------------------------------------------------------------------------

    [Fact]
    public void EvalIsDocumentedAsFullPageAccess()
    {
        string eval = (string)Tools["browser_eval"]["description"]!;
        Assert.Contains("FULL PAGE ACCESS", eval);
        Assert.Contains("document.cookie", eval);
        Assert.Contains("localStorage", eval);
        string cdp = (string)Tools["browser_cdp_send"]["description"]!;
        Assert.Contains("FULL ACCESS", cdp);
        Assert.Contains("scriptToEvaluateOnLoad is refused", cdp);
        Assert.Contains("full access to the page", McpServer.Instructions);
        Assert.Contains("Password", McpServer.Instructions);
        foreach (string tool in new[] { "browser_content", "browser_fill" })
            Assert.Contains("[masked value]", (string)Tools[tool]["description"]!);
    }

    [Fact]
    public async Task MaskedValueReachesTheAgentUnchanged()
    {
        using var session = new EngineSession((action, _) => action == "cdp-send"
            ? new JsonObject { ["result"] = new JsonObject { ["value"] = new JsonObject { ["success"] = true, ["label"] = "Password", ["clickable"] = true } } }
            : new JsonObject { ["verified"] = true, ["value"] = "[masked value]" });
        var result = await session.CallAsync("browser_fill", Args("""{"selector":"#pw","value":"secret","tab_id":2}"""));
        Assert.False((bool)result["isError"]!, result.ToJsonString());
        Assert.True(JsonNode.DeepEquals(new JsonObject { ["verified"] = true, ["value"] = "[masked value]" }, Payload(result)["data"]), Payload(result).ToJsonString());
    }

    [Fact]
    public void InstructionsNameTheTabWorkflow()
    {
        Assert.Contains("browser_new_tab", McpServer.Instructions);
        Assert.Contains("browser_adopt_tab", McpServer.Instructions);
        foreach (string tool in new[] { "browser_close_tab", "browser_reload", "browser_navigate" })
            Assert.DoesNotContain("current tab", (string)Tools[tool]["description"]!, StringComparison.OrdinalIgnoreCase);
    }

    // ---------------------------------------------------------------------------------------------
    // Read-only hints match what the bridge treats as reads
    // ---------------------------------------------------------------------------------------------

    private static readonly JsonObject Samples = new()
    {
        ["tab_id"] = 1,
        ["locator"] = new JsonObject { ["role"] = "button" },
        ["request_id"] = "1",
        ["url"] = "https://example.invalid/",
        ["gone"] = true,
        ["text"] = "Welcome",
        ["output_path"] = Path.Join(TestEnvironment.Root, "read-only-sample.pdf"),
    };

    [Fact]
    public async Task ReadOnlyHintNeverClaimsAnActionTheBridgeBlocks()
    {
        // Accepted exceptions, which change nothing but stay blocked by the emergency stop: get-cookies (cookie names
        // are sensitive), and the WebMCP tool list (navigator.modelContext read through cdp-send).
        var exceptions = new HashSet<(string, string)> { ("browser_get_cookies", "get-cookies"), ("browser_webmcp_tools", "cdp-send") };
        var problems = new List<string>();
        foreach (var (name, tool) in Tools.Where(t => Hint(t.Key, "readOnlyHint")))
        {
            var required = (tool["inputSchema"]?["required"] as JsonArray ?? []).Select(r => (string)r!).ToList();
            var missing = required.Where(r => !Samples.ContainsKey(r)).ToList();
            Assert.True(missing.Count == 0, $"{name}: required parameter without sample {string.Join(",", missing)}");
            var properties = tool["inputSchema"]?["properties"] as JsonObject ?? [];
            var args = new JsonObject();
            foreach (var (key, value) in Samples) if (properties.ContainsKey(key)) args[key] = value!.DeepClone();
            using var session = new EngineSession((_, _) => new JsonObject());
            await session.CallAsync(name, args);
            var sent = session.Actions;
            if (sent.Count == 0) problems.Add($"{name}: nothing sent");
            foreach (string action in sent.Where(a => !BridgeSecurity.IsReadOnlyAction(a) && !exceptions.Contains((name, a))))
                problems.Add($"{name} -> {action}");
        }
        Assert.Empty(problems);
    }

    [Fact]
    public void CookiesAreNeverAReadForTheBridge()
    {
        foreach (string action in new[] { "get-cookies", "cookies", "get_cookies" })
            Assert.False(BridgeSecurity.IsReadOnlyAction(action), action);
        Assert.True(BridgeSecurity.IsUploadAction("navigate", new JsonObject { ["files"] = new JsonArray() }));
        Assert.False(BridgeSecurity.IsUploadAction("navigate", new JsonObject { ["url"] = "https://example.invalid" }));
    }

    [Fact]
    public void StopAllowedActionsMirrorTheReadOnlyList()
    {
        string source = File.ReadAllText(Repo.File("extension", "background.js"));
        var declared = Regex.Match(source, @"const STOP_ALLOWED_ACTIONS = new Set\(\[(.*?)\]\);", RegexOptions.Singleline);
        Assert.True(declared.Success);
        var extension = Regex.Matches(declared.Groups[1].Value, "\"([^\"]+)\"").Select(m => m.Groups[1].Value).ToHashSet();
        extension.Remove("emergency_stop");
        var fromBridge = BridgeSecurity.ReadOnlyActions.Select(BridgeServer.NormalizeAction).ToHashSet();
        Assert.Empty(fromBridge.Except(extension)); // every read the bridge lets through during a stop, the extension too
        Assert.Empty(extension.Except(fromBridge).Except(["active_tab", "content", "logs", "pdf", "heartbeat"]));
    }

    // ---------------------------------------------------------------------------------------------
    // Output schemas only on data tools
    // ---------------------------------------------------------------------------------------------

    private static readonly HashSet<string> Typed =
    [
        "browser_list_tabs", "browser_active_tab", "browser_new_tab", "browser_find", "browser_network_requests", "browser_download_status",
        "browser_wait_download", "browser_get_cookies", "browser_interactive_map", "browser_logs", "browser_webmcp_tools", "browser_wait_for",
        "browser_content", "browser_axtree", "browser_network_response", "browser_check_handoff", "browser_export", "browser_export_gsuite",
        "browser_youtube_transcript",
    ];

    [Fact]
    public void OnlyDataToolsPublishAnOutputSchema()
    {
        Assert.Equal(Typed.Order(), Tools.Where(t => t.Value["outputSchema"] is JsonObject).Select(t => t.Key).Order());
        foreach (string name in Typed)
        {
            var schema = (JsonObject)Tools[name]["outputSchema"]!;
            Assert.Equal("object", (string?)schema["type"]);
            Assert.False(schema["properties"]!.AsObject().ContainsKey("result"), name); // never the fake {"result": string}
            Assert.True(JsonNode.DeepEquals(new JsonArray("status", "data"), schema["required"]), name);
            Assert.True(JsonNode.DeepEquals(new JsonObject { ["const"] = "success", ["type"] = "string" }, schema["properties"]!["status"]), name);
            Assert.True((bool)schema["additionalProperties"]!, name);
        }
    }

    [Fact]
    public async Task ActionToolAnswersTextOnlyAndFailuresAreErrorsWithoutData()
    {
        bool fail = false;
        using var session = new EngineSession((_, _) => fail ? throw new InvalidOperationException("Bridge unreachable") : new JsonObject { ["scrolled"] = true });
        var scrolled = await session.CallAsync("browser_scroll", Args("""{"tab_id":3}"""));
        Assert.False((bool)scrolled["isError"]!);
        Assert.False(scrolled.ContainsKey("structuredContent"));
        Assert.True(JsonNode.DeepEquals(new JsonObject { ["status"] = "success", ["data"] = new JsonObject { ["scrolled"] = true } }, Payload(scrolled)));
        fail = true;
        foreach (var (name, args) in new[] { ("browser_list_tabs", new JsonObject()), ("browser_scroll", Args("""{"tab_id":3}""")) })
        {
            var failed = await session.CallAsync(name, args);
            Assert.True((bool)failed["isError"]!, name);
            Assert.False(failed.ContainsKey("structuredContent"), name);
            Assert.True(JsonNode.DeepEquals(new JsonObject { ["status"] = "error", ["error"] = "Bridge unreachable" }, Payload(failed)), Payload(failed).ToJsonString());
        }
    }

    [Fact]
    public async Task StructuredContentIsExactlyTheTextAnswer()
    {
        var tab = new JsonObject { ["id"] = 7, ["index"] = 0, ["windowId"] = 1, ["active"] = false, ["pinned"] = false, ["groupId"] = 3, ["mine"] = true,
            ["owner"] = "Claude", ["adopted"] = false, ["state"] = "mine", ["title"] = "Example", ["url"] = "https://example.com/a?q=1" };
        using var session = new EngineSession((_, _) => new JsonArray(tab.DeepClone()));
        var result = await session.CallAsync("browser_list_tabs");
        Assert.False((bool)result["isError"]!);
        Assert.Single(result["content"]!.AsArray());
        Assert.True(JsonNode.DeepEquals(result["structuredContent"], Payload(result)));
        Assert.True(JsonNode.DeepEquals(new JsonArray(tab.DeepClone()), result["structuredContent"]!["data"]));
    }

    [Theory]
    [InlineData("duration_covered_seconds", "\"2\"")]
    [InlineData("truncated", "0")]
    [InlineData("segments", "true")]
    public async Task ValidationIsStrictLikeThePublishedSchema(string field, string value)
    {
        var transcript = Args("""
            {"video_id":"abc","url":"https://www.youtube.com/watch?v=abc","title":"Video","channel":null,"length_seconds":null,
             "track":{"lang":"fr","name":"French","auto":true,"translatable":true,"translated":false,"translated_to":null,"source_format":"json3"},
             "available_tracks":[{"lang":"fr","name":null,"auto":true,"translatable":true}],"segments":1,"duration_covered_seconds":2.5,
             "timed_text":"[00:00] Bonjour","text":"Bonjour","truncated":false,"total_chars":{"timed_text":15,"text":7},"method":"direct",
             "player_source":"player","captions_toggled":false}
            """);
        JsonObject answer = (JsonObject)transcript.DeepClone();
        using var session = new EngineSession((_, _) => answer.DeepClone());
        var good = await session.CallAsync("browser_youtube_transcript", Args("""{"tab_id":3}"""));
        Assert.False((bool)good["isError"]!, good.ToJsonString());

        answer[field] = JsonNode.Parse(value);
        var bad = await session.CallAsync("browser_youtube_transcript", Args("""{"tab_id":3}"""));
        Assert.True((bool)bad["isError"]!, bad.ToJsonString());
        Assert.False(bad.ContainsKey("structuredContent"));
        Assert.Contains(field, (string)Payload(bad)["error"]!);
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(value), Payload(bad)["data"]![field]));

        answer[field] = transcript[field]!.DeepClone();
        answer["duration_covered_seconds"] = 2; // an integer stays a JSON number
        Assert.False((bool)(await session.CallAsync("browser_youtube_transcript", Args("""{"tab_id":3}""")))["isError"]!);
    }

    // ---------------------------------------------------------------------------------------------
    // One tab per agent, transport timeouts
    // ---------------------------------------------------------------------------------------------

    private static JsonObject NeutralTrigger() => new()
    {
        ["result"] = new JsonObject { ["value"] = new JsonObject { ["success"] = true, ["label"] = "Next", ["clickable"] = true } },
    };

    [Fact]
    public async Task EachCommandCarriesTheTabIdGivenByTheAgent()
    {
        int next = 11;
        string upload = Path.Join(TestEnvironment.Root, "rapport.pdf");
        File.WriteAllText(upload, "%PDF");
        using var session = new EngineSession((action, parameters) => action switch
        {
            "cdp-send" => NeutralTrigger(),
            "create-tab" => new JsonObject { ["id"] = next++, ["url"] = parameters["url"]?.DeepClone() },
            _ => new JsonObject { ["ok"] = true },
        });
        int created = (int)Payload(await session.CallAsync("browser_new_tab", Args("""{"url":"https://a.invalid"}""")))["data"]!["id"]!;
        Assert.Equal(11, created);
        Assert.Null(session.Commands[0]["params"]?["tab_id"]);
        var calls = new (string Tool, JsonObject Args, string Action)[]
        {
            ("browser_click", Args($$"""{"selector":"#payer","tab_id":{{created}}}"""), "click"),
            ("browser_fill", Args($$"""{"selector":"#q","value":"b","tab_id":{{created}}}"""), "fill"),
            ("browser_eval", Args($$"""{"script":"1","tab_id":{{created}}}"""), "eval"),
            ("browser_handle_dialog", Args($$"""{"accept":false,"tab_id":{{created}}}"""), "handle-dialog"),
            ("browser_upload", new JsonObject { ["files"] = new JsonArray(upload), ["tab_id"] = created }, "upload"),
        };
        foreach (var (tool, args, action) in calls)
        {
            int before = session.Commands.Count;
            var result = await session.CallAsync(tool, args);
            Assert.False((bool)result["isError"]!, $"{tool}: {result.ToJsonString()}");
            var sent = session.Commands.Skip(before).ToList();
            Assert.Equal(action, (string?)sent[^1]["action"]);
            Assert.All(sent, c => Assert.Equal(11, (int?)c["params"]?["tab_id"]));
        }
    }

    [Fact]
    public async Task TabFreeToolsStayAvailable()
    {
        using var session = new EngineSession((action, _) => action == "list-tabs" ? new JsonArray() : null);
        Assert.Equal("success", (string?)Payload(await session.CallAsync("browser_list_tabs"))["status"]);
        Assert.Equal("success", (string?)Payload(await session.CallAsync("browser_active_tab"))["status"]);
        Assert.Equal("error", (string?)Payload(await session.CallAsync("browser_group_tabs", Args("""{"tab_ids":[]}""")))["status"]);
        Assert.Equal(["list-tabs", "active-tab"], session.Actions);
    }

    [Fact]
    public async Task TransportTimeoutFollowsTheRequestedWait()
    {
        using var session = new EngineSession((action, _) => action == "cdp-send" ? NeutralTrigger() : new JsonObject { ["ok"] = true });
        var calls = new (string Tool, string Args)[]
        {
            ("browser_wait_load", """{"timeout_ms":60000,"tab_id":1}"""),
            ("browser_wait_network_idle", """{"timeout_ms":112000,"tab_id":1}"""),
            ("browser_click", """{"selector":"a","timeout_ms":30000,"tab_id":1}"""),
            ("browser_hover", """{"selector":"a","timeout_ms":40000,"tab_id":1}"""),
            ("browser_fill", """{"selector":"a","value":"x","timeout_ms":50000,"tab_id":1}"""),
            ("browser_check", """{"selector":"a","timeout_ms":70000,"tab_id":1}"""),
            ("browser_wait_download", """{"timeout_ms":90000,"tab_id":1}"""),
            ("browser_wait_load", """{"timeout_ms":1000,"tab_id":1}"""), // never under the ordinary 20 s
        };
        foreach (var (tool, args) in calls) await session.CallAsync(tool, Args(args));
        var timeouts = session.Commands.Where(c => (string?)c["action"] != "cdp-send").Select(c => (double)c["timeout"]!).ToList();
        Assert.Equal([65.0, 115.0, 35.0, 45.0, 55.0, 75.0, 95.0, 20.0], timeouts);

        foreach (var (tool, extra) in new[] { ("browser_wait_load", ""), ("browser_wait_network_idle", ""), ("browser_wait_download", ""), ("browser_click", ",\"selector\":\"a\"") })
        {
            int before = session.Commands.Count;
            var payload = Payload(await session.CallAsync(tool, Args($$"""{"timeout_ms":200000,"tab_id":1{{extra}}}""")));
            Assert.Equal("error", (string?)payload["status"]);
            Assert.Contains("at most 115000 ms", (string)payload["error"]!);
            var sent = session.Commands.Skip(before).Select(c => (string)c["action"]!).ToList();
            Assert.True(sent.Count == 0, $"{tool} refused its wait but sent {string.Join(", ", sent)}");
        }
    }

    [Fact]
    public async Task RefusedWaitReadsNothingFromThePage()
    {
        using var session = new EngineSession((action, _) => action == "cdp-send" ? NeutralTrigger() : new JsonObject { ["ok"] = true });
        var payload = Payload(await session.CallAsync("browser_click", Args("""{"selector":"a","timeout_ms":200000,"tab_id":1}""")));
        Assert.Contains("at most 115000 ms", (string)payload["error"]!);
        Assert.Empty(session.Commands);
    }
}
