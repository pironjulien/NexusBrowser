using System.Buffers.Binary;
using System.ComponentModel;
using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using NexusBrowser.Native;
using Xunit;

namespace NexusBrowser.Tests;

/// <summary>The built NexusBrowser.exe as a real process (tests/test_native_csharp.py and the process-bound parts of
/// tests/test_native_parity.py). Each process gets its own token, ports and folders.</summary>
public sealed partial class NativeProcessTests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    // ---------------------------------------------------------------------------------------------
    // Chrome launches the WinExe through cmd.exe: a console exists, the redirected streams must stay.
    // ---------------------------------------------------------------------------------------------

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public int cb;
        public nint lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public nint lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public nint hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    // commandLine: a writable, null-terminated buffer (CreateProcessW may modify it in place).
    [LibraryImport("kernel32.dll", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CreateProcessW(string? application, ref char commandLine, nint processAttributes, nint threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint creationFlags, nint environment, string? currentDirectory,
        ref StartupInfo startupInfo, out ProcessInformation processInformation);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    private static partial uint WaitForSingleObject(nint handle, uint milliseconds);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetExitCodeProcess(nint process, out uint exitCode);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CloseHandle(nint handle);

    [Fact]
    public void ChromeCmdConsolePreservesNativeMessageStreams()
    {
        string incoming = _dir["message.in"], outgoing = _dir["message.out"];
        byte[] raw = Encoding.UTF8.GetBytes("{\"op\":\"unsupported\"}");
        var framed = new byte[4 + raw.Length];
        BinaryPrimitives.WriteUInt32LittleEndian(framed, (uint)raw.Length);
        raw.CopyTo(framed, 4);
        File.WriteAllBytes(incoming, framed);

        // Exactly Chrome's launch: cmd /d /s /c with redirections, a new (hidden) console.
        string comspec = Environment.GetEnvironmentVariable("COMSPEC") ?? "cmd.exe";
        string command = $"\"\"{NativeExe.Path}\" chrome-extension://{FakeExtension.Id}/ --parent-window=0 < \"{incoming}\" > \"{outgoing}\"\"";
        var startup = new StartupInfo { cb = Marshal.SizeOf<StartupInfo>(), dwFlags = 0x1 /* STARTF_USESHOWWINDOW */, wShowWindow = 0 /* SW_HIDE */ };
        char[] commandLine = $"{comspec} /d /s /c {command}\0".ToCharArray();
        if (!CreateProcessW(null, ref commandLine[0], 0, 0, false, 0x10 /* CREATE_NEW_CONSOLE */, 0, null, ref startup, out var info))
            throw new Win32Exception();
        try
        {
            if (WaitForSingleObject(info.hProcess, 15_000) != 0)
            {
                try { using var stuck = Process.GetProcessById(info.dwProcessId); stuck.Kill(entireProcessTree: true); } catch (ArgumentException) { /* already exited */ }
                Assert.Fail("The native host waited forever behind cmd.exe instead of answering Chrome");
            }
            Assert.True(GetExitCodeProcess(info.hProcess, out uint code));
            Assert.Equal(0u, code);
        }
        finally
        {
            CloseHandle(info.hThread);
            CloseHandle(info.hProcess);
        }
        byte[] reply = File.ReadAllBytes(outgoing);
        Assert.True(reply.Length >= 4, $"{reply.Length} bytes");
        int length = (int)BinaryPrimitives.ReadUInt32LittleEndian(reply);
        Assert.Equal(length + 4, reply.Length);
        Assert.True(JsonNode.DeepEquals(new JsonObject { ["ok"] = false, ["error"] = "opération inconnue" }, JsonNode.Parse(Encoding.UTF8.GetString(reply, 4, length))));
    }

    // ---------------------------------------------------------------------------------------------
    // Real --bridge process, a WebSocket fake extension, then a real --mcp stdio process.
    // ---------------------------------------------------------------------------------------------

    private static async Task<string> FirstLineAsync(ChildProcess child, int seconds)
    {
        var line = child.Process.StandardOutput.ReadLineAsync(TestContext.Current.CancellationToken).AsTask();
        if (await Task.WhenAny(line, Task.Delay(TimeSpan.FromSeconds(seconds), TestContext.Current.CancellationToken)) != line)
            Assert.Fail($"no banner in {seconds} s; exited={child.Process.HasExited} stderr={child.Stderr}");
        return await line ?? throw new InvalidOperationException($"process ended without banner; stderr={child.Stderr}");
    }

    [Fact]
    public async Task BridgeProcessAndMcpStdioProcessReachAFakeExtension()
    {
        var ct = TestContext.Current.CancellationToken;
        string tokenFile = _dir["bridge-token"];
        string token = BridgeSecurity.LoadOrCreateToken(tokenFile);
        var env = new Dictionary<string, string?>
        {
            ["NEXUS_BROWSER_TOKEN_FILE"] = tokenFile,
            ["NEXUS_JOURNAL_HOME"] = _dir["journal"],
            ["NEXUS_SHARED_HOME"] = _dir["shared"],
            ["NEXUS_STATUS_DIR"] = _dir["status"],
        };
        using var bridge = new ChildProcess(NativeExe.Path,
            ["--bridge", "--port", "0", "--token-file", tokenFile, "--log-file", _dir["bridge.log"]], env);
        // The OS allocates both ports while binding. Releasing "free" probes before starting a child raced with
        // parallel tests and outbound ephemeral sockets. Read the bound addresses from the startup banner.
        Assert.StartsWith("===", await FirstLineAsync(bridge, 15));
        await FirstLineAsync(bridge, 15); // title
        string wsAddress = (await FirstLineAsync(bridge, 15)).Trim()["WebSocket: ".Length..];
        string httpAddress = (await FirstLineAsync(bridge, 15)).Trim()["HTTP REST: ".Length..];
        int wsPort = new Uri(wsAddress).Port, httpPort = new Uri(httpAddress).Port;
        env["NEXUS_BROWSER_HTTP_PORT"] = httpPort.ToString();
        _ = bridge.Process.StandardOutput.ReadToEndAsync(ct); // keep draining

        using var http = new HttpClient();
        http.DefaultRequestHeaders.Add(BridgeSecurity.TokenHeader, token);
        var status = JsonNode.Parse(await http.GetStringAsync($"http://127.0.0.1:{httpPort}/api/status", ct))!;
        Assert.Equal("online", (string?)status["status"]);
        Assert.Equal(wsPort, (int)status["port"]!);
        _ = status["chrome_running"]!.GetValue<bool>();

        using var ws = await FakeExtension.ConnectAsync(wsPort);
        var (_, _, channel) = await FakeExtension.HandshakeAsync(ws, token, authMode: null, "service_worker");
        var received = new List<JsonObject>();
        using var responder = new CancellationTokenSource();
        var responderTask = FakeExtension.RespondAsync(ws, channel, received, command => (string?)command["action"] == "list_tabs"
            ? new JsonArray(new JsonObject { ["id"] = 7, ["url"] = "https://julienpiron.fr", ["title"] = "Julien", ["active"] = true, ["mine"] = true, ["state"] = "mine" })
            : new JsonObject { ["ok"] = true }, responder.Token);

        // 1. Upload from a secrets folder: HTTP 403 before anything reaches the extension.
        using (var upload = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{httpPort}/api/command"))
        {
            upload.Content = new StringContent(new JsonObject
            {
                ["action"] = "upload",
                ["params"] = new JsonObject { ["files"] = new JsonArray(Path.Join(BridgeSecurity.HomeDir(), ".ssh", "id_ed25519")), ["tab_id"] = 7 },
                ["timeout"] = 5.0,
            }.ToJsonString(), Encoding.UTF8, "application/json");
            upload.Headers.Add(BridgeSecurity.AgentHeader, "Claude");
            upload.Headers.Add(BridgeSecurity.ClientHeader, "claude-test1234");
            using var refused = await http.SendAsync(upload, ct);
            Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        }
        lock (received) Assert.DoesNotContain(received, c => (string?)c["action"] == "upload");

        // 2. MCP stdio process against the bridge process.
        string lines = string.Join("\n",
            """{"jsonrpc":"2.0","id":1,"method":"server/discover"}""",
            """{"jsonrpc":"2.0","id":2,"method":"tools/list"}""",
            """{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"browser_list_tabs","arguments":{}}}""") + "\n";
        var (code, stdout, stderr) = await ChildProcess.RunAsync(NativeExe.Path, ["--mcp", "--agent", "Claude", "--token-file", tokenFile], env, lines, timeoutSeconds: 20);
        Assert.True(code == 0, stderr);
        var answers = stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(l => JsonNode.Parse(l)!).OrderBy(a => (int)a["id"]!).ToList();
        Assert.Equal(3, answers.Count);
        Assert.Equal("2026-07-28", (string?)answers[0]["result"]!["protocolVersion"]);
        Assert.Equal(49, answers[1]["result"]!["tools"]!.AsArray().Count);
        Assert.False((bool)answers[2]["result"]!["isError"]!, answers[2].ToJsonString());
        Assert.Equal(7, (int)answers[2]["result"]!["structuredContent"]!["data"]![0]!["id"]!);

        responder.Cancel();
        try { await responderTask; } catch (OperationCanceledException) { /* stopped on purpose */ }
    }

    // ---------------------------------------------------------------------------------------------
    // --http daemon: health, sessions bound to their agent; duplicate port diagnostic.
    // ---------------------------------------------------------------------------------------------

    [Fact]
    public async Task HttpHealthAndSessionsCannotBeClaimedByAnotherAgent()
    {
        var ct = TestContext.Current.CancellationToken;
        string token = new('d', 64);
        int port = Ports.Free();
        using var daemon = new ChildProcess(NativeExe.Path, ["--http", port.ToString()], new Dictionary<string, string?>
        {
            ["NEXUS_MCP_TOKEN"] = token,
            ["NEXUS_SHARED_HOME"] = _dir["shared"],
        });
        string base_ = $"http://127.0.0.1:{port}";
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };

        JsonNode? health = null;
        var deadline = Stopwatch.StartNew();
        while (health is null)
        {
            try { health = JsonNode.Parse(await http.GetStringAsync(base_ + "/health", ct)); }
            catch (HttpRequestException) when (deadline.Elapsed < TimeSpan.FromSeconds(10) && !daemon.Process.HasExited) { await Task.Delay(50, ct); }
        }
        Assert.Equal("ok", (string?)health["status"]);
        Assert.Equal("nexus-browser", (string?)health["service"]);
        Assert.Equal("native", (string?)health["runtime"]);
        Assert.Matches("^[0-9a-f]{64}$", (string?)health["fingerprint"] ?? "");

        async Task<HttpResponseMessage> Post(string path, string body, string? session = null)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, base_ + path) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            if (session is not null) request.Headers.Add("mcp-session-id", session);
            return await http.SendAsync(request, ct);
        }

        string session;
        using (var initialized = await Post("/mcp?agent=codex", """{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"""))
        {
            Assert.Equal(HttpStatusCode.OK, initialized.StatusCode);
            session = initialized.Headers.GetValues("mcp-session-id").Single();
        }
        const string list = """{"jsonrpc":"2.0","id":2,"method":"tools/list"}""";
        using (var stolen = await Post("/mcp?agent=claude", list, session))
            Assert.Equal(HttpStatusCode.NotFound, stolen.StatusCode);
        using (var own = await Post("/mcp?agent=codex", list, session))
        {
            Assert.Equal(HttpStatusCode.OK, own.StatusCode);
            Assert.Equal(49, JsonNode.Parse(await own.Content.ReadAsStringAsync(ct))!["result"]!["tools"]!.AsArray().Count);
        }
        // Idle expiry has its own test (ExpiredSessionAnswers404AndIsLogged), which waits for the
        // daemon's expiry evidence. A subsecond lease here races agent-isolation assertions on busy runners.
        using (var anonymousBody = new StringContent(list, Encoding.UTF8, "application/json"))
        using (var anonymous = await http.PostAsync(base_ + "/mcp?agent=codex", anonymousBody, ct))
            Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);
    }

    [Fact]
    public async Task DuplicateHttpPortExitsWithADiagnosticInsteadOfCrashing()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        int port = ((IPEndPoint)listener.LocalEndpoint).Port;
        string home = _dir["home"];
        var (code, _, stderr) = await ChildProcess.RunAsync(NativeExe.Path, ["--http", port.ToString()], new Dictionary<string, string?>
        {
            ["NEXUS_MCP_TOKEN"] = new string('x', 64),
            ["USERPROFILE"] = home,
            ["HOME"] = home,
        }, timeoutSeconds: 10);
        Assert.Equal(1, code);
        Assert.StartsWith("NexusBrowser:", stderr);
        Assert.DoesNotContain("Unhandled exception", stderr);
        Assert.Contains("SocketException", File.ReadAllText(Path.Join(home, ".nexus", "nexus-browser", "engine.log")));
    }

    // ---------------------------------------------------------------------------------------------
    // Chrome startup survives the caller's KILL_ON_JOB_CLOSE job (disposable fixture, never Chrome).
    // ---------------------------------------------------------------------------------------------

    [Fact]
    public async Task ChromeStartupSurvivesCallerKillOnJobClose()
    {
        string buildRoot = Environment.GetEnvironmentVariable("NEXUS_BROWSER_BUILD_ROOT") is { Length: > 0 } configured
            ? configured
            : Path.Join(TestEnvironment.OriginalUserProfile!, ".nexus", "build", "nexus-browser");
        string output = Path.Join(buildRoot, "LifetimeFixture", "publish-tests");
        // dotnet publish needs the real profile (NuGet cache) and no MSBuild state inherited from the test host.
        var env = new Dictionary<string, string?>
        {
            ["USERPROFILE"] = TestEnvironment.OriginalUserProfile,
            ["HOME"] = TestEnvironment.OriginalHome,
            ["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1",
            ["DOTNET_NOLOGO"] = "1",
        };
        foreach (string name in Environment.GetEnvironmentVariables().Keys.Cast<string>()
                     .Where(n => n.StartsWith("MSBuild", StringComparison.OrdinalIgnoreCase) || n is "DOTNET_HOST_PATH" or "MSBUILD_EXE_PATH"))
            env[name] = null;
        var (published, publishOut, publishErr) = await ChildProcess.RunAsync("dotnet",
            ["publish", Repo.File("tests", "native_lifetime", "LifetimeFixture.csproj"), "-c", "Release", "-o", output, "--nologo", "-nodeReuse:false"],
            env, timeoutSeconds: 180);
        Assert.True(published == 0, publishOut + publishErr);

        var (code, stdout, stderr) = await ChildProcess.RunAsync(Path.Join(output, "LifetimeFixture.exe"), ["--test"], timeoutSeconds: 45);
        Assert.True(code == 0, $"stdout={stdout}\nstderr={stderr}");
        var lines = stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(l => JsonNode.Parse(l)).ToList();
        var expected = new[] { false, true }.Select(broker => (JsonNode)new JsonObject
        {
            ["ok"] = true,
            ["broker"] = broker,
            ["caller_in_job"] = true,
            ["child_in_caller_job"] = !broker,
            ["survived_job_close"] = broker,
            ["child_normal_exit"] = broker,
        }).ToList();
        Assert.Equal(2, lines.Count);
        for (int i = 0; i < 2; i++)
            Assert.True(JsonNode.DeepEquals(expected[i], lines[i]), $"line {i}: {lines[i]?.ToJsonString()}");
        Assert.False(Directory.Exists(Repo.File("tests", "native_lifetime", "bin")));
        Assert.False(Directory.Exists(Repo.File("tests", "native_lifetime", "obj")));
    }
}

/// <summary>Build and test outputs never land in the repository (OneDrive): Directory.Build.props sends them under
/// the build root.</summary>
public sealed class BuildIsolationTests
{
    [Fact]
    public void TestAssemblyIsBuiltOutsideTheRepository() =>
        Assert.False(AppContext.BaseDirectory.StartsWith(Repo.Root, StringComparison.OrdinalIgnoreCase), AppContext.BaseDirectory);

    [Fact]
    public void NoBuildOutputUnderNativeOrTests()
    {
        Assert.True(File.Exists(Repo.File("native", "NexusBrowser.csproj")), Repo.Root);
        var leaked = new[] { "native", "tests" }
            .SelectMany(top => Directory.EnumerateDirectories(Repo.File(top), "*", SearchOption.AllDirectories).Prepend(Repo.File(top)))
            .Where(d => !d.Contains($"{Path.DirectorySeparatorChar}node_modules", StringComparison.OrdinalIgnoreCase))
            .Where(d => Path.GetFileName(d) is "bin" or "obj" or "TestResults")
            .ToList();
        Assert.Empty(leaked);
    }
}
