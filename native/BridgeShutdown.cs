using System.Diagnostics;
using System.Globalization;
using System.Net.Http;
using System.Text;
using System.Text.Json.Nodes;

namespace NexusBrowser.Native;

/// <summary>The installer asks one authenticated bridge instance to exit; it never terminates a process.</summary>
public static class BridgeShutdown
{
    public static async Task<(int Code, JsonObject Report)> RunAsync(HttpClient http, int port, string tokenFile, int expectedPid,
        double waitSeconds, Func<int, bool>? processRunning = null, CancellationToken ct = default)
    {
        if (expectedPid <= 0 || waitSeconds is <= 0 or > 30) throw new ArgumentException("A process id and a wait of at most 30 seconds are required");
        processRunning ??= pid => BridgeSecurity.ProcessRunning(pid);
        var deadline = Stopwatch.StartNew();
        JsonObject Report(string message, bool stopped = false) => new() { ["stopped"] = stopped, ["deferred"] = !stopped, ["pid"] = expectedPid, ["message"] = message };
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{port}/api/status");
            request.Headers.Add(BridgeSecurity.TokenHeader, BridgeSecurity.ReadToken(tokenFile));
            using var status = await http.SendAsync(request, ct);
            var state = JsonNode.Parse(await status.Content.ReadAsStringAsync(ct)) as JsonObject;
            if (!status.IsSuccessStatusCode || state?["cooperative_shutdown"]?.GetValue<bool>() != true ||
                state["pid"]?.GetValue<int>() != expectedPid || state["instance_id"]?.GetValue<string>() is not { Length: > 0 } instance)
                return (3, Report("Running bridge does not support targeted cooperative shutdown; kept until its next natural exit."));
            using var shutdown = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{port}/api/shutdown")
            {
                Content = new StringContent(new JsonObject { ["pid"] = expectedPid, ["instance_id"] = instance }.ToJsonString(), Encoding.UTF8, "application/json"),
            };
            shutdown.Headers.Add(BridgeSecurity.TokenHeader, BridgeSecurity.ReadToken(tokenFile));
            using var result = await http.SendAsync(shutdown, ct);
            if (!result.IsSuccessStatusCode) return (3, Report("Bridge busy or identity changed; kept without interrupting any call or tab."));
            var acknowledged = JsonNode.Parse(await result.Content.ReadAsStringAsync(ct));
            if (acknowledged?["shutdown"]?.GetValue<bool>() != true || acknowledged["pid"]?.GetValue<int>() != expectedPid || acknowledged["instance_id"]?.GetValue<string>() != instance)
                return (3, Report("Bridge did not acknowledge the exact shutdown identity; no process was terminated."));
            while (processRunning(expectedPid) && deadline.Elapsed.TotalSeconds < waitSeconds) await Task.Delay(100, ct);
            return processRunning(expectedPid)
                ? (3, Report("Cooperative shutdown not completed before the deadline; no process was terminated."))
                : (0, Report("Target bridge exited cooperatively.", stopped: true));
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or System.Text.Json.JsonException or InvalidOperationException or OperationCanceledException && !ct.IsCancellationRequested)
        {
            return !processRunning(expectedPid) ? (0, Report("Target bridge already exited.", stopped: true)) : (3, Report($"Bridge kept: {ex.Message}"));
        }
    }

    public static async Task<int> MainAsync(string? expectedPid, string? waitSeconds, int port, string? tokenFile)
    {
        if (!int.TryParse(expectedPid, out int pid)) throw new ArgumentException("--expected-pid is required");
        double wait = 10;
        if (waitSeconds is not null && !double.TryParse(waitSeconds, NumberStyles.Float, CultureInfo.InvariantCulture, out wait)) throw new ArgumentException("--wait-seconds must be a number");
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        var result = await RunAsync(http, port, BridgeSecurity.TokenPath(tokenFile), pid, wait);
        Console.WriteLine(result.Report.ToJsonString());
        return result.Code;
    }
}
