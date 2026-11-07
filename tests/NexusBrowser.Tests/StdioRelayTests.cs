using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using NexusBrowser.Native;
using Xunit;

namespace NexusBrowser.Tests;

/// <summary>--stdio-relay, the Antigravity Marketplace bridge: stdin lines to the shared HTTP service, every reply back on
/// stdout one line each, a JSON-RPC error with the install hint when the service fails. Same behaviour as the former
/// plugin/antigravity/scripts/bridge.ps1.</summary>
public sealed class StdioRelayTests
{
    private static readonly Uri Url = new(StdioRelay.DefaultUrl);

    /// <summary>A fake shared service: records each request (method, headers, body) and answers with the delegate.</summary>
    private sealed class FakeService(Func<HttpRequestMessage, string, HttpResponseMessage> answer) : HttpMessageHandler
    {
        public List<(HttpMethod Method, string? Session, string? Authorization, string? Accept, string Body)> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            string body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken);
            lock (Requests)
                Requests.Add((request.Method,
                    request.Headers.TryGetValues("Mcp-Session-Id", out var s) ? s.Single() : null,
                    request.Headers.TryGetValues("Authorization", out var a) ? a.Single() : null,
                    request.Headers.TryGetValues("Accept", out var x) ? string.Join(", ", x) : null,
                    body));
            return answer(request, body);
        }
    }

    private static HttpResponseMessage Reply(HttpStatusCode status, string body = "", string type = "application/json", string? session = null)
    {
        var response = new HttpResponseMessage(status) { Content = new StringContent(body, new UTF8Encoding(false)) };
        response.Content.Headers.ContentType = new MediaTypeHeaderValue(type);
        if (session is not null) response.Headers.Add("Mcp-Session-Id", session);
        return response;
    }

    private static async Task<(List<string> Lines, string Stderr)> RunAsync(FakeService service, string stdin, string? token = "tok")
    {
        using var output = new MemoryStream();
        using var error = new StringWriter();
        int code = await StdioRelay.RunAsync(new StringReader(stdin), output, error, Url, "NexusBrowser", token, service);
        Assert.Equal(0, code);
        string text = Encoding.UTF8.GetString(output.ToArray());
        Assert.True(text.Length == 0 || text.EndsWith('\n'), text);
        return (text.Split('\n', StringSplitOptions.RemoveEmptyEntries).ToList(), error.ToString());
    }

    [Fact]
    public async Task InitializeOpensTheSessionThenJsonAndEventStreamsComeBackOneLineEachAndTheSessionIsClosed()
    {
        var service = new FakeService((request, body) =>
        {
            if (request.Method == HttpMethod.Delete) return Reply(HttpStatusCode.OK);
            if (body.Contains("\"initialize\"", StringComparison.Ordinal))
                return Reply(HttpStatusCode.OK, "{\r\n  \"jsonrpc\": \"2.0\",\n  \"id\": 1,\n  \"result\": {}\n}\n", session: "s-1");
            if (body.Contains("notifications/initialized", StringComparison.Ordinal)) return Reply(HttpStatusCode.Accepted);
            return Reply(HttpStatusCode.OK, "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\n" +
                "data:{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[]}}\n", "text/event-stream");
        });
        string stdin = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}\n\n   \n" +
                       "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n" +
                       "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n";
        var (lines, stderr) = await RunAsync(service, stdin);

        Assert.Equal("", stderr);
        Assert.Equal(3, lines.Count);
        Assert.Contains("{  \"jsonrpc\": \"2.0\",  \"id\": 1,  \"result\": {}}", lines); // JSON reply flattened to one line
        Assert.Contains("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}", lines); // "data: " and "data:" both read
        Assert.Contains("{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[]}}", lines); // last event without blank line
        var posts = service.Requests.Where(r => r.Method == HttpMethod.Post).ToList();
        Assert.Equal(3, posts.Count); // blank lines are not sent
        Assert.Null(posts[0].Session); // initialize opens the session...
        Assert.All(posts.Skip(1), p => Assert.Equal("s-1", p.Session)); // ...and everything after it carries the id
        Assert.All(posts, p => Assert.Equal("Bearer tok", p.Authorization));
        Assert.All(posts, p => Assert.Equal("application/json, text/event-stream", p.Accept));
        var delete = Assert.Single(service.Requests, r => r.Method == HttpMethod.Delete);
        Assert.Equal("s-1", delete.Session);
        Assert.Equal("Bearer tok", delete.Authorization);
    }

    [Fact]
    public async Task HttpErrorAnswersARequestWithAJsonRpcErrorAndANotificationWithNothing()
    {
        var service = new FakeService((_, _) => Reply(HttpStatusCode.Unauthorized, "denied", "text/plain"));
        var (lines, stderr) = await RunAsync(service,
            "{\"jsonrpc\":\"2.0\",\"id\":\"a-7\",\"method\":\"tools/call\"}\n{\"jsonrpc\":\"2.0\",\"method\":\"notifications/cancelled\"}\nnot json\n[1]\n", token: null);

        var reply = JsonNode.Parse(Assert.Single(lines))!;
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse("""{"jsonrpc":"2.0","id":"a-7","error":{"code":-32000,"message":"NexusBrowser answered HTTP 401."}}"""), reply), reply.ToJsonString());
        Assert.Equal(4, stderr.Split('\n', StringSplitOptions.RemoveEmptyEntries).Count(l => l.Trim() == "NexusBrowser answered HTTP 401."));
        Assert.All(service.Requests, r => Assert.Null(r.Authorization)); // no token: no header
        Assert.DoesNotContain(service.Requests, r => r.Method == HttpMethod.Delete); // no session: nothing to close
    }

    [Fact]
    public async Task UnreachableServiceSaysHowToInstallItAndKeepsTheRequestId()
    {
        var service = new FakeService((_, _) => throw new HttpRequestException("outer", new SocketException((int)SocketError.ConnectionRefused)));
        var (lines, stderr) = await RunAsync(service, "{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"initialize\"}\n{\"jsonrpc\":\"2.0\",\"id\":null,\"method\":\"ping\"}\n");

        Assert.Equal(2, lines.Count);
        var first = JsonNode.Parse(lines[0])!.AsObject();
        Assert.Equal(0, (int)first["id"]!);
        string message = (string)first["error"]!["message"]!;
        Assert.StartsWith("NexusBrowser is not reachable on this PC (", message, StringComparison.Ordinal);
        Assert.DoesNotContain("outer", message, StringComparison.Ordinal); // the innermost cause
        Assert.EndsWith("). Install or start it: ask the agent to follow the NexusBrowser skill.", message, StringComparison.Ordinal);
        var second = JsonNode.Parse(lines[1])!.AsObject();
        Assert.True(second.ContainsKey("id"));
        Assert.Null(second["id"]); // an explicit null id is answered with null, like the former script
        Assert.Contains("is not reachable on this PC", stderr, StringComparison.Ordinal);
    }

    [Fact]
    public async Task NonAsciiTextPassesThroughUnchanged()
    {
        var service = new FakeService((_, body) => Reply(HttpStatusCode.OK, body.Replace("\"method\"", "\"echo\"", StringComparison.Ordinal)));
        var (lines, _) = await RunAsync(service, "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"x\",\"params\":{\"t\":\"Opération réussie ✓\"}}\n");
        Assert.Contains("Opération réussie ✓", Assert.Single(lines), StringComparison.Ordinal);
    }

    [Collection(ProcessEnvironmentCollection.Name)]
    public sealed class Token
    {
        [Fact]
        public void EnvironmentVariableFirstThenTheSharedFile()
        {
            string file = Path.Join(TestEnvironment.Home, ".nexus", "mcp-token.txt");
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            try
            {
                using (new EnvScope(("NEXUS_MCP_TOKEN", null))) Assert.Null(StdioRelay.ResolveToken());
                File.WriteAllText(file, "  from-file \r\n");
                using (new EnvScope(("NEXUS_MCP_TOKEN", null))) Assert.Equal("from-file", StdioRelay.ResolveToken());
                using (new EnvScope(("NEXUS_MCP_TOKEN", "from-env"))) Assert.Equal("from-env", StdioRelay.ResolveToken());
            }
            finally { File.Delete(file); }
        }
    }
}

/// <summary>The real engine and the real Marketplace launcher, as Antigravity starts them: cmd.exe /d /c start.cmd.</summary>
public sealed class StdioRelayProcessTests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    /// <summary>A one-connection-per-request HTTP/1.1 service on 127.0.0.1: answers initialize with a session id, a
    /// DELETE with 200, and records what it received.</summary>
    private sealed class TinyService : IDisposable
    {
        private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
        private readonly CancellationTokenSource _stop = new();
        public List<string> Requests { get; } = [];
        public int Port => ((IPEndPoint)_listener.LocalEndpoint).Port;

        public TinyService()
        {
            _listener.Start();
            _ = Task.Run(LoopAsync);
        }

        private async Task LoopAsync()
        {
            while (!_stop.IsCancellationRequested)
            {
                TcpClient client;
                try { client = await _listener.AcceptTcpClientAsync(_stop.Token); }
                catch (Exception ex) when (ex is OperationCanceledException or SocketException or ObjectDisposedException) { return; }
                _ = Task.Run(() => ServeAsync(client));
            }
        }

        private async Task ServeAsync(TcpClient client)
        {
            using (client)
            {
                var stream = client.GetStream();
                var reader = new StreamReader(stream, new UTF8Encoding(false));
                string head = await reader.ReadLineAsync() ?? "";
                int length = 0;
                string? line;
                var headers = new StringBuilder();
                while (!string.IsNullOrEmpty(line = await reader.ReadLineAsync()))
                {
                    headers.Append(line).Append('\n');
                    if (line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase)) length = int.Parse(line[15..].Trim(), System.Globalization.CultureInfo.InvariantCulture);
                }
                var body = new char[length];
                int read = 0;
                while (read < length) read += await reader.ReadAsync(body.AsMemory(read));
                string request = head + "\n" + headers + "\n" + new string(body);
                lock (Requests) Requests.Add(request);
                string json = head.StartsWith("DELETE", StringComparison.Ordinal) ? "" : "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"serverInfo\":{\"name\":\"fake\"}}}";
                byte[] payload = Encoding.UTF8.GetBytes(json);
                string response = $"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nMcp-Session-Id: proc-1\r\nContent-Length: {payload.Length}\r\nConnection: close\r\n\r\n";
                await stream.WriteAsync(Encoding.ASCII.GetBytes(response));
                await stream.WriteAsync(payload);
            }
        }

        public void Dispose()
        {
            _stop.Cancel();
            _listener.Stop();
            _stop.Dispose();
        }
    }

    private static Dictionary<string, string?> Env(string localAppData) => new()
    {
        ["LOCALAPPDATA"] = localAppData,
        ["NEXUS_MCP_TOKEN"] = "proc-token",
    };

    private static string Launcher => Repo.File("plugin", "antigravity", "scripts", "start.cmd");

    private static string Comspec => Environment.GetEnvironmentVariable("COMSPEC") ?? "cmd.exe";

    // current.json as install-native.ps1 writes it (ConvertTo-Json of a hashtable): Windows PowerShell puts two spaces
    // after the colon, pwsh one; the key order is not fixed.
    private static void WriteCurrentJson(string root, string fingerprint, bool windowsPowerShell)
    {
        string exe = Path.Join(root, "versions", fingerprint[..16], "NexusBrowser.exe").Replace(@"\", @"\\", StringComparison.Ordinal);
        string json = windowsPowerShell
            ? $"{{\r\n    \"exe\":  \"{exe}\",\r\n    \"fingerprint\":  \"{fingerprint}\",\r\n    \"version\":  \"9.9.9\"\r\n}}"
            : $"{{\n  \"version\": \"9.9.9\",\n  \"fingerprint\": \"{fingerprint}\",\n  \"exe\": \"{exe}\"\n}}";
        File.WriteAllText(Path.Join(root, "current.json"), json);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task LauncherRunsTheEngineCurrentJsonNamesWhichRelaysStdioToTheService(bool windowsPowerShell)
    {
        // Installed layout: versions\<build>\NexusBrowser.exe, the build in use named by current.json (the test build,
        // linked in). A newer build folder (not verified yet, or the one a rollback left) and a folder still being copied
        // (.tmp-<pid>) are never run; the profile path has a non-ASCII character.
        string local = _dir[$"lócal-{windowsPowerShell}"];
        string root = Path.Join(local, "NexusBrowser");
        string versions = Directory.CreateDirectory(Path.Join(root, "versions")).FullName;
        string junction = Path.Join(versions, "abcdef0123456789");
        var link = await ChildProcess.RunAsync(Comspec, ["/d", "/c", "mklink", "/J", junction, AppContext.BaseDirectory]);
        Assert.True(link.Code == 0, link.Stdout + link.Stderr);
        try
        {
            WriteCurrentJson(root, "abcdef0123456789" + new string('0', 48), windowsPowerShell);
            Directory.CreateDirectory(Path.Join(versions, "ffffffffffffffff"));
            File.WriteAllText(Path.Join(versions, "ffffffffffffffff", "NexusBrowser.exe"), "newer build, not the one in use");
            Directory.SetLastWriteTimeUtc(Path.Join(versions, "ffffffffffffffff"), DateTime.UtcNow.AddHours(1));
            await RelayThroughLauncherAsync(local, versions);
        }
        finally { Directory.Delete(junction); } // the link only, never the test build behind it
    }

    private static async Task RelayThroughLauncherAsync(string local, string versions)
    {
        using var service = new TinyService();
        Directory.CreateDirectory(Path.Join(versions, "fedcba9876543210.tmp-42"));
        File.WriteAllText(Path.Join(versions, "fedcba9876543210.tmp-42", "NexusBrowser.exe"), "partial copy");

        var (code, stdout, stderr) = await ChildProcess.RunAsync(Comspec,
            ["/d", "/c", Launcher, "--stdio-relay", "--url", $"http://127.0.0.1:{service.Port}/mcp?agent=antigravity", "--product", "NexusBrowser"],
            Env(local), stdin: "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\"}}\n",
            timeoutSeconds: 60);

        Assert.True(code == 0, $"exit {code}; stderr={stderr}");
        Assert.Equal("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"serverInfo\":{\"name\":\"fake\"}}}\n", stdout.Replace("\r\n", "\n", StringComparison.Ordinal));
        List<string> requests;
        lock (service.Requests) requests = [.. service.Requests];
        Assert.StartsWith("POST /mcp?agent=antigravity HTTP/1.1", requests[0], StringComparison.Ordinal);
        Assert.Contains("Authorization: Bearer proc-token", requests[0], StringComparison.Ordinal);
        Assert.EndsWith("\"protocolVersion\":\"2025-06-18\"}}", requests[0], StringComparison.Ordinal);
        Assert.Contains(requests, r => r.StartsWith("DELETE /mcp?agent=antigravity", StringComparison.Ordinal) && r.Contains("Mcp-Session-Id: proc-1", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("none")]
    [InlineData("missing build")]
    public async Task LauncherWithoutTheEngineCurrentJsonNamesSaysHowToInstallIt(string current)
    {
        // Build folders on disk without current.json naming one of them (none, or a build since removed): nothing is run,
        // not even the newest folder, and the install hint is given.
        string local = _dir[$"empty-{current}"];
        string root = Path.Join(local, "NexusBrowser");
        Directory.CreateDirectory(Path.Join(root, "versions", "0123456789abcdef.tmp-7"));
        Directory.CreateDirectory(Path.Join(root, "versions", "fedcba9876543210"));
        File.WriteAllText(Path.Join(root, "versions", "fedcba9876543210", "NexusBrowser.exe"), "build not named by current.json");
        if (current == "missing build") WriteCurrentJson(root, "0011223344556677" + new string('0', 48), windowsPowerShell: true);
        var (code, stdout, stderr) = await ChildProcess.RunAsync(Comspec, ["/d", "/c", Launcher, "--stdio-relay"], Env(local), stdin: "");
        Assert.Equal(1, code);
        Assert.Equal("", stdout);
        Assert.StartsWith("NexusBrowser is not installed on this PC. Ask Antigravity to install it (see the nexus-browser skill)", stderr, StringComparison.Ordinal);
    }

    [Fact]
    public async Task StdioRelayIsNotMistakenForAnotherMode()
    {
        // Without a service the engine still answers the request (JSON-RPC error), then ends with stdin.
        // Port 1 refuses at once and is never handed out: a port probed free could meanwhile be a listener of a parallel
        // test (a FakeBridge), which would receive this relay's request.
        const int deadPort = 1;
        var stopwatch = Stopwatch.StartNew();
        var (code, stdout, stderr) = await ChildProcess.RunAsync(NativeExe.Path, ["--stdio-relay", "--url", $"http://127.0.0.1:{deadPort}/mcp?agent=antigravity"],
            new Dictionary<string, string?> { ["NEXUS_MCP_TOKEN"] = "x" }, stdin: "{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"tools/list\"}\n", timeoutSeconds: 60);
        Assert.Equal(0, code);
        var reply = JsonNode.Parse(stdout)!;
        Assert.Equal(9, (int)reply["id"]!);
        Assert.StartsWith("NexusBrowser is not reachable on this PC (", (string)reply["error"]!["message"]!, StringComparison.Ordinal);
        Assert.Contains("is not reachable", stderr, StringComparison.Ordinal);
        Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(30), stopwatch.Elapsed.ToString());
    }
}
