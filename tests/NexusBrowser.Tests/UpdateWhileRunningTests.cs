using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using Xunit;

namespace NexusBrowser.Tests;

/// <summary>The release engine (self-contained single file, built by scripts\build-native.ps1 -Runtime), published once
/// for the class.</summary>
public sealed class ReleaseEngine : IDisposable
{
    private readonly TempDir _dir = new();

    public string Folder => _dir["release"];

    public void Dispose() => _dir.Dispose();

    public async ValueTask EnsureAsync()
    {
        if (File.Exists(Path.Join(Folder, "NexusBrowser.exe"))) return;
        string rid = RuntimeInformation.OSArchitecture == Architecture.Arm64 ? "win-arm64" : "win-x64";
        string buildRoot = Environment.GetEnvironmentVariable("NEXUS_BROWSER_BUILD_ROOT") is { Length: > 0 } configured
            ? configured
            : Path.Join(TestEnvironment.OriginalUserProfile!, ".nexus", "build", "nexus-browser");
        // dotnet publish needs the real profile (NuGet cache), its own intermediate folder (the test build's stays
        // untouched) and no MSBuild state inherited from the test host. The single-file publish adds the analyzer
        // package Microsoft.NET.ILLink.Tasks to the restore: its lock file goes to the test folder, so a test run never
        // changes native\packages.lock.json.
        var env = new Dictionary<string, string?>
        {
            ["USERPROFILE"] = TestEnvironment.OriginalUserProfile,
            ["HOME"] = TestEnvironment.OriginalHome,
            ["NEXUS_BROWSER_BUILD_ROOT"] = Path.Join(buildRoot, "release-test"),
            ["NuGetLockFilePath"] = _dir["packages.lock.json"],
            ["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1",
            ["DOTNET_NOLOGO"] = "1",
        };
        foreach (string name in Environment.GetEnvironmentVariables().Keys.Cast<string>()
                     .Where(n => n.StartsWith("MSBuild", StringComparison.OrdinalIgnoreCase) || n is "DOTNET_HOST_PATH" or "MSBUILD_EXE_PATH"))
            env[name] = null;
        var (code, stdout, stderr) = await Shells.FileAsync(Shells.Pwsh, Repo.File("scripts", "build-native.ps1"),
            ["-Runtime", rid, "-OutputDirectory", Folder], env, timeoutSeconds: 600);
        Assert.True(code == 0, stdout + stderr);
    }
}

/// <summary>
/// An AI session keeps its engine for hours (shared daemon, bridge, stdio server) while an update installs the next
/// build. The release engine is a .NET single file that reads its own executable for each assembly on first use:
/// NexusFree 1.3.3 found that replacing that file under a running engine (renamed aside, new version copied to its
/// path) makes every later tool call fail with an empty error. NexusBrowser installs each build in its own folder,
/// never written again, and removes an older folder only once no engine runs from it. Here the real release engine
/// runs from such a folder, the next build is installed and the cleanup runs with the installer's own functions
/// (scripts\runtime.ps1), and the engine must still answer; the in-place replacement is checked too, to show this
/// test sees the failure when it happens.
/// </summary>
public sealed class UpdateWhileRunningTests(ReleaseEngine release) : IClassFixture<ReleaseEngine>, IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    private async Task<string[]> RuntimeAsync(string commands)
    {
        string script = _dir[$"runtime-{Guid.NewGuid():N}.ps1"];
        File.WriteAllText(script, $"$ErrorActionPreference = 'Stop'\n. {Shells.Quote(Repo.File("scripts", "runtime.ps1"))}\n{commands}\n", Encoding.ASCII);
        var (code, stdout, stderr) = await Shells.FileAsync(Shells.Pwsh, script, timeoutSeconds: 120);
        Assert.True(code == 0, stdout + stderr);
        return Shells.Lines(stdout);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ARunningEngineKeepsAnsweringWhileTheNextBuildIsInstalled(bool replacedInPlace)
    {
        var ct = TestContext.Current.CancellationToken;
        await release.EnsureAsync();
        string versions = _dir["NexusBrowser\\versions"];
        string q = Shells.Quote(versions);
        string[] installed = await RuntimeAsync($"$b = Install-EngineBuild {Shells.Quote(release.Folder)} {q}; $b.Directory; $b.Fingerprint");
        string running = installed[0], fingerprint = installed[1];
        string exe = Path.Join(running, "NexusBrowser.exe");

        string token = new('u', 64);
        string bridgeToken = _dir["bridge-token"];
        File.WriteAllText(bridgeToken, new string('b', 64), Encoding.ASCII);
        int port = Ports.Free();
        using var daemon = new ChildProcess(exe, ["--http", port.ToString(System.Globalization.CultureInfo.InvariantCulture)], new Dictionary<string, string?>
        {
            ["NEXUS_MCP_TOKEN"] = token,
            ["NEXUS_SHARED_HOME"] = _dir["shared"],
            ["NEXUS_BROWSER_TOKEN_FILE"] = bridgeToken,
        });
        string base_ = $"http://127.0.0.1:{port}";
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (true)
        {
            try { await http.GetStringAsync(base_ + "/health", ct); break; }
            catch (HttpRequestException) when (DateTime.UtcNow < deadline && !daemon.Process.HasExited) { await Task.Delay(100, ct); }
        }

        string? session = null;
        async Task<JsonNode> Post(string body)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, base_ + "/mcp?agent=claude") { Content = new StringContent(body, Encoding.UTF8, "application/json") };
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            if (session is not null) request.Headers.Add("mcp-session-id", session);
            using var response = await http.SendAsync(request, ct);
            Assert.True(response.IsSuccessStatusCode, $"{(int)response.StatusCode}; stderr={daemon.Stderr}");
            session ??= response.Headers.GetValues("mcp-session-id").Single();
            return JsonNode.Parse(await response.Content.ReadAsStringAsync(ct))!;
        }

        // Only the session is opened before the update: every tool path below runs for the first time after it.
        await Post("""{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}""");

        if (replacedInPlace)
        {
            // What NexusFree's installer did before 1.3.3: the running engine renamed aside, other bytes at its path.
            File.Move(exe, exe + ".old");
            var junk = new byte[4 * 1024 * 1024];
            Random.Shared.NextBytes(junk);
            await File.WriteAllBytesAsync(exe, junk, ct);
        }
        else
        {
            // The next build (the same engine with other bytes: another fingerprint), installed and cleaned up as
            // install-native.ps1 does while this engine serves its session.
            string next = _dir["next"];
            Directory.CreateDirectory(next);
            foreach (string file in Directory.EnumerateFiles(release.Folder)) File.Copy(file, Path.Join(next, Path.GetFileName(file)));
            await File.AppendAllTextAsync(Path.Join(next, "NexusBrowser.exe"), "next build", ct);
            string[] updated = await RuntimeAsync($"$b = Install-EngineBuild {Shells.Quote(next)} {q}; Remove-UnusedEngineBuilds {q} $b.Directory; $b.Directory; Get-BuildFingerprint {Shells.Quote(running)}");
            Assert.NotEqual(running, updated[0]);
            Assert.Equal(fingerprint, updated[1]); // the running engine's folder is kept, its file untouched
            Assert.Equal(Directory.EnumerateFiles(release.Folder).Select(Path.GetFileName).Order(),
                Directory.EnumerateFiles(running).Select(Path.GetFileName).Where(f => f != "installation.json").Order());
        }

        var tools = await Post("""{"jsonrpc":"2.0","id":2,"method":"tools/list"}""");
        Assert.Equal(49, tools["result"]!["tools"]!.AsArray().Count);
        // No bridge here (port 1): the call goes as far as the HTTP request, and a working engine says why it failed.
        var call = await Post("""{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"browser_list_tabs","arguments":{}}}""");
        var error = JsonNode.Parse((string)call["result"]!["content"]![0]!["text"]!)!["error"]!.GetValue<string>();
        if (replacedInPlace)
        {
            Assert.Equal("", error);
            return;
        }
        Assert.Contains("NexusBrowser bridge", error, StringComparison.Ordinal);

        // Once that engine has exited, the next update removes its folder and keeps the build in use.
        daemon.Process.Kill(entireProcessTree: true);
        await daemon.Process.WaitForExitAsync(ct);
        string current = Directory.EnumerateDirectories(versions).Single(d => d != running);
        await RuntimeAsync($"Remove-UnusedEngineBuilds {q} {Shells.Quote(current)}");
        Assert.False(Directory.Exists(running));
        Assert.True(File.Exists(Path.Join(current, "NexusBrowser.exe")));
    }
}
