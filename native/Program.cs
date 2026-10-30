using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace NexusBrowser.Native;

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        try { return await RunAsync(args); }
        catch (Exception error)
        {
            // A failed second daemon must report its occupied port and exit, not open a Windows crash dialog.
            Console.Error.WriteLine($"NexusBrowser: {error.Message}");
            try
            {
                string directory = BridgeSecurity.DefaultDataDir(); Directory.CreateDirectory(directory);
                File.AppendAllText(Path.Combine(directory, "engine.log"), $"{DateTimeOffset.Now:o} pid={Environment.ProcessId} {error}\n", new UTF8Encoding(false));
            }
            catch { }
            return 1;
        }
    }

    private static async Task<int> RunAsync(string[] args)
    {
        // Chrome starts this WinExe through cmd.exe with native-messaging pipes.
        // Attaching its console replaces those inherited handles with CONIN$/CONOUT$,
        // so the host waits forever instead of answering Chrome. Never attach a console:
        // native messaging is binary and MCP stdio must remain JSON-only.
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);

        string? tokenFile = GetArgValue(args, "--token-file");
        string? logFile = GetArgValue(args, "--log-file");
        string? agent = GetArgValue(args, "--agent");

        if (args.Contains("--version", StringComparer.OrdinalIgnoreCase))
        {
            Console.WriteLine(BridgeSecurity.Version);
            return 0;
        }

        if (args.Contains("--fingerprint", StringComparer.OrdinalIgnoreCase))
        {
            Console.WriteLine(RestartRequest.CodeFingerprint());
            return 0;
        }

        if (args.Contains("--refresh-extension", StringComparer.OrdinalIgnoreCase))
        {
            int bridgePort = int.TryParse(GetArgValue(args, "--port"), out int rp) && rp > 0 ? rp : 9225;
            return await ExtensionRefresh.MainAsync(args.Contains("--check-only", StringComparer.OrdinalIgnoreCase),
                GetArgValue(args, "--wait-ready"), tokenFile, bridgePort, GetArgValue(args, "--source-root"));
        }

        if (args.Contains("--register", StringComparer.OrdinalIgnoreCase))
        {
            return ClientRegistration.Run(GetArgValue(args, "--backups"), GetArgValue(args, "--engine-exe"), GetArgValue(args, "--source-root"));
        }

        if (args.Contains("--rotate", StringComparer.OrdinalIgnoreCase))
        {
            BridgeSecurity.RotateToken(tokenFile);
            return 0;
        }

        if (args.Contains("--auth-host", StringComparer.OrdinalIgnoreCase) ||
            (!HasAnyModeFlag(args) && NativeAuthHost.CallerExtensionId(args) is not null))
        {
            return NativeAuthHost.Run(args, tokenFile: tokenFile);
        }

        if (args.Contains("--shutdown-bridge", StringComparer.OrdinalIgnoreCase))
            return await BridgeShutdown.MainAsync(GetArgValue(args, "--expected-pid"), GetArgValue(args, "--wait-seconds"),
                int.TryParse(GetArgValue(args, "--port"), out int shutdownPort) ? shutdownPort : 9225, tokenFile);

        if (args.Contains("--restart-daemon", StringComparer.OrdinalIgnoreCase))
            return await DaemonRestart.MainAsync(GetArgValue(args, "--expected-pid"), GetArgValue(args, "--wait-seconds"),
                int.TryParse(GetArgValue(args, "--port"), out int daemonPort) ? daemonPort : 16182,
                GetArgValue(args, "--mcp-token-file"), GetArgValue(args, "--request-file"), GetArgValue(args, "--target-fingerprint"));

        if (args.Contains("--bridge", StringComparer.OrdinalIgnoreCase))
        {
            logFile ??= Path.Combine(BridgeSecurity.DefaultDataDir(), "bridge.log");
            int port = BridgeServer.DefaultPort;
            if (GetArgValue(args, "--port") is { } pStr && int.TryParse(pStr, out int pVal) && pVal >= 0 && pVal < 65535)
                port = pVal;

            await using var server = new BridgeServer(port: port, tokenFile: tokenFile, logFile: logFile);
            using var cts = new CancellationTokenSource();
            Console.CancelKeyPress += (_, e) =>
            {
                e.Cancel = true;
                cts.Cancel();
            };
            await server.RunForeverAsync(cts.Token);
            return 0;
        }

        if (args.Contains("--http", StringComparer.OrdinalIgnoreCase))
        {
            int httpPort = 16182;
            if (GetArgValue(args, "--http") is { } hpStr && int.TryParse(hpStr, out int hpVal) && hpVal > 0)
                httpPort = hpVal;

            using var mcp = new McpServer(agent: agent, tokenFile: tokenFile);
            using var cts = new CancellationTokenSource();
            Console.CancelKeyPress += (_, e) =>
            {
                e.Cancel = true;
                cts.Cancel();
            };
            await mcp.RunHttpAsync(httpPort, cts.Token);
            return 0;
        }

        // Default or --mcp: stdio MCP server
        using (var mcp = new McpServer(agent: agent, tokenFile: tokenFile))
        {
            using var cts = new CancellationTokenSource();
            Console.CancelKeyPress += (_, e) =>
            {
                e.Cancel = true;
                cts.Cancel();
            };
            await mcp.RunStdioAsync(ct: cts.Token);
        }
        return 0;
    }

    private static bool HasAnyModeFlag(string[] args)
    {
        foreach (var a in args)
        {
            if (a.Equals("--bridge", StringComparison.OrdinalIgnoreCase) ||
                a.Equals("--shutdown-bridge", StringComparison.OrdinalIgnoreCase) ||
                a.Equals("--restart-daemon", StringComparison.OrdinalIgnoreCase) ||
                a.Equals("--mcp", StringComparison.OrdinalIgnoreCase) ||
                a.Equals("--http", StringComparison.OrdinalIgnoreCase) ||
                a.Equals("--rotate", StringComparison.OrdinalIgnoreCase) ||
                a.Equals("--refresh-extension", StringComparison.OrdinalIgnoreCase) ||
                a.Equals("--register", StringComparison.OrdinalIgnoreCase) ||
                a.Equals("--version", StringComparison.OrdinalIgnoreCase) ||
                a.Equals("--fingerprint", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        return false;
    }

    private static string? GetArgValue(string[] args, string flag)
    {
        for (int i = 0; i < args.Length; i++)
        {
            if (string.Equals(args[i], flag, StringComparison.OrdinalIgnoreCase))
            {
                if (i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal))
                    return args[i + 1];
                return null;
            }
            if (args[i].StartsWith(flag + "=", StringComparison.OrdinalIgnoreCase))
            {
                return args[i][(flag.Length + 1)..];
            }
        }
        return null;
    }
}
