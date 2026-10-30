using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json.Nodes;
using NexusBrowser.Native;
using Xunit;

namespace NexusBrowser.Tests;

/// <summary>
/// Process-wide isolation, applied before any test runs: every path the engine derives from the user profile
/// (token, journal, emergency stop, update status, screenshots, exports, counters, restart request) points into a
/// disposable folder, and the default bridge port is a dead one. No test can reach the real bridge, daemon or files.
/// </summary>
internal static class TestEnvironment
{
    public static string Root { get; private set; } = "";
    public static string Home => Path.Combine(Root, "home");
    public static string? OriginalUserProfile { get; private set; }
    public static string? OriginalHome { get; private set; }

#pragma warning disable CA2255 // A module initializer is the only hook that runs before every test class.
    [ModuleInitializer]
#pragma warning restore CA2255
    internal static void Initialize()
    {
        OriginalUserProfile = Environment.GetEnvironmentVariable("USERPROFILE");
        OriginalHome = Environment.GetEnvironmentVariable("HOME");
        Root = Path.Combine(Path.GetTempPath(), $"nb-tests-{Environment.ProcessId}-{Guid.NewGuid():N}");
        Directory.CreateDirectory(Home);
        Environment.SetEnvironmentVariable("USERPROFILE", Home);
        Environment.SetEnvironmentVariable("HOME", Home);
        Environment.SetEnvironmentVariable("NEXUS_JOURNAL_HOME", Path.Combine(Root, "journal"));
        Environment.SetEnvironmentVariable("NEXUS_SHARED_HOME", Path.Combine(Root, "shared"));
        Environment.SetEnvironmentVariable("NEXUS_STATUS_DIR", Path.Combine(Root, "status"));
        Environment.SetEnvironmentVariable("NEXUS_BROWSER_TOKEN_FILE", Path.Combine(Home, ".nexus", "nexus-browser", "bridge-token"));
        Environment.SetEnvironmentVariable("NEXUS_BROWSER_RESTART_REQUEST", Path.Combine(Root, "daemon-restart.request"));
        // Port 1 refuses at once; any port other than 9225 also disables bridge/Chrome auto-start in McpServer.
        Environment.SetEnvironmentVariable("NEXUS_BROWSER_HTTP_PORT", "1");
        foreach (string inherited in new[] { "NEXUS_MCP_TOKEN", "NEXUS_MCP_TOKEN_FILE", "NEXUS_BROWSER_SESSION_IDLE_SECONDS",
                     "NEXUS_BROWSER_ALLOWED_ORIGINS", "NEXUS_CHROME_EXTRA_ARGS", "NEXUS_BROWSER_AGENT" })
            Environment.SetEnvironmentVariable(inherited, null);
        AppDomain.CurrentDomain.ProcessExit += (_, _) =>
        {
            try { Directory.Delete(Root, recursive: true); } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        };
    }
}

/// <summary>Tests that change process-wide environment variables run alone, after the parallel collections.</summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class ProcessEnvironmentCollection
{
    public const string Name = "Process environment";
}

/// <summary>Sets environment variables for the lifetime of a test and restores the previous values.</summary>
internal sealed class EnvScope : IDisposable
{
    private readonly Dictionary<string, string?> _previous = new();

    public EnvScope(params (string Name, string? Value)[] values)
    {
        foreach (var (name, value) in values)
        {
            _previous[name] = Environment.GetEnvironmentVariable(name);
            Environment.SetEnvironmentVariable(name, value);
        }
    }

    public void Dispose()
    {
        foreach (var (name, value) in _previous)
            Environment.SetEnvironmentVariable(name, value);
    }
}

internal sealed class TempDir : IDisposable
{
    public string Path { get; } = Directory.CreateDirectory(System.IO.Path.Combine(TestEnvironment.Root, "t-" + Guid.NewGuid().ToString("N")[..12])).FullName;

    public string this[string relative] => System.IO.Path.Combine(Path, relative);

    public void Dispose()
    {
        try { Directory.Delete(Path, recursive: true); } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }
}

internal static class Repo
{
    private static string ThisFile([CallerFilePath] string path = "") => path;

    /// <summary>Repository root, from this source file's location (the build output lives outside the repo).</summary>
    public static string Root { get; } = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(ThisFile())!, "..", ".."));

    public static string File(params string[] parts) => Path.Combine([Root, .. parts]);
}

internal static class NativeExe
{
    /// <summary>The engine built by the project reference, copied next to the test assembly.</summary>
    public static string Path
    {
        get
        {
            string exe = System.IO.Path.Combine(AppContext.BaseDirectory, "NexusBrowser.exe");
            Assert.True(System.IO.File.Exists(exe), $"NexusBrowser.exe not found next to the tests: {exe}");
            return exe;
        }
    }
}

internal static class Ports
{
    public static int Free()
    {
        using var probe = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
        probe.Bind(new IPEndPoint(IPAddress.Loopback, 0));
        return ((IPEndPoint)probe.LocalEndPoint!).Port;
    }

    /// <summary>A free port p such that p and p + 1 are both available on 127.0.0.1 (--bridge uses p + 1 for HTTP).</summary>
    public static int FreePair()
    {
        for (int attempt = 0; attempt < 50; attempt++)
        {
            int port = Free();
            if (port >= 65535) continue;
            try
            {
                using var a = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
                using var b = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
                a.Bind(new IPEndPoint(IPAddress.Loopback, port));
                b.Bind(new IPEndPoint(IPAddress.Loopback, port + 1));
                return port;
            }
            catch (SocketException) { }
        }
        throw new InvalidOperationException("Unable to allocate a consecutive ephemeral port pair");
    }
}

/// <summary>A child process with redirected standard streams, killed (whole tree) on dispose.</summary>
internal sealed class ChildProcess : IDisposable
{
    private readonly StringBuilder _stderr = new();
    public Process Process { get; }

    public ChildProcess(string file, IEnumerable<string> args, IDictionary<string, string?>? env = null, bool redirectStdin = false)
    {
        var info = new ProcessStartInfo(file)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = redirectStdin,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = new UTF8Encoding(false),
            StandardErrorEncoding = new UTF8Encoding(false),
        };
        if (redirectStdin) info.StandardInputEncoding = new UTF8Encoding(false);
        foreach (string arg in args) info.ArgumentList.Add(arg);
        foreach (var (name, value) in env ?? new Dictionary<string, string?>())
        {
            if (value is null) info.Environment.Remove(name);
            else info.Environment[name] = value;
        }
        Process = Process.Start(info) ?? throw new InvalidOperationException($"{file} did not start");
        Process.ErrorDataReceived += (_, e) => { if (e.Data is not null) lock (_stderr) _stderr.AppendLine(e.Data); };
        Process.BeginErrorReadLine();
    }

    public string Stderr { get { lock (_stderr) return _stderr.ToString(); } }

    public void Dispose()
    {
        try { if (!Process.HasExited) Process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
        try { Process.WaitForExit(5000); } catch (InvalidOperationException) { }
        Process.Dispose();
    }

    /// <summary>Runs to completion; returns (exit code, stdout, stderr).</summary>
    public static async Task<(int Code, string Stdout, string Stderr)> RunAsync(string file, IEnumerable<string> args,
        IDictionary<string, string?>? env = null, string? stdin = null, int timeoutSeconds = 60)
    {
        using var child = new ChildProcess(file, args, env, redirectStdin: true);
        var stdout = child.Process.StandardOutput.ReadToEndAsync();
        if (stdin is not null) await child.Process.StandardInput.WriteAsync(stdin);
        child.Process.StandardInput.Close();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(timeoutSeconds));
        try { await child.Process.WaitForExitAsync(timeout.Token); }
        catch (OperationCanceledException) { throw new TimeoutException($"{Path.GetFileName(file)} {string.Join(' ', args)} did not exit in {timeoutSeconds} s; stderr={child.Stderr}"); }
        string output = await stdout;
        child.Process.WaitForExit(); // flushes the asynchronous stderr reader
        return (child.Process.ExitCode, output, child.Stderr);
    }
}

/// <summary>
/// HTTP boundary stub of the bridge: answers POST /api/command like the real bridge, records every command except
/// heartbeats. The answer delegate returns the data, or throws to produce {"success": false, "error": message}.
/// </summary>
internal sealed class FakeBridge : IDisposable
{
    public const string Credential = "pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp"; // 64 chars
    private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
    private readonly CancellationTokenSource _stop = new();
    private readonly List<JsonObject> _commands = [];
    private readonly Func<string, JsonObject, JsonNode?> _answer;
    private readonly TempDir _dir = new();
    private int _unauthorized;

    public FakeBridge(Func<string, JsonObject, JsonNode?> answer)
    {
        _answer = answer;
        TokenFile = _dir["bridge-token"];
        File.WriteAllText(TokenFile, Credential, Encoding.ASCII);
        _listener.Start();
        _ = Task.Run(AcceptLoopAsync);
    }

    public int Port => ((IPEndPoint)_listener.LocalEndpoint).Port;
    public string TokenFile { get; }
    public int Unauthorized => Volatile.Read(ref _unauthorized);

    public List<JsonObject> Commands { get { lock (_commands) return _commands.Select(c => (JsonObject)c.DeepClone()).ToList(); } }
    public List<string> Actions => Commands.Select(c => (string)c["action"]!).ToList();

    private async Task AcceptLoopAsync()
    {
        while (!_stop.IsCancellationRequested)
        {
            TcpClient client;
            try { client = await _listener.AcceptTcpClientAsync(_stop.Token); }
            catch (Exception) { return; }
            _ = Task.Run(() => ServeAsync(client));
        }
    }

    private async Task ServeAsync(TcpClient client)
    {
        using var _ = client;
        try
        {
            var stream = client.GetStream();
            var head = new List<byte>();
            var one = new byte[1];
            while (!(head.Count >= 4 && head[^4] == '\r' && head[^3] == '\n' && head[^2] == '\r' && head[^1] == '\n'))
            {
                if (await stream.ReadAsync(one, _stop.Token) == 0) return;
                head.Add(one[0]);
            }
            string[] lines = Encoding.ASCII.GetString(head.ToArray()).Split("\r\n");
            var headers = lines.Skip(1).Where(l => l.Contains(':'))
                .ToDictionary(l => l[..l.IndexOf(':')].Trim().ToLowerInvariant(), l => l[(l.IndexOf(':') + 1)..].Trim());
            int length = headers.TryGetValue("content-length", out var cl) ? int.Parse(cl) : 0;
            var body = new byte[length];
            await stream.ReadExactlyAsync(body, _stop.Token);

            int status = 200;
            JsonObject response;
            if (!headers.TryGetValue("x-nexus-browser-token", out var token) || token != Credential)
            {
                Interlocked.Increment(ref _unauthorized);
                status = 401;
                response = new JsonObject { ["success"] = false, ["error"] = "Authentication required" };
            }
            else
            {
                var request = (JsonObject)JsonNode.Parse(body)!;
                string action = (string)request["action"]!;
                var parameters = request["params"] as JsonObject ?? new JsonObject();
                if (action == "heartbeat")
                    response = new JsonObject { ["success"] = true, ["data"] = new JsonObject() };
                else
                {
                    lock (_commands) _commands.Add((JsonObject)request.DeepClone());
                    try { response = new JsonObject { ["success"] = true, ["data"] = _answer(action, parameters)?.DeepClone() }; }
                    catch (Exception error)
                    {
                        status = 400;
                        response = new JsonObject { ["success"] = false, ["error"] = error.Message };
                    }
                }
            }
            byte[] encoded = Encoding.UTF8.GetBytes(response.ToJsonString());
            string reply = $"HTTP/1.1 {status} {(status == 200 ? "OK" : "Error")}\r\nContent-Type: application/json\r\nContent-Length: {encoded.Length}\r\nConnection: close\r\n\r\n";
            await stream.WriteAsync(Encoding.ASCII.GetBytes(reply));
            await stream.WriteAsync(encoded);
            await stream.FlushAsync();
        }
        catch (Exception ex) when (ex is IOException or SocketException or OperationCanceledException or ObjectDisposedException)
        {
            // A cancelled native request closes its HTTP connection.
        }
    }

    public void Dispose()
    {
        _stop.Cancel();
        _listener.Stop();
        _dir.Dispose();
    }
}

/// <summary>Simulated Chrome extension end of the authenticated WebSocket (nexus-browser/1).</summary>
internal static class FakeExtension
{
    public const string Id = "blcgddmjdkobmgakjffjpgiicjlflgjf";
    public const string Origin = "chrome-extension://" + Id;

    public static async Task<ClientWebSocket> ConnectAsync(int wsPort, string origin = Origin)
    {
        var ws = new ClientWebSocket();
        ws.Options.SetRequestHeader("Origin", origin);
        await ws.ConnectAsync(new Uri($"ws://127.0.0.1:{wsPort}"), TestContext.Current.CancellationToken);
        return ws;
    }

    public static Task SendAsync(WebSocket ws, JsonNode message, CancellationToken ct = default) =>
        ws.SendAsync(Encoding.UTF8.GetBytes(message.ToJsonString()), WebSocketMessageType.Text, true, ct);

    /// <summary>One whole text message, or null on close.</summary>
    public static async Task<string?> ReceiveAsync(WebSocket ws, CancellationToken ct = default)
    {
        var buffer = new byte[16384];
        using var message = new MemoryStream();
        while (true)
        {
            var result = await ws.ReceiveAsync(buffer, ct);
            if (result.MessageType == WebSocketMessageType.Close) return null;
            message.Write(buffer, 0, result.Count);
            if (result.EndOfMessage) return Encoding.UTF8.GetString(message.ToArray());
        }
    }

    /// <summary>Client side of the handshake; asserts the server proof and the signed auth_ok.</summary>
    public static async Task<(string ClientNonce, string ServerNonce, BridgeAuth.Channel Channel)> HandshakeAsync(
        WebSocket ws, string key, string? authMode, string role, string extensionId = Id)
    {
        var ct = TestContext.Current.CancellationToken;
        string clientNonce = BridgeAuth.NewNonce();
        var hello = new JsonObject
        {
            ["type"] = "auth_hello",
            ["protocol"] = BridgeAuth.Protocol,
            ["client_nonce"] = clientNonce,
            ["role"] = role,
            ["extension_id"] = extensionId,
        };
        if (authMode is not null) hello["auth"] = authMode;
        await SendAsync(ws, hello, ct);

        var challenge = (JsonObject)JsonNode.Parse((await ReceiveAsync(ws, ct))!)!;
        string serverNonce = (string)challenge["server_nonce"]!;
        Assert.Equal(BridgeAuth.ServerProof(key, clientNonce, serverNonce, role, extensionId), (string?)challenge["server_proof"]);

        await SendAsync(ws, new JsonObject
        {
            ["type"] = "auth_proof",
            ["client_proof"] = BridgeAuth.ClientProof(key, clientNonce, serverNonce, role, extensionId),
        }, ct);

        var channel = new BridgeAuth.Channel(BridgeAuth.SessionKey(key, clientNonce, serverNonce, role, extensionId), "c2s", "s2c");
        string ok = channel.Open(JsonNode.Parse((await ReceiveAsync(ws, ct))!));
        Assert.True(JsonNode.DeepEquals(new JsonObject { ["type"] = "auth_ok" }, JsonNode.Parse(ok)), ok);
        return (clientNonce, serverNonce, channel);
    }

    /// <summary>Answers every signed command with success; list_tabs gets the given tabs.</summary>
    public static Task RespondAsync(WebSocket ws, BridgeAuth.Channel channel, List<JsonObject> received, Func<JsonObject, JsonNode?> data, CancellationToken ct) =>
        Task.Run(async () =>
        {
            while (!ct.IsCancellationRequested && ws.State == WebSocketState.Open)
            {
                string? raw;
                try { raw = await ReceiveAsync(ws, ct); }
                catch (Exception) { break; }
                if (raw is null) break;
                var command = (JsonObject)JsonNode.Parse(channel.Open(JsonNode.Parse(raw)))!;
                lock (received) received.Add(command);
                var reply = new JsonObject
                {
                    ["requestId"] = command["requestId"]!.DeepClone(),
                    ["success"] = true,
                    ["data"] = data(command),
                };
                try { await SendAsync(ws, channel.Seal(reply.ToJsonString()), ct); }
                catch (Exception) { break; }
            }
        }, ct);
}
