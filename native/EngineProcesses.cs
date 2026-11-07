using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

namespace NexusBrowser.Native;

/// <summary>
/// The NexusBrowser.exe processes of this PC with their image and role, for the installer (--engine-processes,
/// scripts\runtime.ps1 Get-EngineProcesses). WMI gives neither the path nor the command line of a process of a higher
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
        "--shutdown-bridge", "--restart-daemon", "--stdio-relay",
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
    // Process reading
    // ---------------------------------------------------------------------------------------------

    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const int ErrorInvalidParameter = 87;
    private const uint StillActive = 259;
    private const int ProcessCommandLineInformation = 60;
    private const int StatusInfoLengthMismatch = unchecked((int)0xC0000004);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    private static partial nint OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, int pid);

    [LibraryImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CloseHandle(nint handle);

    [LibraryImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetExitCodeProcess(nint process, out uint code);

    [LibraryImport("kernel32.dll", EntryPoint = "QueryFullProcessImageNameW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static unsafe partial bool QueryFullProcessImageName(nint process, uint flags, char* name, ref uint size);

    [LibraryImport("ntdll.dll")]
    private static unsafe partial int NtQueryInformationProcess(nint process, int infoClass, void* info, int length, out int returned);

    [LibraryImport("shell32.dll", EntryPoint = "CommandLineToArgvW", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    private static partial nint CommandLineToArgv(string commandLine, out int count);

    [LibraryImport("kernel32.dll")]
    private static partial nint LocalFree(nint memory);

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeString
    {
        public ushort Length, MaximumLength;
        public nint Buffer;
    }

    /// <summary>Image and command line of a process (null: unreadable); Exited when it is gone.</summary>
    internal static (bool Exited, string? Image, string? CommandLine) Read(int pid)
    {
        nint handle = OpenProcess(ProcessQueryLimitedInformation, false, pid);
        if (handle == 0) return (Marshal.GetLastPInvokeError() == ErrorInvalidParameter, null, null);
        try
        {
            string? image = ImageOf(handle), commandLine = CommandLineOf(handle);
            bool exited = image is null && commandLine is null && GetExitCodeProcess(handle, out uint code) && code != StillActive;
            return (exited, image, commandLine);
        }
        finally { CloseHandle(handle); }
    }

    private static unsafe string? ImageOf(nint handle)
    {
        char* buffer = stackalloc char[32768];
        uint size = 32768;
        return QueryFullProcessImageName(handle, 0, buffer, ref size) ? new string(buffer, 0, (int)size) : null;
    }

    private static unsafe string? CommandLineOf(nint handle)
    {
        int length = 4096;
        for (int attempt = 0; attempt < 4; attempt++)
        {
            byte[] buffer = new byte[length];
            fixed (byte* data = buffer)
            {
                int status = NtQueryInformationProcess(handle, ProcessCommandLineInformation, data, buffer.Length, out int returned);
                if (status == StatusInfoLengthMismatch && returned > length) { length = returned; continue; }
                if (status < 0) return null;
                var text = *(UnicodeString*)data;
                return text.Buffer == 0 ? "" : new string((char*)text.Buffer, 0, text.Length / 2);
            }
        }
        return null;
    }

    /// <summary>argv as Windows splits it (CommandLineToArgvW), the executable first.</summary>
    internal static string[] SplitCommandLine(string commandLine)
    {
        if (string.IsNullOrWhiteSpace(commandLine)) return [];
        nint argv = CommandLineToArgv(commandLine, out int count);
        if (argv == 0) return [];
        try
        {
            var args = new string[count];
            for (int i = 0; i < count; i++) args[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i * IntPtr.Size)) ?? "";
            return args;
        }
        finally { LocalFree(argv); }
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
