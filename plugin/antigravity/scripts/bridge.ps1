# Antigravity Marketplace bridge: Antigravity starts plugins over stdio, Nexus servers run as one local HTTP service
# per PC (shared by Claude, Codex and Antigravity) behind the token of %USERPROFILE%\.nexus\mcp-token.txt, which a
# Marketplace plugin cannot name (Antigravity expands only ${PLUGIN_ROOT}). This relays each JSON-RPC line to that
# service (MCP Streamable HTTP) and writes back every reply, JSON or event stream, one line each.
param(
    [Parameter(Mandatory)][string]$Url,
    [Parameter(Mandatory)][string]$Product
)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Net.Http, System.Web.Extensions -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

public static class NexusStdioBridge
{
    static readonly object Gate = new object();
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
    static Stream stdout;
    static volatile string session;

    public static int Run(string url, string product)
    {
        ServicePointManager.Expect100Continue = false;
        stdout = Console.OpenStandardOutput();
        var stdin = new StreamReader(Console.OpenStandardInput(), Utf8);
        var token = Environment.GetEnvironmentVariable("NEXUS_MCP_TOKEN");
        if (string.IsNullOrWhiteSpace(token))
        {
            var file = Path.Combine(Environment.GetEnvironmentVariable("USERPROFILE") ?? "", ".nexus", "mcp-token.txt");
            token = File.Exists(file) ? File.ReadAllText(file).Trim() : null;
        }
        var http = new HttpClient(new HttpClientHandler { UseProxy = false }) { Timeout = Timeout.InfiniteTimeSpan };
        var pending = new List<Task>();
        string line;
        while ((line = stdin.ReadLine()) != null)
        {
            if (line.Trim().Length == 0) continue;
            var message = line;
            var task = Task.Run(() => Forward(http, url, token, product, message));
            // The session id comes with the initialize reply: nothing else is sent before it.
            if (session == null && message.Contains("\"initialize\"")) task.Wait();
            lock (pending) { pending.RemoveAll(t => t.IsCompleted); pending.Add(task); }
        }
        Task[] left;
        lock (pending) left = pending.ToArray();
        Task.WaitAll(left, TimeSpan.FromSeconds(5));
        if (session != null)
        {
            try
            {
                var bye = new HttpRequestMessage(HttpMethod.Delete, url);
                Authorize(bye, token);
                http.SendAsync(bye).Wait(TimeSpan.FromSeconds(2));
            }
            catch { }
        }
        return 0;
    }

    static void Authorize(HttpRequestMessage request, string token)
    {
        if (!string.IsNullOrEmpty(token)) request.Headers.TryAddWithoutValidation("Authorization", "Bearer " + token);
        if (session != null) request.Headers.TryAddWithoutValidation("Mcp-Session-Id", session);
    }

    static void Forward(HttpClient http, string url, string token, string product, string message)
    {
        try
        {
            var request = new HttpRequestMessage(HttpMethod.Post, url) { Content = new StringContent(message, Utf8, "application/json") };
            request.Headers.TryAddWithoutValidation("Accept", "application/json, text/event-stream");
            Authorize(request, token);
            using (var response = http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead).Result)
            {
                IEnumerable<string> ids;
                if (response.Headers.TryGetValues("Mcp-Session-Id", out ids)) foreach (var id in ids) session = id;
                if (!response.IsSuccessStatusCode && response.StatusCode != HttpStatusCode.Accepted)
                {
                    Fail(message, product + " answered HTTP " + (int)response.StatusCode + ".");
                    return;
                }
                if (response.Content == null) return;
                var type = response.Content.Headers.ContentType == null ? "" : response.Content.Headers.ContentType.MediaType ?? "";
                using (var body = new StreamReader(response.Content.ReadAsStreamAsync().Result, Utf8))
                {
                    if (type.Equals("text/event-stream", StringComparison.OrdinalIgnoreCase))
                    {
                        var data = new StringBuilder();
                        string row;
                        while ((row = body.ReadLine()) != null)
                        {
                            if (row.StartsWith("data:", StringComparison.Ordinal)) data.Append(row.Substring(row.Length > 5 && row[5] == ' ' ? 6 : 5));
                            else if (row.Length == 0 && data.Length > 0) { Write(data.ToString()); data.Clear(); }
                        }
                        if (data.Length > 0) Write(data.ToString());
                    }
                    else
                    {
                        var text = body.ReadToEnd().Trim();
                        if (text.Length > 0) Write(text.Replace("\r", "").Replace("\n", ""));
                    }
                }
            }
        }
        catch (Exception e)
        {
            var root = e is AggregateException && e.InnerException != null ? e.InnerException : e;
            while (root.InnerException != null) root = root.InnerException;
            Fail(message, product + " is not reachable on this PC (" + root.Message + "). Install or start it: ask the agent to follow the " + product + " skill.");
        }
    }

    static void Fail(string message, string reason)
    {
        Console.Error.WriteLine(reason);
        object id = null;
        try
        {
            var parsed = new JavaScriptSerializer().DeserializeObject(message) as Dictionary<string, object>;
            if (parsed == null || !parsed.ContainsKey("id") || !parsed.ContainsKey("method")) return;
            id = parsed["id"];
        }
        catch { return; }
        var reply = new Dictionary<string, object> {
            { "jsonrpc", "2.0" }, { "id", id },
            { "error", new Dictionary<string, object> { { "code", -32000 }, { "message", reason } } }
        };
        Write(new JavaScriptSerializer().Serialize(reply));
    }

    static void Write(string json)
    {
        var bytes = Utf8.GetBytes(json + "\n");
        lock (Gate) { stdout.Write(bytes, 0, bytes.Length); stdout.Flush(); }
    }
}
'@
exit [NexusStdioBridge]::Run($Url, $Product)
