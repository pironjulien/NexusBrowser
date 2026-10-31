using System.Globalization;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace NexusBrowser.Native;

/// <summary>
/// Installer-only check of the Chrome extension behind the local bridge (--refresh-extension). No user tab is driven or
/// activated. Exit codes: 0 the loaded extension matches this build (reloaded if needed), 1 stale or reload unconfirmed
/// (--check-only: stale), 2 no bridge or no extension connected, 3 an agent drives tabs (nothing is touched).
/// </summary>
public static partial class ExtensionRefresh
{
    public const int Current = 0, Stale = 1, Disconnected = 2, Busy = 3;
    // The extension lets only this agent name reload it (reload_extension).
    public const string InstallerAgent = "Installer";
    // ID that the public "key" of extension/manifest.json gives the extension loaded from its folder ("Load unpacked");
    // the Chrome Web Store signs its copy with another key, so this ID is never a store installation.
    public const string UnpackedExtensionId = "blcgddmjdkobmgakjffjpgiicjlflgjf";

    /// <summary>
    /// Installation type of an extension older than its installation metadata (before 2.33.5), from the extension ID
    /// the bridge authenticated: the unpacked ID is a development folder that a reload updates; any other stays unknown.
    /// Without it, such an extension was deferred on every update and never caught up.
    /// </summary>
    public static string LegacyInstallationType(string? extensionId) =>
        extensionId == UnpackedExtensionId ? "development" : "unknown";

    [GeneratedRegex(@"const AGY_FEATURES = \[(.*?)\];", RegexOptions.Singleline)]
    private static partial Regex FeatureDeclaration();

    [GeneratedRegex("\"([^\"]+)\"")]
    private static partial Regex Quoted();

    /// <summary>Version and features of the extension shipped with this build (embedded from extension/).</summary>
    public static (string Version, string[] Features) Expected()
    {
        string manifest = Embedded("extension-manifest.json");
        string version = JsonNode.Parse(manifest)?["version"]?.GetValue<string>() ?? throw new InvalidDataException("extension version missing");
        return (version, Features(Embedded("extension-background.js")));
    }

    public static string[] Features(string backgroundSource)
    {
        var declared = FeatureDeclaration().Match(backgroundSource);
        if (!declared.Success) throw new InvalidDataException("Missing source feature declaration");
        return Quoted().Matches(declared.Groups[1].Value).Select(m => m.Groups[1].Value).Order(StringComparer.Ordinal).ToArray();
    }

    private static string Embedded(string name)
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name)
            ?? throw new InvalidOperationException($"Embedded resource {name} not found");
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return reader.ReadToEnd();
    }

    public static bool Matches([System.Diagnostics.CodeAnalysis.NotNullWhen(true)] JsonNode? ping, string version, string[] features)
    {
        if (ping is not JsonObject o || o["version"]?.GetValue<string>() != version) return false;
        var loaded = (o["features"] as JsonArray ?? []).Select(f => f?.GetValue<string>() ?? "").Order(StringComparer.Ordinal);
        return loaded.SequenceEqual(features, StringComparer.Ordinal);
    }

    /// <summary>One bridge command as the installer; throws on any transport or bridge failure.</summary>
    public delegate Task<JsonNode?> BridgeCall(string action, double timeout, CancellationToken ct);

    public static BridgeCall HttpBridge(HttpClient http, int httpPort, string? tokenFile)
    {
        string client = "installer-" + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(6));
        return async (action, timeout, ct) =>
        {
            string token = BridgeSecurity.ReadToken(tokenFile);
            using var request = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{httpPort}/api/command")
            {
                Content = new StringContent(new JsonObject { ["action"] = action, ["params"] = new JsonObject(), ["timeout"] = timeout }.ToJsonString(), Encoding.UTF8, "application/json"),
            };
            request.Headers.TryAddWithoutValidation(BridgeSecurity.TokenHeader, token);
            request.Headers.TryAddWithoutValidation(BridgeSecurity.AgentHeader, InstallerAgent);
            request.Headers.TryAddWithoutValidation(BridgeSecurity.ClientHeader, client);
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct);
            limit.CancelAfter(TimeSpan.FromSeconds(timeout + 2));
            using var response = await http.SendAsync(request, limit.Token);
            var json = JsonNode.Parse(await response.Content.ReadAsStringAsync(limit.Token)) as JsonObject;
            if (!response.IsSuccessStatusCode || json?["success"]?.GetValue<bool>() != true)
                throw new InvalidOperationException(json?["error"]?.GetValue<string>() ?? $"HTTP {(int)response.StatusCode}");
            var data = json["data"]?.DeepClone();
            if (action == "ping" && data is JsonObject ping && ping["installation_type"] is null)
            {
                // Older extensions predate installation metadata; identify the authenticated target via the bridge.
                using var statusRequest = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{httpPort}/api/status");
                statusRequest.Headers.TryAddWithoutValidation(BridgeSecurity.TokenHeader, token);
                using var statusResponse = await http.SendAsync(statusRequest, limit.Token);
                if (statusResponse.IsSuccessStatusCode)
                {
                    var status = JsonNode.Parse(await statusResponse.Content.ReadAsStringAsync(limit.Token));
                    string? id = status?["target"]?["extension_id"]?.GetValue<string>();
                    ping["extension_id"] = id;
                    ping["installation_type"] = LegacyInstallationType(id);
                }
            }
            return data;
        };
    }

    public static async Task<(int Code, JsonObject Report)> RunAsync(BridgeCall call, bool checkOnly, double waitReady,
        string version, string[] features, Func<TimeSpan, CancellationToken, Task>? delay = null, CancellationToken ct = default)
    {
        if (waitReady is < 0 or > 30) throw new ArgumentOutOfRangeException(nameof(waitReady), "--wait-ready must be between 0 and 30 seconds");
        delay ??= Task.Delay;
        var clock = System.Diagnostics.Stopwatch.StartNew();
        JsonNode? ping, tabs;
        while (true)
        {
            try
            {
                ping = await call("ping", 3, ct);
                tabs = await call("list-tabs", 3, ct);
                break;
            }
            catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidOperationException or OperationCanceledException or System.Text.Json.JsonException && !ct.IsCancellationRequested)
            {
                if (clock.Elapsed.TotalSeconds >= waitReady)
                    return (Disconnected, new JsonObject { ["connected"] = false, ["verified"] = false });
                await delay(TimeSpan.FromMilliseconds(250), ct);
            }
        }
        if (Matches(ping, version, features))
            return (Current, new JsonObject { ["connected"] = true, ["verified"] = true, ["reloaded"] = false, ["version"] = version,
                ["installation_type"] = ping["installation_type"]?.DeepClone(), ["extension_id"] = ping["extension_id"]?.DeepClone() });
        if ((tabs as JsonArray ?? []).Any(t => t is JsonObject o && o["owner"] is JsonNode owner && owner.ToString().Length > 0))
            return (Busy, new JsonObject { ["connected"] = true, ["busy"] = true, ["verified"] = false });
        if (checkOnly)
            return (Stale, new JsonObject { ["connected"] = true, ["verified"] = false, ["stale"] = true, ["version"] = ping?["version"]?.DeepClone() });
        if (ping?["installation_type"]?.GetValue<string>() is not ("store" or "development"))
            return (Stale, new JsonObject { ["verified"] = false, ["deferred"] = true, ["reason"] = "extension-installation-type-unverified" });
        if (ping["installation_type"]?.GetValue<string>() == "store")
        {
            if (ping["update_check"]?.GetValue<bool>() != true)
                return (Stale, new JsonObject { ["verified"] = false, ["deferred"] = true, ["reason"] = "legacy-store-extension-awaiting-Chrome-update" });
            var update = await call("update_extension", 3, ct);
            if (update?["downloaded"]?.GetValue<bool>() != true)
                return (Stale, new JsonObject { ["verified"] = false, ["deferred"] = true, ["reason"] = "store-update-not-yet-available", ["store_status"] = update?["status"]?.DeepClone() });
        }
        await call("reload_extension", 3, ct);
        var reload = System.Diagnostics.Stopwatch.StartNew();
        while (reload.Elapsed.TotalSeconds < 10)
        {
            await delay(TimeSpan.FromMilliseconds(250), ct);
            try
            {
                if (Matches(await call("ping", 2, ct), version, features))
                    return (Current, new JsonObject { ["connected"] = true, ["verified"] = true, ["reloaded"] = true, ["version"] = version });
            }
            catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidOperationException or OperationCanceledException or System.Text.Json.JsonException && !ct.IsCancellationRequested)
            {
                // The bridge or the extension is not back yet: next try until the deadline.
            }
        }
        return (Stale, new JsonObject { ["connected"] = true, ["verified"] = false, ["error"] = "extension-refresh-unconfirmed" });
    }

    /// <summary>Command line: --refresh-extension [--check-only] [--wait-ready N] [--token-file F] [--port P].</summary>
    public static async Task<int> MainAsync(bool checkOnly, string? waitReady, string? tokenFile, int httpPort, string? sourceRoot = null)
    {
        double wait = 0;
        if (waitReady is not null && !double.TryParse(waitReady, NumberStyles.Float, CultureInfo.InvariantCulture, out wait))
            throw new ArgumentException("--wait-ready must be a number of seconds");
        var (version, features) = sourceRoot is null ? Expected() :
            (JsonNode.Parse(File.ReadAllText(Path.Join(sourceRoot, "extension", "manifest.json")))?["version"]?.GetValue<string>() ?? throw new InvalidDataException("Payload extension version missing"),
             Features(File.ReadAllText(Path.Join(sourceRoot, "extension", "background.js"))));
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        var (code, report) = await RunAsync(HttpBridge(http, httpPort, tokenFile), checkOnly, wait, version, features);
        Console.WriteLine(report.ToJsonString());
        return code;
    }
}
