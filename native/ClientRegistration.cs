using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Tomlyn;
using Tomlyn.Model;
using Tomlyn.Serialization;

namespace NexusBrowser.Native;

[TomlSerializable(typeof(TomlTable))]
internal partial class BrowserTomlContext : TomlSerializerContext { }

/// <summary>
/// Declares the nexus-browser MCP server to the AI clients found on this PC (--register, public install by get.ps1).
/// Claude Code (CLI or ~/.claude.json), Claude Desktop and Codex (~/.codex/config.toml): one stdio entry each, this
/// executable with --mcp, the client's name as NEXUS_BROWSER_AGENT (its tab group). Antigravity: a nexus-browser plugin
/// (plugin/: its manifest, logo and skill, plus that stdio server), never an entry in its global mcp_config.json. An entry of
/// ours (this engine, or the former Python server mcp_server.py) is replaced in place; an entry the user wrote
/// differently, or a nexus-browser plugin providing another server, is left alone. Each file is written atomically after
/// a backup. Prints one line per client, and with NEXUS_PACK=1 a last "NEXUS_PACK_RESULT ..." line for the Nexus pack.
/// NEXUS_PACK_TARGETS (the pack's -Only / -Skip): only these AI apps are configured.
/// </summary>
public static partial class ClientRegistration
{
    public const string Name = "nexus-browser";
    public const string Plugin = "provided by the nexus-browser plugin";
    public const string Removed = Plugin + " (the installer's own entry removed)";
    public const string Mcpb = "provided by the nexus-browser extension of Claude Desktop (.mcpb)";
    public const string Skipped = "skipped (not in the Nexus pack's list)";

    public static readonly IReadOnlyDictionary<string, string> PackAis = new Dictionary<string, string>
    {
        ["claude-code"] = "Claude Code",
        ["claude-desktop"] = "Claude Desktop",
        ["codex"] = "Codex",
        ["antigravity"] = "Antigravity",
    };

    private static readonly JsonSerializerOptions Indented = new()
    {
        WriteIndented = true,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    /// <summary>Everything the registration reads from the machine, replaceable by tests.</summary>
    public sealed record Context(
        string Home, string RoamingAppData, string LocalAppData, string Exe, string Backups, string SourceRoot,
        Func<string, string?> Which, Func<string, string[], (int Code, string Output)> Run, Func<bool> AntigravityRunning);

    public static HashSet<string>? PackScope(string? value)
    {
        if (value is null) return null;
        var names = Regex.Split(value, @"[,\s]+").Select(n => n.Trim().ToLowerInvariant()).Where(n => n.Length > 0).ToHashSet();
        var unknown = names.Where(n => !PackAis.ContainsKey(n)).Order(StringComparer.Ordinal).ToList();
        if (unknown.Count > 0) throw new ArgumentException($"unknown AI app in NEXUS_PACK_TARGETS: {string.Join(", ", unknown)}");
        return names.Select(n => PackAis[n]).ToHashSet();
    }

    public static JsonObject Entry(string exe, string agent) => new()
    {
        ["command"] = exe,
        ["args"] = new JsonArray("--mcp"),
        ["env"] = new JsonObject { ["NEXUS_BROWSER_AGENT"] = agent },
    };

    /// <summary>An entry written by an installer of NexusBrowser (native engine or former Python server), or none.</summary>
    public static bool Ours(JsonNode? existing)
    {
        if (existing is null) return true;
        if (existing is not JsonObject o) return false;
        string command = o["command"]?.ToString() ?? "";
        if (Path.GetFileName(command).Equals("NexusBrowser.exe", StringComparison.OrdinalIgnoreCase)) return true;
        return (o["args"] as JsonArray ?? []).Any(a => (a?.ToString() ?? "").Replace('\\', '/').EndsWith("client/mcp_server.py", StringComparison.OrdinalIgnoreCase));
    }

    private static JsonObject ReadJson(string path)
    {
        if (!File.Exists(path) || new FileInfo(path).Length == 0) return new JsonObject();
        return JsonNode.Parse(File.ReadAllText(path, Encoding.UTF8).TrimStart('﻿')) as JsonObject
            ?? throw new InvalidDataException($"{path} is not a JSON object");
    }

    private static void Backup(string path, string backups)
    {
        if (!File.Exists(path)) return;
        Directory.CreateDirectory(backups);
        string parent = Path.GetFileName(Path.GetDirectoryName(path)) ?? "";
        File.Copy(path, Path.Join(backups, $"{parent}-{Path.GetFileName(path)}-{DateTime.Now:yyyyMMdd-HHmmss}"), overwrite: true);
    }

    public static void WriteAtomic(string path, string text)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        string temporary = path + ".nexus-tmp";
        File.WriteAllText(temporary, text.Replace("\r\n", "\n"), new UTF8Encoding(false));
        File.Move(temporary, path, overwrite: true);
    }

    private static string Json(JsonNode node) => node.ToJsonString(Indented).Replace("\r\n", "\n") + "\n";

    public static string SetJsonServer(string path, JsonObject value, string backups)
    {
        var data = ReadJson(path);
        if (data["mcpServers"] is not JsonObject servers) data["mcpServers"] = servers = new JsonObject();
        var current = servers[Name];
        if (!Ours(current)) return "kept (an entry of yours already exists)";
        if (current is not null && JsonNode.DeepEquals(current, value)) return "already declared";
        Backup(path, backups);
        servers[Name] = value.DeepClone();
        WriteAtomic(path, Json(data));
        return $"declared in {path}";
    }

    public static bool RemoveJsonServer(string path, string backups)
    {
        if (!File.Exists(path) || new FileInfo(path).Length == 0) return false;
        var data = ReadJson(path);
        if (data["mcpServers"] is not JsonObject servers || servers[Name] is not { } current || !Ours(current)) return false;
        Backup(path, backups);
        servers.Remove(Name);
        WriteAtomic(path, Json(data));
        return true;
    }

    public static bool ClaudePluginEnabled(string home)
    {
        try
        {
            if (ReadJson(Path.Join(home, ".claude", "settings.json"))["enabledPlugins"] is not JsonObject enabled) return false;
            return enabled.Any(p => p.Key.Split('@')[0] == Name && p.Value is JsonValue v && v.TryGetValue<bool>(out bool on) && on);
        }
        catch (Exception ex) when (ex is IOException or JsonException or InvalidDataException) { return false; }
    }

    public static string? ClaudeCode(Context c)
    {
        string? cli = c.Which("claude");
        string config = Path.Join(c.Home, ".claude.json");
        JsonNode? Current() => File.Exists(config) ? (ReadJson(config)["mcpServers"] as JsonObject)?[Name] : null;
        if (ClaudePluginEnabled(c.Home))
        {
            if (cli is not null && File.Exists(config))
            {
                var current = Current();
                if (current is not null && Ours(current))
                {
                    c.Run(cli, ["mcp", "remove", Name, "--scope", "user"]);
                    return Removed;
                }
                return Plugin;
            }
            return RemoveJsonServer(config, c.Backups) ? Removed : Plugin;
        }
        if (cli is not null)
        {
            if (!Ours(Current())) return "kept (an entry of yours already exists)";
            c.Run(cli, ["mcp", "remove", Name, "--scope", "user"]);
            var (code, output) = c.Run(cli, ["mcp", "add", Name, "--scope", "user", "-e", "NEXUS_BROWSER_AGENT=Claude", "--", c.Exe, "--mcp"]);
            return code != 0 ? $"failed: {output.Trim()}" : "declared (claude mcp add, user scope)";
        }
        if (File.Exists(config))
        {
            var value = new JsonObject { ["type"] = "stdio" };
            foreach (var p in Entry(c.Exe, "Claude")) value[p.Key] = p.Value?.DeepClone();
            return SetJsonServer(config, value, c.Backups);
        }
        return null;
    }

    public static bool McpbInstalled(string folder)
    {
        string extensions = Path.Join(folder, "Claude Extensions");
        if (!Directory.Exists(extensions)) return false;
        foreach (string manifest in Directory.EnumerateDirectories(extensions).Select(d => Path.Join(d, "manifest.json")).Where(File.Exists))
        {
            try { if (ReadJson(manifest)["name"]?.ToString() == Name) return true; }
            catch (Exception ex) when (ex is IOException or JsonException or InvalidDataException) { /* unreadable manifest: not ours */ }
        }
        return false;
    }

    public static List<string> ClaudeDesktop(Context c)
    {
        // Classic install; the Store (MSIX) one, whose AppData is redirected into its package; and the Store one that
        // reads %LOCALAPPDATA%\Claude-Data\<package>. A folder it left (.user-data-left.*) is skipped.
        var folders = new List<string> { Path.Join(c.RoamingAppData, "Claude") };
        string packages = Path.Join(c.LocalAppData, "Packages");
        if (Directory.Exists(packages))
            folders.AddRange(Directory.EnumerateDirectories(packages, "*Claude_*").Order(StringComparer.Ordinal)
                .Select(p => Path.Join(p, "LocalCache", "Roaming", "Claude")));
        string data = Path.Join(c.LocalAppData, "Claude-Data");
        if (Directory.Exists(data)) folders.AddRange(Directory.EnumerateDirectories(data).Order(StringComparer.Ordinal));
        var results = new List<string>();
        foreach (string folder in folders.Where(folder => Directory.Exists(folder) && !Directory.EnumerateFileSystemEntries(folder, ".user-data-left.*").Any()))
        {
            string config = Path.Join(folder, "claude_desktop_config.json");
            if (McpbInstalled(folder))
                results.Add(Mcpb + (RemoveJsonServer(config, c.Backups) ? " (the installer's own entry removed)" : ""));
            else
                results.Add(SetJsonServer(config, Entry(c.Exe, "Claude"), c.Backups));
        }
        return results;
    }

    [GeneratedRegex(@"^[ \t]*\[(?<name>[^\]\r\n]+)\][ \t]*(?:#[^\r\n]*)?\r?$", RegexOptions.Multiline)]
    private static partial Regex TomlTable();

    private static string TomlString(string text) => JsonSerializer.Serialize(text); // a JSON string is a TOML basic string

    /// <summary>Our own tables ([mcp_servers.nexus-browser] and its subtables), each up to the next table.</summary>
    public static (string Without, string? Ours) CutTomlTables(string text)
    {
        var kept = new StringBuilder();
        var ours = new StringBuilder();
        bool dropping = false;
        int position = 0;
        foreach (Match match in TomlTable().Matches(text))
        {
            (dropping ? ours : kept).Append(text, position, match.Index - position);
            string name = match.Groups["name"].Value.Trim();
            dropping = name == $"mcp_servers.{Name}" || name.StartsWith($"mcp_servers.{Name}.", StringComparison.Ordinal);
            position = match.Index;
        }
        (dropping ? ours : kept).Append(text, position, text.Length - position);
        return (kept.ToString(), ours.Length > 0 ? ours.ToString() : null);
    }

    public static string CodexBlock(string exe) =>
        $"[mcp_servers.{Name}]\ncommand = {TomlString(exe)}\nargs = [\"--mcp\"]\n\n[mcp_servers.{Name}.env]\nNEXUS_BROWSER_AGENT = \"Codex\"\n";

    private static TomlTable ReadCodexToml(string text) =>
        TomlSerializer.Deserialize(text, BrowserTomlContext.Default.TomlTable) ?? new TomlTable();

    private static bool CodexPluginConfigured(TomlTable data) =>
        data.TryGetValue("plugins", out object? plugins) && plugins is TomlTable configured &&
        configured.Any(plugin => plugin.Key.Split('@')[0] == Name);

    private static bool SameToml(object? left, object? right)
    {
        if (left is TomlTable a && right is TomlTable b)
            return a.Count == b.Count && a.All(item => b.TryGetValue(item.Key, out object? other) && SameToml(item.Value, other));
        if (left is not string && right is not string && left is System.Collections.IEnumerable x && right is System.Collections.IEnumerable y)
        {
            var aValues = x.Cast<object?>().ToList();
            var bValues = y.Cast<object?>().ToList();
            return aValues.Count == bValues.Count && aValues.Zip(bValues).All(pair => SameToml(pair.First, pair.Second));
        }
        return Equals(left, right);
    }

    private static bool CodexEditPreservesOtherSettings(TomlTable before, string next, string? exe)
    {
        var after = ReadCodexToml(next);
        if (!before.TryGetValue("mcp_servers", out object? current) || current is not TomlTable servers)
            before["mcp_servers"] = servers = new TomlTable();
        if (exe is null)
        {
            servers.Remove(Name);
            if (servers.Count == 0 && !after.ContainsKey("mcp_servers")) before.Remove("mcp_servers");
        }
        else servers[Name] = ((TomlTable)ReadCodexToml(CodexBlock(exe))["mcp_servers"]!)[Name];
        return SameToml(before, after);
    }

    private static bool CodexInstallerBlock(string block, string localAppData)
    {
        // Exact signature of our native declaration; never remove a customized server just because its executable
        // happens to have the same basename. The versioned executable path itself can change on each upgrade.
        var command = Regex.Match(block, "(?m)^command = (\"(?:[^\"\\\\]|\\\\.)*\")\\s*$");
        if (!command.Success) return false;
        try
        {
            string path = JsonSerializer.Deserialize<string>(command.Groups[1].Value)!;
            string relative = Path.GetRelativePath(Path.Join(localAppData, "NexusBrowser"), Path.GetFullPath(path)).Replace('\\', '/');
            bool installed = Regex.IsMatch(relative, @"^versions/[0-9a-f]{16}/NexusBrowser\.exe$", RegexOptions.IgnoreCase) ||
                relative.Equals("app/engine/NexusBrowser.exe", StringComparison.OrdinalIgnoreCase) ||
                relative.Equals("native/NexusBrowser.exe", StringComparison.OrdinalIgnoreCase);
            return installed &&
                block.TrimEnd('\n') + "\n" == CodexBlock(path);
        }
        catch (JsonException) { return false; }
    }

    public static string? Codex(Context c)
    {
        string folder = Path.Join(c.Home, ".codex");
        if (!Directory.Exists(folder) && c.Which("codex") is null) return null;
        string config = Path.Join(folder, "config.toml");
        string text = File.Exists(config) ? File.ReadAllText(config, Encoding.UTF8).TrimStart('﻿').Replace("\r\n", "\n") : "";
        TomlTable data;
        try { data = ReadCodexToml(text); }
        catch (Exception ex) when (ex is not OutOfMemoryException) { return "failed: " + config + " is not valid TOML: left untouched"; }
        var (without, ours) = CutTomlTables(text);
        if (CodexPluginConfigured(data))
        {
            // A configured disabled plugin is an intentional choice too: never bypass it by adding a direct server.
            if (ours is null) return Plugin;
            if (!CodexInstallerBlock(ours, c.LocalAppData)) return "kept (custom entry and configured plugin)";
            if (!CodexEditPreservesOtherSettings(data, without, null)) return "kept (ambiguous TOML edit)";
            Backup(config, c.Backups);
            WriteAtomic(config, without);
            return Removed;
        }
        // Also a dotted or inline form ("mcp_servers.nexus-browser = {...}" or a key inside [mcp_servers]): not edited.
        if (Regex.IsMatch(without, $@"(?m)^\s*(mcp_servers\.)?""?{Regex.Escape(Name)}""?\s*[.=]"))
            return "kept (entry written in a form this installer does not edit)";
        if (ours is not null)
        {
            bool mine = ours.Contains("NexusBrowser.exe", StringComparison.OrdinalIgnoreCase) ||
                ours.Replace("\\\\", "/").Replace('\\', '/').Contains("client/mcp_server.py", StringComparison.OrdinalIgnoreCase);
            if (!mine) return "kept (an entry of yours already exists)";
            if (ours.TrimEnd('\n') + "\n" == CodexBlock(c.Exe)) return "already declared";
        }
        string next = without.TrimEnd('\n') + (without.Trim().Length > 0 ? "\n\n" : "") + CodexBlock(c.Exe);
        if (!CodexEditPreservesOtherSettings(data, next, c.Exe)) return "kept (ambiguous TOML edit)";
        Backup(config, c.Backups);
        WriteAtomic(config, next);
        return $"declared in {config}";
    }

    public static string? Antigravity(Context c)
    {
        // Antigravity has used both folders; the one that exists is the one it reads.
        foreach (string folder in new[] { Path.Join(c.Home, ".gemini", "config"), Path.Join(c.Home, ".gemini", "antigravity") }.Where(Directory.Exists))
        {
            string plugin = Path.Join(folder, "plugins", Name);
            string pluginConfig = Path.Join(plugin, "mcp_config.json");
            if (File.Exists(pluginConfig))
            {
                var current = (ReadJson(pluginConfig)["mcpServers"] as JsonObject)?[Name];
                if (current is not null && !Ours(current)) // a plugin of the user's own (e.g. the shared daemon)
                    return RemoveJsonServer(Path.Join(folder, "mcp_config.json"), c.Backups) ? Removed : Plugin;
            }
            string source = Path.Join(c.SourceRoot, "plugin");
            var manifest = ReadJson(Path.Join(source, "plugin.json"));
            WriteAtomic(Path.Join(plugin, "plugin.json"), Json(manifest));
            string logo = manifest["logo"]?.ToString() ?? "logo.png";
            File.Copy(Path.Combine(source, logo), Path.Combine(plugin, logo), overwrite: true);
            WriteAtomic(pluginConfig, Json(new JsonObject { ["mcpServers"] = new JsonObject { [Name] = Entry(c.Exe, "Antigravity") } }));
            WriteAtomic(Path.Join(plugin, "skills", Name, "SKILL.md"), File.ReadAllText(Path.Join(source, "skills", Name, "SKILL.md"), Encoding.UTF8));
            RemoveJsonServer(Path.Join(folder, "mcp_config.json"), c.Backups); // global entry of an earlier version
            string app = Path.Join(folder, "config.json");
            if (File.Exists(app) && !c.AntigravityRunning())
            {
                var data = ReadJson(app);
                if (data["plugins"] is not JsonObject plugins) data["plugins"] = plugins = new JsonObject();
                if (plugins[Name]?["enabled"] is not JsonValue on || !on.TryGetValue<bool>(out bool enabled) || !enabled)
                {
                    Backup(app, c.Backups);
                    plugins[Name] = new JsonObject { ["enabled"] = true };
                    WriteAtomic(app, Json(data));
                }
                return $"plugin installed and enabled in {plugin}";
            }
            return $"plugin installed in {plugin} (enable nexus-browser in Antigravity's plugins if it is not)";
        }
        return null;
    }

    /// <summary>One word per client for the Nexus pack's summary line.</summary>
    public static string Short(string? result)
    {
        if (result is null) return "absent";
        foreach (var (prefix, word) in new[] { ("skipped", "skipped"), ("failed", "failed"), ("kept", "kept"), ("provided by", "plugin"), ("plugin", "plugin") })
            if (result.StartsWith(prefix, StringComparison.Ordinal)) return word;
        return "declared";
    }

    public static int Register(Context c, string? packTargets, bool pack, TextWriter output, bool updateOnly = false)
    {
        HashSet<string>? scope;
        try { scope = PackScope(packTargets); }
        catch (ArgumentException error) { output.WriteLine(error.Message); return 2; }
        var results = new List<(string Client, string? Result)>();
        foreach (var (client, declare) in new (string, Func<Context, string?>)[] { ("Claude Code", ClaudeCode), ("Codex", Codex), ("Antigravity", Antigravity) })
        {
            if (scope is not null && !scope.Contains(client)) { results.Add((client, Skipped)); continue; }
            try { results.Add((client, updateOnly ? UpdateExisting(c, client) : declare(c))); }
            catch (Exception error) when (error is IOException or JsonException or InvalidDataException or UnauthorizedAccessException)
            { results.Add((client, $"failed: {error.Message}")); }
        }
        try
        {
            if (scope is not null && !scope.Contains("Claude Desktop")) results.Add(("Claude Desktop", Skipped));
            else
            {
                var desktops = updateOnly ? UpdateExistingDesktops(c) : ClaudeDesktop(c);
                for (int i = 0; i < desktops.Count; i++) results.Add(("Claude Desktop" + (i > 0 ? $" ({i + 1})" : ""), desktops[i]));
            }
        }
        catch (Exception error) when (error is IOException or JsonException or InvalidDataException or UnauthorizedAccessException)
        { results.Add(("Claude Desktop", $"failed: {error.Message}")); }
        bool found = false;
        foreach (var (client, result) in results.Where(r => r.Result is not null))
        {
            found = true;
            output.WriteLine($"{client}: {result}");
        }
        if (!found) output.WriteLine("No AI client found (Claude, Codex, Antigravity): install one, then run the installer again.");
        if (pack) output.WriteLine("NEXUS_PACK_RESULT " + string.Join("; ", results.Select(r => $"{r.Client}={Short(r.Result)}")));
        return results.Any(r => r.Result?.StartsWith("failed", StringComparison.Ordinal) == true) ? 1 : 0;
    }

    private static string? Which(string name)
    {
        foreach (string dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
            foreach (string candidate in new[] { ".exe", ".cmd", ".bat", "" }.Select(ext => Path.Join(dir.Trim('"'), name + ext)))
            {
                if (File.Exists(candidate)) return candidate;
            }
        return null;
    }

    private static (int, string) RunProcess(string file, string[] args)
    {
        // npm shims (claude.cmd) need cmd.exe; arguments stay a list.
        var info = file.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase) || file.EndsWith(".bat", StringComparison.OrdinalIgnoreCase)
            ? new ProcessStartInfo("cmd.exe") { ArgumentList = { "/d", "/c", file } }
            : new ProcessStartInfo(file);
        foreach (string a in args) info.ArgumentList.Add(a);
        info.UseShellExecute = false; info.CreateNoWindow = true; info.RedirectStandardOutput = true; info.RedirectStandardError = true;
        using var process = Process.Start(info) ?? throw new IOException($"{file} not started");
        var stdout = process.StandardOutput.ReadToEndAsync();
        string stderr = process.StandardError.ReadToEnd();
        if (!process.WaitForExit(60_000)) { process.Kill(entireProcessTree: true); return (1, "timed out"); }
        return (process.ExitCode, stderr.Length > 0 ? stderr : stdout.Result);
    }

    public static int Run(string? backups, string? engineExe = null, string? sourceRoot = null, bool updateOnly = false)
    {
        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        string exe = engineExe ?? Environment.ProcessPath ?? throw new InvalidOperationException("executable path unknown");
        // Plugin and skill files: next to the executable's install (installation.json) or the source checkout.
        string source = sourceRoot ?? BridgeServer.InstalledSourceRoot() ?? AppContext.BaseDirectory;
        var context = new Context(home,
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            exe, backups ?? Path.Join(BridgeSecurity.DefaultDataDir(), "backups"), source,
            Which, RunProcess, () => Process.GetProcessesByName("Antigravity").Length > 0);
        Console.OutputEncoding = new UTF8Encoding(false);
        return Register(context, Environment.GetEnvironmentVariable("NEXUS_PACK_TARGETS"), Environment.GetEnvironmentVariable("NEXUS_PACK") == "1", Console.Out, updateOnly);
    }
}
