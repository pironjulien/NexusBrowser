using System.Diagnostics;
using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace NexusBrowser.Native;

/// <summary>Requests a restart only from an authenticated daemon that proves it preserves live HTTP sessions.
/// Older daemons are left serving; even if they encounter the new request format, they cannot act on it.</summary>
public static class DaemonRestart
{
    public static async Task<(int Code, JsonObject Report)> RunAsync(HttpClient http, int port, string token, int expectedPid,
        string requestPath, string targetFingerprint, double waitSeconds, Func<int, bool>? processRunning = null, CancellationToken ct = default)
    {
        if (expectedPid <= 0 || port is <= 0 or > 65535 || waitSeconds is <= 0 or > 30 ||
            targetFingerprint.Length != 64 || !targetFingerprint.All(Uri.IsHexDigit)) throw new ArgumentException("A process, port, SHA-256 and wait of at most 30 seconds are required");
        processRunning ??= pid => BridgeSecurity.ProcessRunning(pid);
        bool requested = false;
        JsonObject Report(string message, bool stopped = false) => new()
        {
            ["stopped"] = stopped, ["deferred"] = !stopped, ["requested"] = requested, ["pid"] = expectedPid, ["message"] = message,
        };
        try
        {
            if (token.Length < 32) return (3, Report("Daemon token unavailable; no restart request written."));
            using var request = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{port}/restart-capabilities");
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            using var response = await http.SendAsync(request, ct);
            var state = JsonNode.Parse(await response.Content.ReadAsStringAsync(ct)) as JsonObject;
            if (!response.IsSuccessStatusCode || state?["service"]?.GetValue<string>() != McpServer.ServerName ||
                state["preserve_http_sessions"]?.GetValue<bool>() != true || state["request_schema"]?.GetValue<int>() != 1 ||
                state["pid"]?.GetValue<int>() != expectedPid || state["instance_id"]?.GetValue<string>() is not { Length: 32 } instance || !instance.All(Uri.IsHexDigit))
                return (3, Report("Daemon does not prove session-preserving restart for the expected process; kept until its natural exit, no request written."));
            string temporary = requestPath + ".tmp-" + Guid.NewGuid().ToString("N");
            try
            {
                File.WriteAllText(temporary, $"sessions-v1 code:{targetFingerprint} pid:{expectedPid} instance:{instance}", new UTF8Encoding(false));
                File.Move(temporary, requestPath, overwrite: true);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
            requested = true;
            var clock = Stopwatch.StartNew();
            while (processRunning(expectedPid) && clock.Elapsed.TotalSeconds < waitSeconds) await Task.Delay(100, ct);
            return processRunning(expectedPid)
                ? (3, Report("New build prepared; the daemon keeps every valid HTTP session and admitted response until they finish or expire."))
                : (0, Report("Target daemon exited cooperatively after its sessions and responses finished.", stopped: true));
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or FormatException || ex is OperationCanceledException && !ct.IsCancellationRequested)
        {
            return (3, Report($"Daemon kept without interrupting clients: {ex.Message}"));
        }
    }

    public static async Task<int> MainAsync(string? expectedPid, string? waitSeconds, int port, string? tokenFile, string? requestPath, string? targetFingerprint)
    {
        if (!int.TryParse(expectedPid, out int pid) || tokenFile is null || targetFingerprint is null) throw new ArgumentException("--expected-pid, --mcp-token-file and --target-fingerprint are required");
        double wait = 10;
        if (waitSeconds is not null && !double.TryParse(waitSeconds, NumberStyles.Float, CultureInfo.InvariantCulture, out wait)) throw new ArgumentException("--wait-seconds must be a number");
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        string token = File.Exists(tokenFile) ? File.ReadAllText(tokenFile, Encoding.UTF8).Trim() : "";
        var result = await RunAsync(http, port, token, pid, requestPath ?? RestartRequest.DefaultPath(), targetFingerprint, wait);
        Console.WriteLine(result.Report.ToJsonString());
        return result.Code;
    }
}
