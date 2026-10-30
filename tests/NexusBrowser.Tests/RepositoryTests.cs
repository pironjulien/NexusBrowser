using System.Diagnostics;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using NexusBrowser.Native;
using Xunit;

namespace NexusBrowser.Tests;

/// <summary>Repository-wide contracts of the native-only NexusBrowser: one version everywhere it is published, the
/// packages point to the native engine, no Python left, the Chrome Web Store listing matches the extension.</summary>
public sealed class RepositoryTests
{
    private static JsonNode Json(params string[] path) => JsonNode.Parse(File.ReadAllText(Repo.File(path)))!;
    private static string Text(params string[] path) => File.ReadAllText(Repo.File(path));

    private static readonly string Version = Text("VERSION").Trim();

    // ---------------------------------------------------------------------------------------------
    // Versions and published packages
    // ---------------------------------------------------------------------------------------------

    [Fact]
    public void VersionsAgree()
    {
        Assert.Matches(@"^\d+\.\d+\.\d+$", Version);
        Assert.Equal(BridgeSecurity.Version, Version);
        Assert.Equal(Version, (string?)Json("mcpb", "manifest.json")["version"]);
        Assert.Equal(Version, (string?)Json("plugins", "nexus-browser", "plugin.json")["version"]);
        Assert.Equal(Version, (string?)Json("gemini-extension.json")["version"]);
        var server = Json("server.json");
        Assert.Equal(Version, (string?)server["version"]);
        Assert.Equal(Version, (string?)server["packages"]![0]!["version"]);
        // extension/manifest.json has its own version: the extension is released only when it changes.
    }

    [Fact]
    public void RegistryPackageIsTheReleasedMcpb()
    {
        var package = Json("server.json")["packages"]![0]!;
        Assert.Equal("mcpb", (string?)package["registryType"]);
        Assert.EndsWith($"/v{Version}/nexus-browser.mcpb", (string?)package["identifier"]);
        Assert.StartsWith("https://github.com/pironjulien/NexusBrowser/releases/download/", (string?)package["identifier"]);
        Assert.Equal("stdio", (string?)package["transport"]?["type"]);
    }

    [Fact]
    public void McpbRunsTheNativeEngine()
    {
        var server = Json("mcpb", "manifest.json")["server"]!;
        Assert.Equal("binary", (string?)server["type"]);
        Assert.Equal("${__dirname}/server/NexusBrowser.exe", (string?)server["mcp_config"]?["command"]);
        Assert.True(JsonNode.DeepEquals(new JsonArray("--mcp"), server["mcp_config"]?["args"]), server.ToJsonString());
        Assert.Equal("server/NexusBrowser.exe", (string?)server["entry_point"]);
    }

    [Fact]
    public void GeminiExtensionUsesTheSharedDaemonWithItsToken()
    {
        var entry = Json("gemini-extension.json")["mcpServers"]!["nexus-browser"]!;
        var url = new Uri((string)entry["httpUrl"]!);
        Assert.Equal("http://127.0.0.1:16182/mcp?agent=antigravity", url.ToString()); // the daemon knows claude, codex and antigravity only
        Assert.Equal("Bearer ${NEXUS_MCP_TOKEN}", (string?)entry["headers"]?["Authorization"]);
        Assert.Null(entry["command"]); // no local process: the daemon installed by get.ps1
    }

    // ---------------------------------------------------------------------------------------------
    // No Python left
    // ---------------------------------------------------------------------------------------------

    /// <summary>Tracked and new (not ignored) files present in the working tree.</summary>
    private static List<string> RepositoryFiles()
    {
        var info = new ProcessStartInfo("git") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = Repo.Root };
        foreach (string arg in new[] { "-c", "core.quotepath=off", "ls-files", "-z", "--cached", "--others", "--exclude-standard" }) info.ArgumentList.Add(arg);
        using var git = Process.Start(info)!;
        string output = git.StandardOutput.ReadToEnd();
        git.WaitForExit();
        Assert.Equal(0, git.ExitCode);
        return output.Split('\0', StringSplitOptions.RemoveEmptyEntries).Where(f => File.Exists(Repo.File(f))).ToList();
    }

    [Fact]
    public void NoPythonFileIsTracked()
    {
        var files = RepositoryFiles();
        Assert.Contains("native/NexusBrowser.csproj", files);
        Assert.DoesNotContain(files, f => f.EndsWith(".py", StringComparison.OrdinalIgnoreCase) ||
            Path.GetFileName(f) is "pyproject.toml" or "uv.lock" or "requirements.txt" or ".python-version");
    }

    [Fact]
    public void NoScriptOrConfigurationRunsPython()
    {
        // Invocations only: the word "Python" legitimately remains in comments about the migration (former entries
        // replaced in place, the former environment removed). This test folder is exempt: its fixtures write
        // former Python entries on purpose.
        var invocation = new Regex(@"\bpythonw?(\.exe)?[""']?\s+(-[a-z]\b|\S+\.py\b)|\buv\s+(sync|run|pip)\b|\buvx\b|\bpip3?\s+install\b|\bpy\s+-3\b",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        var found = new List<string>();
        foreach (string file in RepositoryFiles().Where(f => Regex.IsMatch(f, @"\.(ps1|psm1|yml|yaml|json|cs|cmd|bat)$", RegexOptions.IgnoreCase)))
        {
            if (file.StartsWith("tests/NexusBrowser.Tests/", StringComparison.Ordinal)) continue;
            var lines = File.ReadAllLines(Repo.File(file));
            for (int i = 0; i < lines.Length; i++)
                if (invocation.IsMatch(lines[i])) found.Add($"{file}:{i + 1}: {lines[i].Trim()}");
        }
        Assert.Empty(found);
    }

    [Fact]
    public void NothingRunsDownloadedOrEncodedCodeInMemory()
    {
        // Microsoft Defender flags these lines (Trojan:Win32/Commando.A!ml): installers are files run with -File.
        // This file and the changelog name the patterns; everything else must not use them.
        var pattern = new Regex(@"\|\s*iex\b|Invoke-Expression|-EncodedCommand|\[scriptblock\]::Create|\birm\s+https?://",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        var found = new List<string>();
        foreach (string file in RepositoryFiles().Where(f => Regex.IsMatch(f, @"\.(ps1|psm1|yml|yaml|json|cs|cmd|bat|md|js|html)$", RegexOptions.IgnoreCase)))
        {
            if (file is "CHANGELOG.md" or "tests/NexusBrowser.Tests/RepositoryTests.cs") continue;
            var lines = File.ReadAllLines(Repo.File(file));
            for (int i = 0; i < lines.Length; i++)
                if (pattern.IsMatch(lines[i])) found.Add($"{file}:{i + 1}: {lines[i].Trim()}");
        }
        Assert.Empty(found);
    }

    [Fact]
    public void NoPythonCacheOrToolFolderInTheRepository()
    {
        foreach (string name in new[] { ".venv", ".ruff_cache", ".pytest_cache", "__pycache__" })
            Assert.False(Directory.Exists(Repo.File(name)), name);
        Assert.DoesNotContain(Directory.EnumerateDirectories(Repo.Root, "__pycache__", SearchOption.AllDirectories),
            d => !d.Contains($"{Path.DirectorySeparatorChar}node_modules{Path.DirectorySeparatorChar}", StringComparison.OrdinalIgnoreCase));
    }

    // ---------------------------------------------------------------------------------------------
    // Chrome Web Store listing and the extension's reach
    // ---------------------------------------------------------------------------------------------

    [Fact]
    public void ListingMatchesTheManifest()
    {
        var manifest = Json("extension", "manifest.json");
        string listing = Text("store", "README.md");
        var justified = Regex.Matches(listing, @"^\| `([a-zA-Z]+)` \|", RegexOptions.Multiline).Select(m => m.Groups[1].Value).ToHashSet();
        var permissions = manifest["permissions"]!.AsArray().Select(p => (string)p!).ToHashSet();
        Assert.Equal(permissions.Order(), justified.Order());
        string description = (string)manifest["description"]!;
        Assert.True(description.Length <= 132, $"{description.Length} characters");
        Assert.Contains((string)manifest["name"]!, listing);
        static string Squash(string text) => Regex.Replace(text, @"\s+", " ");
        Assert.Contains(Squash(description), Squash(listing));
    }

    [Fact]
    public void CspReachesOnlyTheBridgeAndTheDocumentedGmailFeed()
    {
        string policy = (string)Json("extension", "manifest.json")["content_security_policy"]!["extension_pages"]!;
        var connect = Regex.Match(policy, "connect-src ([^;]+);");
        Assert.True(connect.Success, policy);
        var remote = connect.Groups[1].Value.Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .Where(s => s != "'self'" && !Regex.IsMatch(s, @"^(ws|http)://(127\.0\.0\.1|localhost):\*$")).ToList();
        Assert.Equal(["https://mail.google.com"], remote);
        foreach (string doc in new[] { "README.md", "store/SINGLE_PURPOSE.md" })
        {
            var hosts = Regex.Matches(Text(doc.Split('/')), @"https://[^\s)`'""<>]+").Select(m => Uri.TryCreate(m.Value, UriKind.Absolute, out var u) ? u.Host : "");
            Assert.Contains("mail.google.com", hosts);
        }
        Assert.Contains("FLUX_GMAIL", Text("extension", "background.js"));
    }

    // ---------------------------------------------------------------------------------------------
    // Texts an agent reads outside tools/list
    // ---------------------------------------------------------------------------------------------

    [Fact]
    public void PublicSkillNamesNobodyAndDescribesOneTabPerSession()
    {
        string skill = Text("skills", "nexus-browser", "SKILL.md");
        Assert.DoesNotContain("Julien", skill, StringComparison.Ordinal);
        Assert.DoesNotContain("lastAgentTabId", skill, StringComparison.Ordinal);
        Assert.Contains("One tab per agent session", skill);
        Assert.Contains("browser_adopt_tab", skill);
        Assert.Contains("full page access with no masking", skill);
    }

    [Fact]
    public void ReadmeAnnouncesEvalFullAccessAndMaskedValues()
    {
        string readme = Text("README.md");
        Assert.Contains("full access to the page", readme);
        Assert.Contains("[masked value]", readme);
        // Copied into the Antigravity plugin: the personal skill if present, else the public one.
        string install = Text("install.ps1");
        Assert.Contains(@"perso\nexus-browser\SKILL.md", install);
        Assert.Contains(@"skills\nexus-browser\SKILL.md", install);
    }
}
