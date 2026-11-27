using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

namespace NexusBrowser.Native;

/// <summary>
/// The NexusBrowser.exe processes of this PC with their image and role, for the installer (--engine-processes,
/// Installer.cs and scripts\runtime.ps1 Get-EngineProcesses). WMI gives neither the path nor the command line of a process of a higher
/// integrity level (an engine started as administrator), so an older bridge or daemon started that way was never listed:
/// never stopped, and its task started a second instance. Here every process is found by name (any account), then read
/// with PROCESS_QUERY_LIMITED_INFORMATION, which an elevated process of the same user grants: its image by
/// QueryFullProcessImageNameW, its role by its command line (NtQueryInformationProcess, ProcessCommandLineInformation).
/// A process whose command line cannot be read (another account, SYSTEM) is identified by the listening port it owns
/// (GetExtendedTcpTable, readable for any process); otherwise its role is "unknown": the installer then starts no
/// second instance, reports it and stops nothing.
/// </summary>
public static partial class EngineProcesses
{
    public const string Bridge = "bridge", Daemon = "daemon", Other = "other", Unknown = "unknown";
    public const int DaemonPort = 16182;

    /// <summary>One engine process. Image: null when it cannot be read. ReadBy: "command_line", "port" or "none".</summary>
    public sealed record Entry(int Pid, string? Image, string Role, string ReadBy);

    // Flags Program.RunAsync handles before --bridge and --http: a process carrying one of them runs that mode instead.
    private static readonly string[] EarlierModes =
    [
        "--version", "--fingerprint", "--refresh-extension", "--register", "--rotate", "--auth-host", "--engine-processes",
        "--shutdown-bridge", "--restart-daemon", "--stdio-relay", "--install", "--self-update", "--registry-worker",
    ];

    /// <summary>The role Program.RunAsync gives these arguments (argv without the executable): the product's bridge
    /// (--bridge on <paramref name="bridgePort"/>), the shared daemon (--http on <paramref name="daemonPort"/>), or other
    /// (a stdio server, a native host, a tool command, a bridge or daemon on another port such as a test's).</summary>
    public static string RoleOf(IReadOnlyList<string> args, int bridgePort = BridgeServer.DefaultPort, int daemonPort = DaemonPort)
    {
        string[] list = [.. args];
        bool Has(string flag) => list.Contains(flag, StringComparer.OrdinalIgnoreCase);
        if (EarlierModes.Any(Has)) return Other;  // the native-host check only applies without --bridge and --http
        if (Has("--bridge"))
        {
            int port = BridgeServer.DefaultPort;
            if (Program.GetArgValue(list, "--port") is { } p && int.TryParse(p, out int value) && value >= 0 && value < 65535) port = value;
            return port == bridgePort ? Bridge : Other;
        }
        if (Has("--http"))
        {
            int port = DaemonPort;
            if (Program.GetArgValue(list, "--http") is { } p && int.TryParse(p, out int value) && value > 0) port = value;
            return port == daemonPort ? Daemon : Other;
        }
        return Other;
    }

    /// <summary>Every running process called <paramref name="name"/> (this one excepted), read as described above.
    /// Bridge ports: its WebSocket port and the HTTP port above it.</summary>
    public static List<Entry> List(string name = "NexusBrowser", int bridgePort = BridgeServer.DefaultPort, int daemonPort = DaemonPort)
    {
        var entries = new List<Entry>();
        Dictionary<int, HashSet<int>>? listeners = null;
        foreach (var process in Process.GetProcessesByName(name))
        {
            int pid = process.Id;
            process.Dispose();
            if (pid == Environment.ProcessId) continue;
            var read = Read(pid);
            if (read.Exited) continue;
            if (read.CommandLine is { } commandLine)
            {
                entries.Add(new Entry(pid, read.Image, RoleOf(SplitCommandLine(commandLine).Skip(1).ToArray(), bridgePort, daemonPort), "command_line"));
                continue;
            }
            listeners ??= ListeningPorts();
            var ports = listeners.GetValueOrDefault(pid) ?? [];
            string role = ports.Contains(daemonPort) ? Daemon : ports.Contains(bridgePort) || ports.Contains(bridgePort + 1) ? Bridge : Unknown;
            entries.Add(new Entry(pid, read.Image, role, role == Unknown ? "none" : "port"));
        }
        return entries;
    }

    public static JsonObject ToJson(IEnumerable<Entry> entries) => new()
    {
        ["processes"] = new JsonArray([.. entries.Select(e => (JsonNode)new JsonObject
        {
            ["pid"] = e.Pid, ["image"] = e.Image, ["role"] = e.Role, ["read_by"] = e.ReadBy,
        })]),
    };

    /// <summary>--engine-processes [--bridge-port N] [--daemon-port N]: the product's ports by default (tests name theirs).</summary>
    public static int Run(string[] args)
    {
        static int Port(string[] args, string flag, int fallback) =>
            Program.GetArgValue(args, flag) is { } value ? int.TryParse(value, out int port) && port is > 0 and < 65535 ? port : throw new ArgumentException($"{flag} must be a TCP port") : fallback;
        Console.WriteLine(ToJson(List(bridgePort: Port(args, "--bridge-port", BridgeServer.DefaultPort), daemonPort: Port(args, "--daemon-port", DaemonPort))).ToJsonString());
        return 0;
    }

    // ---------------------------------------------------------------------------------------------
    // Listening TCP ports per process (IPv4 and IPv6), readable for every process without privilege
    // ---------------------------------------------------------------------------------------------

    [LibraryImport("iphlpapi.dll")]
    private static partial uint GetExtendedTcpTable(nint table, ref int size, [MarshalAs(UnmanagedType.Bool)] bool order, int family, int tableClass, uint reserved);

    private const int AfInet = 2, AfInet6 = 23, TcpTableOwnerPidListener = 3;
    private const uint ErrorInsufficientBuffer = 122;

    internal static Dictionary<int, HashSet<int>> ListeningPorts()
    {
        var owners = new Dictionary<int, HashSet<int>>();
        // Row layouts: MIB_TCPROW_OWNER_PID (24 bytes, port at 8, pid at 20), MIB_TCP6ROW_OWNER_PID (56 bytes, port at 20, pid at 52).
        foreach (var (family, rowSize, portOffset, pidOffset) in new[] { (AfInet, 24, 8, 20), (AfInet6, 56, 20, 52) })
        {
            int size = 0;
            uint result = GetExtendedTcpTable(0, ref size, false, family, TcpTableOwnerPidListener, 0);
            for (int attempt = 0; attempt < 4 && result == ErrorInsufficientBuffer; attempt++)
            {
                nint table = Marshal.AllocHGlobal(size);
                try
                {
                    result = GetExtendedTcpTable(table, ref size, false, family, TcpTableOwnerPidListener, 0);
                    if (result != 0) continue;
                    int rows = Marshal.ReadInt32(table);
                    for (int i = 0; i < rows; i++)
                    {
                        nint row = table + 4 + i * rowSize;
                        uint raw = (uint)Marshal.ReadInt32(row, portOffset);
                        int port = (int)(((raw & 0xFF) << 8) | ((raw >> 8) & 0xFF));  // network byte order in the low 16 bits
                        int pid = Marshal.ReadInt32(row, pidOffset);
                        if (!owners.TryGetValue(pid, out var set)) owners[pid] = set = [];
                        set.Add(port);
                    }
                }
                finally { Marshal.FreeHGlobal(table); }
            }
        }
        return owners;
    }
}
