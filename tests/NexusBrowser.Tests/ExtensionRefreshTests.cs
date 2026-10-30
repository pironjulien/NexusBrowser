using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using NexusBrowser.Native;
using Xunit;

namespace NexusBrowser.Tests;

/// <summary>--refresh-extension: installation defers while agent tabs are live and never acts on a user tab
/// (mirrors tests/test_extension_refresh.py against native/ExtensionRefresh.cs).</summary>
public sealed class ExtensionRefreshTests
{
    private static readonly (string Version, string[] Features) Expected = ExtensionRefresh.Expected();
    private static readonly Func<TimeSpan, CancellationToken, Task> NoDelay = (_, _) => Task.CompletedTask;

    private static JsonObject Ping(string version, IEnumerable<string> features) =>
        new() { ["version"] = version, ["features"] = new JsonArray(features.Select(f => (JsonNode?)f).ToArray()) };

    private static JsonObject CurrentPing => Ping(Expected.Version, Expected.Features);

    private sealed class Bridge(Func<string, List<string>, JsonNode?> answer)
    {
        public List<string> Calls { get; } = [];

        public Task<JsonNode?> Call(string action, double timeout, CancellationToken ct)
        {
            Calls.Add(action);
            return Task.FromResult(answer(action, Calls));
        }
    }

    private static Task<(int Code, JsonObject Report)> Run(Bridge bridge, bool checkOnly = false, double waitReady = 0) =>
        ExtensionRefresh.RunAsync(bridge.Call, checkOnly, waitReady, Expected.Version, Expected.Features, NoDelay, TestContext.Current.CancellationToken);

    [Fact]
    public async Task LiveAgentTabsPreventEveryRefresh()
    {
        var bridge = new Bridge((action, _) => action == "ping" ? Ping("old", []) : new JsonArray(new JsonObject { ["owner"] = "Claude" }));
        var (code, report) = await Run(bridge);
        Assert.Equal(ExtensionRefresh.Busy, code);
        Assert.Equal(3, code);
        Assert.Equal(["ping", "list-tabs"], bridge.Calls);
        Assert.True((bool)report["busy"]!);
        Assert.False((bool)report["verified"]!);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CurrentExtensionWithUserTabsIsOnlyRead(bool checkOnly)
    {
        var bridge = new Bridge((action, _) => action == "ping" ? CurrentPing : new JsonArray(new JsonObject { ["owner"] = null }, new JsonObject { ["owner"] = "" }));
        var (code, report) = await Run(bridge, checkOnly);
        Assert.Equal(ExtensionRefresh.Current, code);
        Assert.Equal(["ping", "list-tabs"], bridge.Calls);
        Assert.True((bool)report["verified"]!);
        Assert.False((bool)report["reloaded"]!);
    }

    [Fact]
    public async Task FeatureOrderDoesNotMatter()
    {
        var bridge = new Bridge((action, _) => action == "ping" ? Ping(Expected.Version, Expected.Features.Reverse()) : new JsonArray());
        Assert.Equal(ExtensionRefresh.Current, (await Run(bridge, checkOnly: true)).Code);
    }

    [Fact]
    public async Task StaleExtensionInCheckOnlyIsReportedWithoutReload()
    {
        var bridge = new Bridge((action, _) => action == "ping" ? Ping(Expected.Version, Expected.Features.Skip(1)) : new JsonArray());
        var (code, report) = await Run(bridge, checkOnly: true);
        Assert.Equal(ExtensionRefresh.Stale, code);
        Assert.Equal(1, code);
        Assert.Equal(["ping", "list-tabs"], bridge.Calls);
        Assert.True((bool)report["stale"]!);
    }

    [Fact]
    public async Task StaleExtensionReloadIsRechecked()
    {
        var bridge = new Bridge((action, calls) => action switch
        {
            "list-tabs" => new JsonArray(new JsonObject { ["owner"] = null }),
            "ping" => calls.Contains("reload_extension") ? CurrentPing : Ping("old", []),
            _ => new JsonObject { ["reloading"] = true },
        });
        var (code, report) = await Run(bridge);
        Assert.Equal(ExtensionRefresh.Current, code);
        Assert.Equal(["ping", "list-tabs", "reload_extension", "ping"], bridge.Calls);
        Assert.True((bool)report["reloaded"]!);
        Assert.True((bool)report["verified"]!);
    }

    [Fact]
    public async Task ReloadThatIsNotBackYetIsRetried()
    {
        int pingsAfterReload = 0;
        var bridge = new Bridge((action, calls) =>
        {
            if (action == "list-tabs") return new JsonArray();
            if (action == "ping" && calls.Contains("reload_extension") && ++pingsAfterReload == 1)
                throw new InvalidOperationException("No Chrome browser extension connected to the NexusBrowser bridge.");
            return action == "ping" ? (calls.Contains("reload_extension") ? CurrentPing : Ping("old", [])) : new JsonObject();
        });
        var (code, _) = await Run(bridge);
        Assert.Equal(ExtensionRefresh.Current, code);
        Assert.Equal(["ping", "list-tabs", "reload_extension", "ping", "ping"], bridge.Calls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DisconnectedBridgeIsUnverified(bool checkOnly)
    {
        var bridge = new Bridge((_, _) => throw new IOException("disconnected"));
        var (code, report) = await Run(bridge, checkOnly);
        Assert.Equal(ExtensionRefresh.Disconnected, code);
        Assert.Equal(2, code);
        Assert.Equal(["ping"], bridge.Calls);
        Assert.False((bool)report["connected"]!);
    }

    [Fact]
    public async Task WaitReadyRetriesUntilTheBridgeAnswers()
    {
        var bridge = new Bridge((action, calls) =>
        {
            if (calls.Count == 1) throw new HttpRequestException("refused");
            return action == "ping" ? CurrentPing : new JsonArray();
        });
        var (code, _) = await Run(bridge, checkOnly: true, waitReady: 5);
        Assert.Equal(ExtensionRefresh.Current, code);
        Assert.Equal(["ping", "ping", "list-tabs"], bridge.Calls);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(31)]
    public async Task WaitReadyOutOfRangeIsRefused(double waitReady)
    {
        var bridge = new Bridge((_, _) => CurrentPing);
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => Run(bridge, waitReady: waitReady));
        Assert.Empty(bridge.Calls);
    }

    [Fact]
    public void FeaturesAreParsedSortedFromTheDeclaration()
    {
        const string source = "const X = 1;\nconst AGY_FEATURES = [\n  \"zeta\",\n  \"alpha\", \"Mid\"\n];\nconst Y = [\"other\"];";
        Assert.Equal(["Mid", "alpha", "zeta"], ExtensionRefresh.Features(source));
        Assert.Throws<InvalidDataException>(() => ExtensionRefresh.Features("const OTHER = [\"a\"];"));
    }

    [Fact]
    public void MatchesNeedsTheSameVersionAndFeatureSet()
    {
        Assert.True(ExtensionRefresh.Matches(Ping("1.0.0", ["b", "a"]), "1.0.0", ["a", "b"]));
        Assert.False(ExtensionRefresh.Matches(Ping("1.0.1", ["a", "b"]), "1.0.0", ["a", "b"]));
        Assert.False(ExtensionRefresh.Matches(Ping("1.0.0", ["a"]), "1.0.0", ["a", "b"]));
        Assert.False(ExtensionRefresh.Matches(new JsonArray(), "1.0.0", []));
        Assert.False(ExtensionRefresh.Matches(null, "1.0.0", []));
    }

    [Fact]
    public void ExpectedIsTheExtensionShippedInThisRepository()
    {
        string version = (string)JsonNode.Parse(File.ReadAllText(Repo.File("extension", "manifest.json")))!["version"]!;
        string background = File.ReadAllText(Repo.File("extension", "background.js"));
        var declared = Regex.Match(background, @"const AGY_FEATURES = \[(.*?)\];", RegexOptions.Singleline);
        Assert.True(declared.Success);
        var features = Regex.Matches(declared.Groups[1].Value, "\"([^\"]+)\"").Select(m => m.Groups[1].Value).Order(StringComparer.Ordinal).ToArray();
        Assert.Equal(version, Expected.Version);
        Assert.NotEmpty(Expected.Features);
        Assert.Equal(features, Expected.Features);
    }

    [Fact]
    public void InstallerIdentityIsTheOnlyOneTheExtensionLetsReload()
    {
        // reload_extension is reserved by the extension to the "Installer" agent: the name used by the native refresh
        // must be exactly that one, and accepted by the bridge identity check.
        var reserved = Regex.Match(File.ReadAllText(Repo.File("extension", "background.js")), "const INSTALLER_AGENT = \"([^\"]+)\";");
        Assert.True(reserved.Success);
        Assert.Equal(ExtensionRefresh.InstallerAgent, reserved.Groups[1].Value);
        Assert.NotNull(BridgeSecurity.CheckIdentity(ExtensionRefresh.InstallerAgent, "installer-0123456789ab"));
    }
}
