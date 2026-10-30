using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace NexusBrowser.Native;

public static partial class ClientRegistration
{
    // Maintenance never treats a missing entry, a matching executable basename, or a disabled plugin as consent.
    private static bool InstalledEntry(Context c, JsonNode? existing, string agent)
    {
        if (existing is not JsonObject current || current["enabled"]?.ToString() == "false" ||
            current["disabled"]?.ToString() == "true" || current["command"] is not JsonValue command) return false;
        string path = command.ToString();
        string relative = Path.GetRelativePath(Path.Combine(c.LocalAppData, "NexusBrowser"), Path.GetFullPath(path)).Replace('\\', '/');
        if (!Regex.IsMatch(relative, @"^(versions/[0-9a-f]{16}|app/engine|native)/NexusBrowser\.exe$", RegexOptions.IgnoreCase)) return false;
        var copy = current.DeepClone().AsObject();
        if (copy["type"]?.ToString() == "stdio") copy.Remove("type");
        return JsonNode.DeepEquals(copy, Entry(path, agent));
    }

    private static string UpdateJsonExisting(Context c, string path, string agent)
    {
        if (!File.Exists(path)) return "kept (not installed)";
        var current = (ReadJson(path)["mcpServers"] as JsonObject)?[Name];
        if (!InstalledEntry(c, current, agent)) return "kept (absent, disabled or custom route)";
        var next = Entry(c.Exe, agent);
        if (current?["type"]?.ToString() == "stdio") next["type"] = "stdio";
        return SetJsonServer(path, next, c.Backups);
    }

    private static string UpdateExisting(Context c, string client)
    {
        if (client == "Claude Code")
        {
            var settings = ReadJson(Path.Combine(c.Home, ".claude", "settings.json"));
            if (settings["enabledPlugins"] is JsonObject plugins && plugins.Any(p => p.Key.Split('@')[0] == Name)) return Plugin;
            return UpdateJsonExisting(c, Path.Combine(c.Home, ".claude.json"), "Claude");
        }
        if (client == "Codex")
        {
            string path = Path.Combine(c.Home, ".codex", "config.toml");
            if (!File.Exists(path)) return "kept (not installed)";
            string text = File.ReadAllText(path, Encoding.UTF8).TrimStart('﻿').Replace("\r\n", "\n");
            var parsed = ReadCodexToml(text);
            if (CodexPluginConfigured(parsed)) return Plugin;
            var (_, block) = CutTomlTables(text);
            return block != null && CodexInstallerBlock(block, c.LocalAppData) ? Codex(c) ?? "kept" : "kept (absent, disabled or custom route)";
        }
        foreach (string folder in new[] { Path.Combine(c.Home, ".gemini", "config"), Path.Combine(c.Home, ".gemini", "antigravity") })
        {
            string plugin = Path.Combine(folder, "plugins", Name), config = Path.Combine(plugin, "mcp_config.json");
            if (!File.Exists(Path.Combine(plugin, "plugin.json")) || !File.Exists(config)) continue;
            var settings = ReadJson(Path.Combine(folder, "config.json"));
            var choice = settings["plugins"]?[Name];
            if (choice is JsonValue flag && flag.TryGetValue<bool>(out bool enabled) && !enabled ||
                choice is JsonObject item && item["enabled"]?.ToString() == "false") return "kept (disabled plugin)";
            var current = (ReadJson(config)["mcpServers"] as JsonObject)?[Name];
            bool native = InstalledEntry(c, current, "Antigravity");
            string? knownToken = Environment.GetEnvironmentVariable("NEXUS_MCP_TOKEN");
            string? authorization = current?["headers"]?["Authorization"]?.ToString();
            bool ownBearer = authorization == "Bearer ${NEXUS_MCP_TOKEN}" ||
                !string.IsNullOrEmpty(knownToken) && authorization == "Bearer " + knownToken;
            bool daemon = current is JsonObject route && route.Count == 2 &&
                (route["serverUrl"] ?? route["httpUrl"] ?? route["url"])?.ToString() == "http://127.0.0.1:16182/mcp?agent=antigravity" &&
                route["headers"] is JsonObject headers && headers.Count == 1 && ownBearer;
            if (!native && !daemon) return "kept (custom plugin route)";
            // Preserve the transport, choice of app and enablement. Refresh only an already installed own guide.
            if (native) UpdateJsonExisting(c, config, "Antigravity");
            string source = Path.Combine(c.SourceRoot, "plugins", Name);
            WriteAtomic(Path.Combine(plugin, "plugin.json"), File.ReadAllText(Path.Combine(source, "plugin.json")));
            WriteAtomic(Path.Combine(plugin, "skills", Name, "SKILL.md"), File.ReadAllText(Path.Combine(c.SourceRoot, "skills", Name, "SKILL.md")));
            return "updated existing plugin (transport and enablement preserved)";
        }
        return "kept (not installed)";
    }

    private static List<string> UpdateExistingDesktops(Context c)
    {
        var roots = new List<string> { Path.Combine(c.RoamingAppData, "Claude") };
        string packages = Path.Combine(c.LocalAppData, "Packages"), data = Path.Combine(c.LocalAppData, "Claude-Data");
        if (Directory.Exists(packages)) roots.AddRange(Directory.EnumerateDirectories(packages, "*Claude_*").Select(p => Path.Combine(p, "LocalCache", "Roaming", "Claude")));
        if (Directory.Exists(data)) roots.AddRange(Directory.EnumerateDirectories(data));
        return roots.Where(Directory.Exists).Where(p => !Directory.EnumerateFileSystemEntries(p, ".user-data-left.*").Any())
            .Select(p => McpbInstalled(p) ? Mcpb : UpdateJsonExisting(c, Path.Combine(p, "claude_desktop_config.json"), "Claude")).ToList();
    }
}
