using System.Net;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace NexusBrowser.Native;

/// <summary>
/// --stdio-relay: the Antigravity Marketplace copy of the plugin. Antigravity starts plugins over stdio; NexusBrowser
/// runs as one local HTTP service per PC (shared by Claude, Codex and Antigravity) behind the token of
/// ~\.nexus\mcp-token.txt, which a Marketplace plugin cannot name (Antigravity expands only ${PLUGIN_ROOT}). Each
/// JSON-RPC line read on stdin is posted to that service (MCP Streamable HTTP); every reply, JSON or event stream, is
/// written back on stdout, one line each. A request the service cannot answer gets a JSON-RPC error saying how to
/// install or start the product. Replaces the former plugin/antigravity/scripts/bridge.ps1 (same behaviour, no
/// PowerShell, no C# compiled at each start).
/// </summary>
public sealed class StdioRelay
{
    public const string DefaultUrl = "http://127.0.0.1:16182/mcp?agent=antigravity";
    public const string DefaultProduct = "NexusBrowser";

    private static readonly UTF8Encoding Utf8 = new(false);
    private static readonly JsonSerializerOptions Compact = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    private readonly object _gate = new();
    private readonly Stream _output;
    private readonly TextWriter _error;
    private readonly HttpClient _http;
    private readonly Uri _url;
    private readonly string _product;
    private readonly string? _token;
    private volatile string? _session;

    private StdioRelay(Stream output, TextWriter error, HttpClient http, Uri url, string product, string? token)
    {
        _output = output;
        _error = error;
        _http = http;
        _url = url;
        _product = product;
        _token = token;
    }

    /// <summary>The shared Nexus token: NEXUS_MCP_TOKEN, else the file ~\.nexus\mcp-token.txt, else none.</summary>
    public static string? ResolveToken()
    {
        string? token = Environment.GetEnvironmentVariable("NEXUS_MCP_TOKEN");
        if (!string.IsNullOrWhiteSpace(token)) return token;
        string home = Environment.GetEnvironmentVariable("USERPROFILE") is { Length: > 0 } profile
            ? profile
            : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        string file = Path.Join(home, ".nexus", "mcp-token.txt");
        return File.Exists(file) ? File.ReadAllText(file).Trim() : null;
    }

    /// <summary>Relays until stdin ends, then closes the HTTP session. Always returns 0, like the former script.</summary>
    public static async Task<int> RunAsync(TextReader input, Stream output, TextWriter error, Uri url, string product,
        string? token, HttpMessageHandler handler)
    {
        using var http = new HttpClient(handler, disposeHandler: false) { Timeout = Timeout.InfiniteTimeSpan };
        using var stop = new CancellationTokenSource();
        var relay = new StdioRelay(output, error, http, url, product, token);
        var pending = new List<Task>();
        string? line;
        while ((line = await input.ReadLineAsync().ConfigureAwait(false)) is not null)
        {
            if (line.Trim().Length == 0) continue;
            string message = line;
            Task task = Task.Run(() => relay.ForwardAsync(message, stop.Token));
            // The session id comes with the initialize reply: nothing else is sent before it.
            if (relay._session is null && message.Contains("\"initialize\"", StringComparison.Ordinal)) await task.ConfigureAwait(false);
            pending.RemoveAll(t => t.IsCompleted);
            pending.Add(task);
        }
        await Task.WhenAny(Task.WhenAll(pending), Task.Delay(TimeSpan.FromSeconds(5))).ConfigureAwait(false);
        await stop.CancelAsync().ConfigureAwait(false);
        if (relay._session is not null)
        {
            using var bye = new HttpRequestMessage(HttpMethod.Delete, url);
            relay.Authorize(bye);
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            try { using var _ = await http.SendAsync(bye, deadline.Token).ConfigureAwait(false); }
            catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException)
            {
                /* The service is gone or slow: its idle timeout ends the session anyway. */
            }
        }
        return 0;
    }

    private void Authorize(HttpRequestMessage request)
    {
        if (!string.IsNullOrEmpty(_token)) request.Headers.TryAddWithoutValidation("Authorization", "Bearer " + _token);
        if (_session is { } session) request.Headers.TryAddWithoutValidation("Mcp-Session-Id", session);
    }

    private async Task ForwardAsync(string message, CancellationToken ct)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, _url) { Content = new StringContent(message, Utf8, "application/json") };
            request.Headers.TryAddWithoutValidation("Accept", "application/json, text/event-stream");
            Authorize(request);
            using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
            if (response.Headers.TryGetValues("Mcp-Session-Id", out var ids)) foreach (string id in ids) _session = id;
            if (!response.IsSuccessStatusCode && response.StatusCode != HttpStatusCode.Accepted)
            {
                Fail(message, $"{_product} answered HTTP {(int)response.StatusCode}.");
                return;
            }
            string type = response.Content.Headers.ContentType?.MediaType ?? "";
            using var body = new StreamReader(await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false), Utf8);
            if (type.Equals("text/event-stream", StringComparison.OrdinalIgnoreCase))
            {
                var data = new StringBuilder();
                string? row;
                while ((row = await body.ReadLineAsync(ct).ConfigureAwait(false)) is not null)
                {
                    if (row.StartsWith("data:", StringComparison.Ordinal)) data.Append(row.AsSpan(row.Length > 5 && row[5] == ' ' ? 6 : 5));
                    else if (row.Length == 0 && data.Length > 0) { Write(data.ToString()); data.Clear(); }
                }
                if (data.Length > 0) Write(data.ToString());
            }
            else
            {
                string text = (await body.ReadToEndAsync(ct).ConfigureAwait(false)).Trim();
                if (text.Length > 0) Write(text.Replace("\r", "", StringComparison.Ordinal).Replace("\n", "", StringComparison.Ordinal));
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            /* stdin ended and the grace period is over: this request is abandoned, as when the process exits. */
        }
        catch (Exception e) when (Boundary.Recoverable(e))
        {
            Exception root = e;
            while (root.InnerException is not null) root = root.InnerException;
            Fail(message, $"{_product} is not reachable on this PC ({root.Message}). Install or start it: ask the agent to follow the {_product} skill.");
        }
    }

    /// <summary>Reason on stderr; a request (id and method) also gets a JSON-RPC error, a notification nothing.</summary>
    private void Fail(string message, string reason)
    {
        lock (_gate) _error.WriteLine(reason);
        JsonNode? id;
        try
        {
            if (JsonNode.Parse(message) is not JsonObject parsed || !parsed.ContainsKey("id") || !parsed.ContainsKey("method")) return;
            id = parsed["id"]?.DeepClone();
        }
        catch (JsonException) { return; } // not JSON: nothing to answer
        var reply = new JsonObject
        {
            ["jsonrpc"] = "2.0",
            ["id"] = id,
            ["error"] = new JsonObject { ["code"] = -32000, ["message"] = reason },
        };
        Write(reply.ToJsonString(Compact));
    }

    private void Write(string json)
    {
        byte[] bytes = Utf8.GetBytes(json + "\n");
        lock (_gate)
        {
            _output.Write(bytes, 0, bytes.Length);
            _output.Flush();
        }
    }
}
