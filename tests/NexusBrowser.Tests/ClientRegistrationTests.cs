using System.Text.Json;
using System.Text.Json.Nodes;
using NexusBrowser.Native;
using Xunit;

namespace NexusBrowser.Tests;

/// <summary>
/// --register (public install): one stdio entry per AI client found, pointing to the native engine with --mcp,
/// replaced in place when it is ours (this engine or the former Python server), never the one the user wrote
/// differently, nothing else touched (port of tests/test_register_clients.py). Every path is a temporary folder.
/// </summary>
public sealed class ClientRegistrationTests : IDisposable
{
    private const string Exe = @"C:\Users\someone\AppData\Local\NexusBrowser\app\NexusBrowser.exe";
    private const string Py = @"D:\NexusTest\venv\Scripts\python.exe";
    private const string Server = @"D:\NexusTest\app\client\mcp_server.py";

    private readonly TempDir _dir = new();
    private readonly List<(string File, string[] Args)> _runs = [];
    private string? _cli;
    private bool _antigravityRunning;
    private (int, string) _runResult = (0, "");

    private string Home => _dir["home"];
    private string Roaming => Path.Combine(Home, "AppData", "Roaming");
    private string Local => Path.Combine(Home, "AppData", "Local");
    private string Backups => _dir["b"];

    public ClientRegistrationTests() => Directory.CreateDirectory(Home);

    public void Dispose() => _dir.Dispose();

    private ClientRegistration.Context Context(string exe = Exe) => new(
        Home, Roaming, Local, exe, Backups, Repo.Root,
        name => name == "claude" ? _cli : null,
        (file, args) => { _runs.Add((file, args)); return _runResult; },
        () => _antigravityRunning);

    private static JsonNode? ReadJson(string path) => JsonNode.Parse(File.ReadAllText(path));

    private static void AssertJson(JsonNode? expected, JsonNode? actual) =>
        Assert.True(JsonNode.DeepEquals(expected, actual), $"expected {expected?.ToJsonString()}\nactual   {actual?.ToJsonString()}");

    private static JsonObject Entry(string agent, string exe = Exe) => ClientRegistration.Entry(exe, agent);

    private static JsonObject PythonEntry(string agent) => new()
    {
        ["command"] = Py,
        ["args"] = new JsonArray("-B", Server),
        ["env"] = new JsonObject { ["NEXUS_BROWSER_AGENT"] = agent },
    };

    private static string CodexBlock(string exe = Exe) =>
        $"[mcp_servers.nexus-browser]\ncommand = {JsonSerializer.Serialize(exe)}\nargs = [\"--mcp\"]\n\n[mcp_servers.nexus-browser.env]\nNEXUS_BROWSER_AGENT = \"Codex\"\n";

    // ---------------------------------------------------------------------------------------------
    // Entry shape and ownership
    // ---------------------------------------------------------------------------------------------

    [Fact]
    public void EntryIsTheNativeEngineWithMcpAndTheAgentName() => AssertJson(new JsonObject
    {
        ["command"] = Exe,
        ["args"] = new JsonArray("--mcp"),
        ["env"] = new JsonObject { ["NEXUS_BROWSER_AGENT"] = "Codex" },
    }, Entry("Codex"));

    [Fact]
    public void OursIsTheNativeEngineOrTheFormerPythonServer()
    {
        Assert.True(ClientRegistration.Ours(null));
        Assert.True(ClientRegistration.Ours(Entry("Claude")));
        Assert.True(ClientRegistration.Ours(new JsonObject { ["command"] = @"D:\other\nexusbrowser.EXE" }));
        Assert.True(ClientRegistration.Ours(PythonEntry("Claude")));
        Assert.True(ClientRegistration.Ours(new JsonObject { ["command"] = "python", ["args"] = new JsonArray("-B", "C:/x/client/mcp_server.py") }));
        Assert.False(ClientRegistration.Ours(new JsonObject { ["command"] = "uvx", ["args"] = new JsonArray("nexus-browser") }));
        Assert.False(ClientRegistration.Ours(new JsonObject { ["serverUrl"] = "http://127.0.0.1:16182/mcp?agent=claude" }));
        Assert.False(ClientRegistration.Ours(new JsonObject { ["command"] = "python", ["args"] = new JsonArray("C:/x/other/mcp_server.py") }));
        Assert.False(ClientRegistration.Ours(JsonValue.Create("nexus-browser")));
    }

    // ---------------------------------------------------------------------------------------------
    // Codex (~/.codex/config.toml)
    // ---------------------------------------------------------------------------------------------

    private string CodexConfig => Path.Combine(Home, ".codex", "config.toml");

    [Fact]
    public void CodexAddedThenReplacedInPlaceOtherSettingsKept()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(CodexConfig)!);
        const string user = "model = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"x\"\n";
        File.WriteAllText(CodexConfig, user);

        Assert.StartsWith("declared", ClientRegistration.Codex(Context()));
        Assert.Equal(user + "\n" + CodexBlock(), File.ReadAllText(CodexConfig));
        Assert.Equal("already declared", ClientRegistration.Codex(Context()));

        // Engine moved (new install folder): our tables are replaced, the table after them is kept.
        File.AppendAllText(CodexConfig, "\n[profiles.fast]\nmodel = \"y\"\n");
        const string moved = @"E:\Apps\NexusBrowser\NexusBrowser.exe";
        Assert.StartsWith("declared", ClientRegistration.Codex(Context(moved)));
        Assert.Equal(user + "\n[profiles.fast]\nmodel = \"y\"\n\n" + CodexBlock(moved), File.ReadAllText(CodexConfig));
        Assert.NotEmpty(Directory.EnumerateFiles(Backups)); // backup made before each write
    }

    [Fact]
    public void CodexFormerPythonEntryIsReplacedAndTheUserTablesAreUntouched()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(CodexConfig)!);
        const string before = "model = \"gpt-5\"\napproval_policy = \"never\"\n\n[mcp_servers.other]\ncommand = \"x\"\nargs = [\"a\", \"b\"]\n\n";
        const string after = "\n[profiles.fast]\nmodel = \"y\"\n\n[mcp_servers.other.env]\nKEY = \"v\" # comment kept\n";
        string python =
            "[mcp_servers.nexus-browser]\n" +
            $"command = {JsonSerializer.Serialize(Py)}\n" +
            $"args = [\"-B\", {JsonSerializer.Serialize(Server)}]\n\n" +
            "[mcp_servers.nexus-browser.env]\nNEXUS_BROWSER_AGENT = \"Codex\"\n";
        File.WriteAllText(CodexConfig, before + python + after);

        Assert.StartsWith("declared", ClientRegistration.Codex(Context()));
        string written = File.ReadAllText(CodexConfig);
        Assert.Equal(before.TrimEnd('\n') + "\n" + after + "\n" + CodexBlock(), written);
        Assert.DoesNotContain("mcp_server.py", written);
        Assert.Single(System.Text.RegularExpressions.Regex.Matches(written, @"^\[mcp_servers\.nexus-browser\]", System.Text.RegularExpressions.RegexOptions.Multiline));
        Assert.Equal("already declared", ClientRegistration.Codex(Context()));
    }

    [Fact]
    public void CodexFormerPythonEntryWithLiteralStringsIsReplaced()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(CodexConfig)!);
        File.WriteAllText(CodexConfig, $"[mcp_servers.nexus-browser]\ncommand = '{Py}'\nargs = ['-B', '{Server}']\n");
        Assert.StartsWith("declared", ClientRegistration.Codex(Context()));
        Assert.Equal(CodexBlock(), File.ReadAllText(CodexConfig));
    }

    [Fact]
    public void CodexEntryOfTheUserKept()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(CodexConfig)!);
        const string original = "[mcp_servers.nexus-browser]\ncommand = \"uvx\"\nargs = [\"nexus-browser\"]\n";
        File.WriteAllText(CodexConfig, original);
        Assert.StartsWith("kept", ClientRegistration.Codex(Context()));
        Assert.Equal(original, File.ReadAllText(CodexConfig));
        Assert.False(Directory.Exists(Backups));
    }

    [Theory]
    [InlineData("mcp_servers.nexus-browser = { command = \"uvx\" }\n")]
    [InlineData("[mcp_servers]\nnexus-browser = { command = \"uvx\" }\n")]
    [InlineData("[mcp_servers]\n\"nexus-browser\".command = \"uvx\"\n")]
    public void CodexEntryInAFormThisInstallerDoesNotEditIsKept(string original)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(CodexConfig)!);
        File.WriteAllText(CodexConfig, original);
        Assert.StartsWith("kept (entry written in a form", ClientRegistration.Codex(Context()));
        Assert.Equal(original, File.ReadAllText(CodexConfig));
    }

    [Fact]
    public void CodexAbsent() => Assert.Null(ClientRegistration.Codex(Context()));

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ConfiguredCodexPluginPreventsDuplicateServersEvenWhenDisabled(bool enabled)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(CodexConfig)!);
        string plugin = $"[plugins.\"nexus-browser@nexus-plugins\"]\nenabled = {enabled.ToString().ToLowerInvariant()}\n";
        string installed = Path.Combine(Local, "NexusBrowser", "versions", "0123456789abcdef", "NexusBrowser.exe");
        File.WriteAllText(CodexConfig, plugin);
        Assert.Equal(ClientRegistration.Plugin, ClientRegistration.Codex(Context()));
        Assert.Equal(plugin, File.ReadAllText(CodexConfig));
        File.WriteAllText(CodexConfig, plugin + "\n" + ClientRegistration.CodexBlock(installed));
        Assert.Equal(ClientRegistration.Removed, ClientRegistration.Codex(Context()));
        Assert.Equal(plugin + "\n", File.ReadAllText(CodexConfig));
        string customized = plugin + "\n" + CodexBlock() + "CUSTOM_OPTION = \"keep\"\n";
        File.WriteAllText(CodexConfig, customized);
        Assert.StartsWith("kept", ClientRegistration.Codex(Context()));
        Assert.Equal(customized, File.ReadAllText(CodexConfig));
        string customPath = plugin + "\n" + ClientRegistration.CodexBlock(@"C:\Tools\NexusBrowser.exe");
        File.WriteAllText(CodexConfig, customPath);
        Assert.StartsWith("kept", ClientRegistration.Codex(Context()));
        Assert.Equal(customPath, File.ReadAllText(CodexConfig));
    }

    [Theory]
    [InlineData("[plugins.\"nexus-browser@nexus-plugins\"] # user comment\nenabled = true\n")]
    [InlineData("[plugins . \"nexus-browser@nexus-plugins\"] # spaced\nenabled = false\n")]
    [InlineData("['plugins' . 'nexus-browser@nexus-plugins'] # quoted keys\nenabled = true\n")]
    [InlineData("[plugins]\n\"nexus-browser@nexus-plugins\" = { enabled = false }\n")]
    public void StandardTomlPluginFormsKeepTheirExactBytesAndNeverAddADirectServer(string plugin)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(CodexConfig)!);
        File.WriteAllText(CodexConfig, plugin);
        Assert.Equal(ClientRegistration.Plugin, ClientRegistration.Codex(Context()));
        Assert.Equal(plugin, File.ReadAllText(CodexConfig));
        string installed = Path.Combine(Local, "NexusBrowser", "versions", "0123456789abcdef", "NexusBrowser.exe");
        File.WriteAllText(CodexConfig, plugin + "\n" + ClientRegistration.CodexBlock(installed));
        Assert.Equal(ClientRegistration.Removed, ClientRegistration.Codex(Context()));
        Assert.Equal(plugin + "\n", File.ReadAllText(CodexConfig));
    }

    [Fact]
    public void CodexOnPathWithoutConfigGetsANewFile()
    {
        var context = Context() with { Which = name => name == "codex" ? @"C:\bin\codex.exe" : null };
        Assert.StartsWith("declared", ClientRegistration.Codex(context));
        Assert.Equal(CodexBlock(), File.ReadAllText(CodexConfig));
    }

    [Fact]
    public void UnreadableCodexConfigIsLeftUntouched()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(CodexConfig)!);
        File.WriteAllText(CodexConfig, "not = [valid");
        Assert.StartsWith("failed", ClientRegistration.Codex(Context()) ?? "");
        Assert.Equal("not = [valid", File.ReadAllText(CodexConfig));
    }

    // ---------------------------------------------------------------------------------------------
    // Antigravity (a plugin, never its global mcp_config.json)
    // ---------------------------------------------------------------------------------------------

    [Fact]
    public void AntigravityGetsAPluginAndTheGlobalEntryOfAnEarlierVersionGoes()
    {
        string folder = Path.Combine(Home, ".gemini", "config");
        Directory.CreateDirectory(folder);
        File.WriteAllText(Path.Combine(folder, "mcp_config.json"),
            new JsonObject { ["mcpServers"] = new JsonObject { ["other"] = new JsonObject { ["command"] = "x" }, ["nexus-browser"] = PythonEntry("Antigravity") } }.ToJsonString());
        File.WriteAllText(Path.Combine(folder, "config.json"), "{\"theme\": \"dark\"}");

        Assert.StartsWith("plugin installed and enabled", ClientRegistration.Antigravity(Context()));
        string plugin = Path.Combine(folder, "plugins", "nexus-browser");
        AssertJson(new JsonObject { ["mcpServers"] = new JsonObject { ["nexus-browser"] = Entry("Antigravity") } }, ReadJson(Path.Combine(plugin, "mcp_config.json")));
        Assert.Equal("nexus-browser", (string?)ReadJson(Path.Combine(plugin, "plugin.json"))!["name"]);
        Assert.Equal(new byte[] { 0x89, (byte)'P', (byte)'N', (byte)'G', 0x0D, 0x0A, 0x1A, 0x0A }, File.ReadAllBytes(Path.Combine(plugin, "logo.png"))[..8]);
        string skill = File.ReadAllText(Path.Combine(plugin, "skills", "nexus-browser", "SKILL.md"));
        Assert.Equal(File.ReadAllText(Repo.File("plugin", "skills", "nexus-browser", "SKILL.md")).ReplaceLineEndings("\n"), skill.ReplaceLineEndings("\n"));
        Assert.DoesNotContain("Julien", skill, StringComparison.Ordinal);
        AssertJson(new JsonObject { ["mcpServers"] = new JsonObject { ["other"] = new JsonObject { ["command"] = "x" } } }, ReadJson(Path.Combine(folder, "mcp_config.json")));
        AssertJson(new JsonObject { ["theme"] = "dark", ["plugins"] = new JsonObject { ["nexus-browser"] = new JsonObject { ["enabled"] = true } } }, ReadJson(Path.Combine(folder, "config.json")));
        Assert.Equal("plugin", ClientRegistration.Short(ClientRegistration.Antigravity(Context()))); // run again: same plugin, in place
    }

    [Fact]
    public void AntigravityOpenOrWithoutConfigIsToldToEnableIt()
    {
        _antigravityRunning = true;
        string folder = Path.Combine(Home, ".gemini", "antigravity");
        Directory.CreateDirectory(folder);
        File.WriteAllText(Path.Combine(folder, "config.json"), "{}");
        Assert.Contains("enable nexus-browser", ClientRegistration.Antigravity(Context()));
        Assert.Equal("{}", File.ReadAllText(Path.Combine(folder, "config.json")));
    }

    [Fact]
    public void AntigravityPluginOfTheUserKept()
    {
        string plugin = Path.Combine(Home, ".gemini", "config", "plugins", "nexus-browser");
        Directory.CreateDirectory(plugin);
        string mine = new JsonObject { ["mcpServers"] = new JsonObject { ["nexus-browser"] = new JsonObject { ["serverUrl"] = "http://127.0.0.1:16182/mcp?agent=antigravity" } } }.ToJsonString();
        File.WriteAllText(Path.Combine(plugin, "mcp_config.json"), mine);
        Assert.Equal(ClientRegistration.Plugin, ClientRegistration.Antigravity(Context()));
        Assert.Equal(mine, File.ReadAllText(Path.Combine(plugin, "mcp_config.json")));
    }

    [Fact]
    public void AntigravityAbsent() => Assert.Null(ClientRegistration.Antigravity(Context()));

    // ---------------------------------------------------------------------------------------------
    // Claude Code (CLI or ~/.claude.json)
    // ---------------------------------------------------------------------------------------------

    private string ClaudeJson => Path.Combine(Home, ".claude.json");

    private void EnableClaudePlugin()
    {
        Directory.CreateDirectory(Path.Combine(Home, ".claude"));
        File.WriteAllText(Path.Combine(Home, ".claude", "settings.json"), "{\"enabledPlugins\": {\"nexus-browser@nexus\": true}}");
    }

    [Fact]
    public void ClaudeCodeWithoutCliEditsClaudeJson()
    {
        File.WriteAllText(ClaudeJson, "{\"projects\": {\"C:/p\": {}}, \"mcpServers\": {}}");
        Assert.StartsWith("declared", ClientRegistration.ClaudeCode(Context()));
        var data = ReadJson(ClaudeJson)!;
        AssertJson(new JsonObject { ["C:/p"] = new JsonObject() }, data["projects"]);
        var expected = new JsonObject { ["type"] = "stdio" };
        foreach (var (key, value) in Entry("Claude")) expected[key] = value?.DeepClone();
        AssertJson(expected, data["mcpServers"]!["nexus-browser"]);
        Assert.Equal("already declared", ClientRegistration.ClaudeCode(Context()));
        Assert.Empty(_runs);
    }

    [Fact]
    public void ClaudeCodeWithoutCliOrConfigIsAbsent() => Assert.Null(ClientRegistration.ClaudeCode(Context()));

    [Fact]
    public void ClaudeCodeWithCliReplacesItsUserScopeEntry()
    {
        _cli = @"C:\npm\claude.cmd";
        Assert.Equal("declared (claude mcp add, user scope)", ClientRegistration.ClaudeCode(Context()));
        Assert.Equal(2, _runs.Count);
        Assert.All(_runs, run => Assert.Equal(_cli, run.File));
        Assert.Equal(["mcp", "remove", "nexus-browser", "--scope", "user"], _runs[0].Args);
        Assert.Equal(["mcp", "add", "nexus-browser", "--scope", "user", "-e", "NEXUS_BROWSER_AGENT=Claude", "--", Exe, "--mcp"], _runs[1].Args);
    }

    [Fact]
    public void ClaudeCodeCliFailureIsReported()
    {
        _cli = @"C:\npm\claude.cmd";
        _runResult = (1, "boom\n");
        Assert.Equal("failed: boom", ClientRegistration.ClaudeCode(Context()));
    }

    [Fact]
    public void ClaudeCodeWithCliKeepsAnEntryOfTheUser()
    {
        _cli = @"C:\npm\claude.cmd";
        File.WriteAllText(ClaudeJson, "{\"mcpServers\": {\"nexus-browser\": {\"command\": \"uvx\", \"args\": [\"nexus-browser\"]}}}");
        Assert.StartsWith("kept", ClientRegistration.ClaudeCode(Context()));
        Assert.Empty(_runs);
    }

    [Fact]
    public void ClaudeCodePluginEnabledLeftAlone()
    {
        EnableClaudePlugin();
        File.WriteAllText(ClaudeJson, "{}");
        Assert.Equal(ClientRegistration.Plugin, ClientRegistration.ClaudeCode(Context()));
        Assert.Equal("{}", File.ReadAllText(ClaudeJson));
    }

    [Fact]
    public void ClaudeCodePluginAfterTheInstallerRemovesOnlyOurEntry()
    {
        File.WriteAllText(ClaudeJson, "{}");
        Assert.StartsWith("declared", ClientRegistration.ClaudeCode(Context()));
        EnableClaudePlugin();
        Assert.Equal(ClientRegistration.Removed, ClientRegistration.ClaudeCode(Context()));
        AssertJson(new JsonObject(), ReadJson(ClaudeJson)!["mcpServers"]);
        // An entry the user wrote is never removed, even with the plugin.
        string user = "{\"mcpServers\":{\"nexus-browser\":{\"command\":\"uvx\",\"args\":[\"nexus-browser\"]}}}";
        File.WriteAllText(ClaudeJson, user);
        Assert.Equal(ClientRegistration.Plugin, ClientRegistration.ClaudeCode(Context()));
        Assert.Equal(user, File.ReadAllText(ClaudeJson));
    }

    [Fact]
    public void ClaudeCodePluginWithCliRemovesOurEntryThroughTheCli()
    {
        _cli = @"C:\npm\claude.cmd";
        EnableClaudePlugin();
        File.WriteAllText(ClaudeJson, new JsonObject { ["mcpServers"] = new JsonObject { ["nexus-browser"] = PythonEntry("Claude") } }.ToJsonString());
        Assert.Equal(ClientRegistration.Removed, ClientRegistration.ClaudeCode(Context()));
        var run = Assert.Single(_runs);
        Assert.Equal(["mcp", "remove", "nexus-browser", "--scope", "user"], run.Args);
    }

    // ---------------------------------------------------------------------------------------------
    // Claude Desktop (classic, Store package, Claude-Data)
    // ---------------------------------------------------------------------------------------------

    [Fact]
    public void ClaudeDesktopClassicAndStore()
    {
        string classic = Path.Combine(Roaming, "Claude");
        string store = Path.Combine(Local, "Packages", "Claude_abc", "LocalCache", "Roaming", "Claude");
        Directory.CreateDirectory(classic);
        Directory.CreateDirectory(store);
        var results = ClientRegistration.ClaudeDesktop(Context());
        Assert.Equal(2, results.Count);
        Assert.All(results, r => Assert.StartsWith("declared", r));
        foreach (string folder in new[] { classic, store })
            AssertJson(new JsonObject { ["mcpServers"] = new JsonObject { ["nexus-browser"] = Entry("Claude") } }, ReadJson(Path.Combine(folder, "claude_desktop_config.json")));
    }

    [Fact]
    public void ClaudeDesktopStoreClaudeDataAndLeftFolderSkipped()
    {
        string store = Path.Combine(Local, "Packages", "AnthropicPBC.Claude_abc", "LocalCache", "Roaming", "Claude");
        string data = Path.Combine(Local, "Claude-Data", "anthropicpbc.claude_abc");
        string left = Path.Combine(Local, "Claude-Data", "anthropicpbc.claude_old");
        foreach (string folder in new[] { store, data, left }) Directory.CreateDirectory(folder);
        File.WriteAllText(Path.Combine(left, ".user-data-left.2026-10-25"), "");
        var results = ClientRegistration.ClaudeDesktop(Context());
        Assert.Equal(2, results.Count);
        Assert.All(results, r => Assert.StartsWith("declared", r));
        foreach (string folder in new[] { store, data })
            Assert.NotNull(ReadJson(Path.Combine(folder, "claude_desktop_config.json"))!["mcpServers"]!["nexus-browser"]);
        Assert.False(File.Exists(Path.Combine(left, "claude_desktop_config.json")));
    }

    [Fact]
    public void ClaudeDesktopFormerPythonEntryIsReplacedInPlace()
    {
        string folder = Path.Combine(Roaming, "Claude");
        Directory.CreateDirectory(folder);
        string config = Path.Combine(folder, "claude_desktop_config.json");
        File.WriteAllText(config, new JsonObject
        {
            ["globalShortcut"] = "Ctrl+Space",
            ["mcpServers"] = new JsonObject { ["other"] = new JsonObject { ["command"] = "x" }, ["nexus-browser"] = PythonEntry("Claude") },
        }.ToJsonString());

        Assert.Equal([$"declared in {config}"], ClientRegistration.ClaudeDesktop(Context()));
        AssertJson(new JsonObject
        {
            ["globalShortcut"] = "Ctrl+Space",
            ["mcpServers"] = new JsonObject { ["other"] = new JsonObject { ["command"] = "x" }, ["nexus-browser"] = Entry("Claude") },
        }, ReadJson(config));
        Assert.Single(Directory.EnumerateFiles(Backups));
        Assert.Equal(["already declared"], ClientRegistration.ClaudeDesktop(Context()));
    }

    [Fact]
    public void ClaudeDesktopEntryOfTheUserKept()
    {
        string folder = Path.Combine(Roaming, "Claude");
        Directory.CreateDirectory(folder);
        string config = Path.Combine(folder, "claude_desktop_config.json");
        string user = "{\"mcpServers\":{\"nexus-browser\":{\"command\":\"uvx\",\"args\":[\"nexus-browser\"]}}}";
        File.WriteAllText(config, user);
        Assert.Equal(["kept (an entry of yours already exists)"], ClientRegistration.ClaudeDesktop(Context()));
        Assert.Equal(user, File.ReadAllText(config));
    }

    [Fact]
    public void ClaudeDesktopWithTheMcpbExtensionGetsNoSecondServer()
    {
        string desktop = Path.Combine(Roaming, "Claude");
        Assert.Empty(ClientRegistration.ClaudeDesktop(Context())); // folder absent: nothing
        Directory.CreateDirectory(desktop);
        Assert.StartsWith("declared", ClientRegistration.ClaudeDesktop(Context())[0]);
        string extension = Path.Combine(desktop, "Claude Extensions", "local.mcpb.julien-piron.nexus-browser");
        Directory.CreateDirectory(extension);
        File.WriteAllText(Path.Combine(extension, "manifest.json"), "{\"name\": \"nexus-browser\"}");
        string result = ClientRegistration.ClaudeDesktop(Context())[0];
        Assert.Equal(ClientRegistration.Mcpb + " (the installer's own entry removed)", result);
        Assert.Equal("plugin", ClientRegistration.Short(result));
        var servers = ReadJson(Path.Combine(desktop, "claude_desktop_config.json"))!["mcpServers"] as JsonObject;
        Assert.False(servers?.ContainsKey("nexus-browser") ?? false);
        Assert.Equal([ClientRegistration.Mcpb], ClientRegistration.ClaudeDesktop(Context()));
    }

    // ---------------------------------------------------------------------------------------------
    // Pack summary, scope and the whole run
    // ---------------------------------------------------------------------------------------------

    [Fact]
    public void PackSummaryWords()
    {
        Assert.Equal(["absent", "declared", "declared", "plugin", "plugin", "plugin", "plugin", "kept", "failed", "skipped"],
            new[] { null, "declared in x", "already declared", ClientRegistration.Plugin, ClientRegistration.Removed, ClientRegistration.Mcpb,
                "plugin installed in x", "kept (y)", "failed: z", ClientRegistration.Skipped }.Select(ClientRegistration.Short));
    }

    [Fact]
    public void PackScopeParsing()
    {
        Assert.Null(ClientRegistration.PackScope(null)); // absent: every AI app
        Assert.Empty(ClientRegistration.PackScope("")!); // empty: none
        Assert.Equal(new HashSet<string> { "Codex", "Claude Desktop" }, ClientRegistration.PackScope(" Codex, claude-desktop ")!);
        Assert.Equal(new HashSet<string> { "Claude Code", "Antigravity" }, ClientRegistration.PackScope("claude-code antigravity")!);
        var error = Assert.Throws<ArgumentException>(() => ClientRegistration.PackScope("codex, chatgpt, aa"));
        Assert.Contains("aa, chatgpt", error.Message);
    }

    private (int Code, string[] Lines) Register(string? targets, bool pack)
    {
        using var output = new StringWriter();
        int code = ClientRegistration.Register(Context(), targets, pack, output);
        return (code, output.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
    }

    [Fact]
    public void PackScopeConfiguresOnlyTheListedAiApps()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(CodexConfig)!);
        File.WriteAllText(CodexConfig, "model = \"x\"\n");
        string desktop = Path.Combine(Roaming, "Claude");
        Directory.CreateDirectory(desktop);
        File.WriteAllText(ClaudeJson, "{}");
        Directory.CreateDirectory(Path.Combine(Home, ".gemini", "config"));

        var (code, lines) = Register("codex", pack: true);
        Assert.Equal(0, code);
        Assert.Contains("nexus-browser", File.ReadAllText(CodexConfig));
        Assert.False(File.Exists(Path.Combine(desktop, "claude_desktop_config.json"))); // Claude Desktop excluded: nothing written
        Assert.Equal("{}", File.ReadAllText(ClaudeJson)); // Claude Code excluded: file intact
        Assert.False(Directory.Exists(Path.Combine(Home, ".gemini", "config", "plugins")));
        Assert.Equal("NEXUS_PACK_RESULT Claude Code=skipped; Codex=declared; Antigravity=skipped; Claude Desktop=skipped", lines[^1]);
        Assert.Contains($"Codex: declared in {CodexConfig}", lines);

        string codexBefore = File.ReadAllText(CodexConfig);
        (code, lines) = Register("codex, chatgpt", pack: true);
        Assert.Equal(2, code); // unknown name: refused, nothing configured
        Assert.Equal(["unknown AI app in NEXUS_PACK_TARGETS: chatgpt"], lines);
        Assert.Equal(codexBefore, File.ReadAllText(CodexConfig));
    }

    [Fact]
    public void WholeRunPrintsOneLinePerClientAndThePackResultLast()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(CodexConfig)!);
        Directory.CreateDirectory(Path.Combine(Roaming, "Claude"));
        File.WriteAllText(ClaudeJson, "{}");

        var (code, lines) = Register(null, pack: true);
        Assert.Equal(0, code);
        Assert.Equal(
        [
            $"Claude Code: declared in {ClaudeJson}",
            $"Codex: declared in {CodexConfig}",
            $"Claude Desktop: declared in {Path.Combine(Roaming, "Claude", "claude_desktop_config.json")}",
            "NEXUS_PACK_RESULT Claude Code=declared; Codex=declared; Antigravity=absent; Claude Desktop=declared",
        ], lines);

        (code, lines) = Register(null, pack: false);
        Assert.Equal(0, code);
        Assert.DoesNotContain(lines, l => l.StartsWith("NEXUS_PACK_RESULT", StringComparison.Ordinal));
        Assert.Equal(["Claude Code: already declared", "Codex: already declared", "Claude Desktop: already declared"], lines);
    }

    [Fact]
    public void NoClientFoundIsSaid()
    {
        var (code, lines) = Register(null, pack: true);
        Assert.Equal(0, code);
        Assert.Equal("No AI client found (Claude, Codex, Antigravity): install one, then run the installer again.", lines[0]);
        Assert.Equal("NEXUS_PACK_RESULT Claude Code=absent; Codex=absent; Antigravity=absent", lines[^1]);
    }

    [Fact]
    public void UpdateOnlyDoesNotInstallRoutesOrBypassDisabledPlugins()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(CodexConfig)!);
        File.WriteAllText(CodexConfig, "[plugins.\"nexus-browser@nexus-plugins\"]\nenabled = false\n");
        File.WriteAllText(ClaudeJson, "{}");
        string before = File.ReadAllText(CodexConfig);
        using var output = new StringWriter();
        Assert.Equal(0, ClientRegistration.Register(Context(), null, true, output, updateOnly: true));
        Assert.Equal(before, File.ReadAllText(CodexConfig));
        Assert.Equal("{}", File.ReadAllText(ClaudeJson));
        Assert.Empty(_runs);
        Assert.False(Directory.Exists(Path.Combine(Home, ".gemini")));
    }

    [Fact]
    public void UpdateOnlyRefreshesOnlyExactInstalledNativeEntries()
    {
        string old = Path.Combine(Local, "NexusBrowser", "versions", "0123456789abcdef", "NexusBrowser.exe");
        string next = Path.Combine(Local, "NexusBrowser", "versions", "fedcba9876543210", "NexusBrowser.exe");
        File.WriteAllText(ClaudeJson, new JsonObject { ["mcpServers"] = new JsonObject { ["nexus-browser"] = Entry("Claude", old) } }.ToJsonString());
        Directory.CreateDirectory(Path.GetDirectoryName(CodexConfig)!);
        File.WriteAllText(CodexConfig, CodexBlock(old));
        using var output = new StringWriter();
        Assert.Equal(0, ClientRegistration.Register(Context(next), "claude-code,codex", true, output, updateOnly: true));
        Assert.Equal(next, (string?)ReadJson(ClaudeJson)!["mcpServers"]!["nexus-browser"]!["command"]);
        Assert.Equal(CodexBlock(next), File.ReadAllText(CodexConfig));

        var custom = Entry("Claude", old); custom["args"]!.AsArray().Add("--custom");
        File.WriteAllText(ClaudeJson, new JsonObject { ["mcpServers"] = new JsonObject { ["nexus-browser"] = custom } }.ToJsonString());
        string before = File.ReadAllText(ClaudeJson);
        Assert.Equal(0, ClientRegistration.Register(Context(next), "claude-code", true, output, updateOnly: true));
        Assert.Equal(before, File.ReadAllText(ClaudeJson));
    }

    [Fact]
    public void UpdateOnlyPreservesAnActiveAntigravityDaemonRouteAndDisabledPluginChoice()
    {
        string folder = Path.Combine(Home, ".gemini", "config"), plugin = Path.Combine(folder, "plugins", "nexus-browser");
        Directory.CreateDirectory(plugin);
        File.WriteAllText(Path.Combine(plugin, "plugin.json"), "{\"version\":\"old\"}");
        string config = Path.Combine(plugin, "mcp_config.json");
        File.WriteAllText(config, "{\"mcpServers\":{\"nexus-browser\":{\"serverUrl\":\"http://127.0.0.1:16182/mcp?agent=antigravity\",\"headers\":{\"Authorization\":\"Bearer ${NEXUS_MCP_TOKEN}\"}}}}");
        string before = File.ReadAllText(config);
        using var output = new StringWriter();
        Assert.Equal(0, ClientRegistration.Register(Context(), "antigravity", true, output, updateOnly: true));
        Assert.Equal(before, File.ReadAllText(config));
        Assert.True(File.Exists(Path.Combine(plugin, "skills", "nexus-browser", "SKILL.md")));
        File.WriteAllText(Path.Combine(folder, "config.json"), "{\"plugins\":{\"nexus-browser\":{\"enabled\":false}}}");
        File.WriteAllText(Path.Combine(plugin, "plugin.json"), "{\"version\":\"do-not-change\"}");
        Assert.Equal(0, ClientRegistration.Register(Context(), "antigravity", true, output, updateOnly: true));
        Assert.Equal("do-not-change", (string?)ReadJson(Path.Combine(plugin, "plugin.json"))!["version"]);
        File.WriteAllText(Path.Combine(folder, "config.json"), "{\"plugins\":{\"nexus-browser\":false}}");
        Assert.Equal(0, ClientRegistration.Register(Context(), "antigravity", true, output, updateOnly: true));
        Assert.Equal("do-not-change", (string?)ReadJson(Path.Combine(plugin, "plugin.json"))!["version"]);
    }

    [Fact]
    public void UnreadableJsonFailsThatClientOnlyAndLeavesTheFileUntouched()
    {
        File.WriteAllText(ClaudeJson, "{not json");
        Directory.CreateDirectory(Path.GetDirectoryName(CodexConfig)!);
        var (code, lines) = Register(null, pack: true);
        Assert.Equal(1, code);
        Assert.StartsWith("Claude Code: failed: ", lines[0]);
        Assert.StartsWith("Codex: declared", lines[1]);
        Assert.Equal("{not json", File.ReadAllText(ClaudeJson));
        Assert.Equal("NEXUS_PACK_RESULT Claude Code=failed; Codex=declared; Antigravity=absent", lines[^1]);
    }
}
