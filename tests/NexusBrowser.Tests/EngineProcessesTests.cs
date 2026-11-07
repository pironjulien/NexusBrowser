using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Win32.SafeHandles;
using NexusBrowser.Native;
using Xunit;

namespace NexusBrowser.Tests;

/// <summary>
/// The installer's view of running bridges and daemons (native\EngineProcesses.cs, --engine-processes;
/// scripts\runtime.ps1 Get-EngineProcesses and Split-EngineProcesses), on real NexusBrowser.exe processes: read by
/// their command line, by the port they own when that cannot be read (a process this account may not query, like an
/// engine running as SYSTEM or another user), "unknown" otherwise, never taken for nothing. WMI gave neither path nor
/// command line for an elevated engine, so an older bridge or daemon started as administrator was never listed.
/// </summary>
public sealed partial class EngineProcessesTests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    private static string S(int value) => value.ToString(CultureInfo.InvariantCulture);

    [Theory]
    [InlineData("--bridge", "bridge")]
    [InlineData("--bridge --token-file t --log-file l", "bridge")]
    [InlineData("--bridge --port 9224", "bridge")]
    [InlineData("--bridge --port 0", "other")]
    [InlineData("--bridge --port 4000", "other")]
    [InlineData("--http 16182", "daemon")]
    [InlineData("--http", "daemon")]
    [InlineData("--http=16182", "other")]  // Program matches the --http token only: a stdio server
    [InlineData("--http 4001", "other")]
    [InlineData("--shutdown-bridge --expected-pid 4", "other")]
    [InlineData("--version --bridge", "other")]
    [InlineData("--engine-processes --bridge-port 9224", "other")]
    [InlineData("--mcp --agent claude", "other")]
    [InlineData("", "other")]
    public void TheRoleIsTheModeTheEngineRuns(string args, string role) =>
        Assert.Equal(role, EngineProcesses.RoleOf(args.Split(' ', StringSplitOptions.RemoveEmptyEntries)));

    [Fact]
    public void ACommandLineIsSplitAsWindowsDoes() =>
        Assert.Equal([@"C:\Program Files\N\NexusBrowser.exe", "--bridge", "--token-file", @"C:\a b\t"],
            EngineProcesses.SplitCommandLine(@"""C:\Program Files\N\NexusBrowser.exe"" --bridge --token-file ""C:\a b\t"""));

    [Fact]
    public void ListeningPortsNameTheirOwner()
    {
        using var listener = new TcpListener(System.Net.IPAddress.Loopback, 0);
        listener.Start();
        int port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
        Assert.Contains(port, EngineProcesses.ListeningPorts()[Environment.ProcessId]);
    }

    // ---------------------------------------------------------------------------------------------
    // Real engines
    // ---------------------------------------------------------------------------------------------

    private Dictionary<string, string?> Env() => new()
    {
        ["NEXUS_BROWSER_TOKEN_FILE"] = _dir["bridge-token"],
        ["NEXUS_JOURNAL_HOME"] = _dir["journal"],
        ["NEXUS_SHARED_HOME"] = _dir["shared"],
        ["NEXUS_STATUS_DIR"] = _dir["status"],
        ["NEXUS_MCP_TOKEN"] = new string('e', 64),
    };

    private ChildProcess StartBridge(int port) => new(NativeExe.Path,
        ["--bridge", "--port", S(port), "--token-file", _dir["bridge-token"], "--log-file", _dir[$"bridge-{Guid.NewGuid():N}.log"]], Env());

    /// <summary>Waits until the process listens on <paramref name="port"/> (0: on any port), read in the TCP table.</summary>
    private static async Task<int> ListeningAsync(ChildProcess child, int port = 0)
    {
        var clock = Stopwatch.StartNew();
        while (clock.Elapsed < TimeSpan.FromSeconds(20))
        {
            Assert.False(child.Process.HasExited, $"engine exited: {child.Stderr}");
            if (EngineProcesses.ListeningPorts().GetValueOrDefault(child.Process.Id) is { Count: > 0 } ports && (port == 0 || ports.Contains(port)))
                return port == 0 ? ports.Min() : port;
            await Task.Delay(50, TestContext.Current.CancellationToken);
        }
        throw new TimeoutException($"engine {child.Process.Id} does not listen; stderr={child.Stderr}");
    }

    private static async Task<JsonObject> CommandAsync(int bridgePort, int daemonPort)
    {
        var (code, stdout, stderr) = await ChildProcess.RunAsync(NativeExe.Path,
            ["--engine-processes", "--bridge-port", S(bridgePort), "--daemon-port", S(daemonPort)]);
        Assert.True(code == 0, stdout + stderr);
        return JsonNode.Parse(stdout)!.AsObject();
    }

    private static JsonObject? Entry(JsonObject list, int pid) =>
        list["processes"]!.AsArray().Select(p => p!.AsObject()).SingleOrDefault(p => (int)p["pid"]! == pid);

    [Fact]
    public async Task RunningBridgeAndDaemonAreListedWithTheirRoleAndImage()
    {
        // One at a time: a free port probed before the previous engine binds could be the one it takes.
        int bridgePort = Ports.FreePair();
        using var bridge = StartBridge(bridgePort);
        await ListeningAsync(bridge, bridgePort);
        int daemonPort = Ports.Free();
        using var daemon = new ChildProcess(NativeExe.Path, ["--http", S(daemonPort)], Env());
        await ListeningAsync(daemon, daemonPort);
        using var other = StartBridge(0);  // a bridge on another port (a test's): not the product's bridge
        await ListeningAsync(other);

        var list = await CommandAsync(bridgePort, daemonPort);
        foreach (var (child, role) in new[] { (bridge, "bridge"), (daemon, "daemon"), (other, "other") })
        {
            var entry = Entry(list, child.Process.Id) ?? throw new Xunit.Sdk.XunitException($"pid {child.Process.Id} not listed: {list}");
            Assert.Equal(role, (string?)entry["role"]);
            Assert.Equal("command_line", (string?)entry["read_by"]);
            Assert.Equal(Path.GetFullPath(NativeExe.Path), (string?)entry["image"], ignoreCase: true);
        }

        // The installer's split of that very output: the bridge of another build is shut down, this build's is kept.
        string runtime = Shells.Quote(Repo.File("scripts", "runtime.ps1")), exe = Shells.Quote(NativeExe.Path);
        string ports = $"@('--bridge-port', '{bridgePort}', '--daemon-port', '{daemonPort}')";
        string script = _dir["split.ps1"];
        File.WriteAllText(script, $"$ErrorActionPreference = 'Stop'\n. {runtime}\n$p = Get-EngineProcesses {exe} {ports}\n" +
            $"$s = Split-EngineProcesses $p 'bridge' {exe}; \"$(@($s.Others).Count) $(@($s.Unknown).Count) $(@($s.Instances | ForEach-Object pid) -join ',')\"\n" +
            $"$s = Split-EngineProcesses $p 'bridge' 'C:\\elsewhere\\NexusBrowser.exe'; \"$(@($s.Others | ForEach-Object pid) -join ',')\"\n" +
            $"$s = Split-EngineProcesses $p 'daemon' 'C:\\elsewhere\\NexusBrowser.exe'; \"$(@($s.Others | ForEach-Object pid) -join ',')\"\n", Encoding.ASCII);
        var (code, stdout, stderr) = await Shells.FileAsync(Shells.Pwsh, script, timeoutSeconds: 120);
        Assert.True(code == 0, stdout + stderr);
        Assert.Equal([$"0 0 {bridge.Process.Id}", S(bridge.Process.Id), S(daemon.Process.Id)], Shells.Lines(stdout));
    }

    /// <summary>Removes every access to the process for this account (a protected, empty DACL): like an engine of
    /// another account or SYSTEM, it can no longer be opened, even with PROCESS_QUERY_LIMITED_INFORMATION. The handle
    /// already held by the test keeps its rights (to stop it).</summary>
    private static unsafe void Lock(Process process)
    {
        const int SeKernelObject = 6;
        const uint DaclInformation = 0x4, ProtectedDaclInformation = 0x80000000;
        var acl = new RawAcl(GenericAcl.AclRevision, 0);  // no entry: nobody is granted anything
        byte[] binary = new byte[acl.BinaryLength];
        acl.GetBinaryForm(binary, 0);
        fixed (byte* dacl = binary)
        {
            uint error = SetSecurityInfo(process.SafeHandle, SeKernelObject, DaclInformation | ProtectedDaclInformation, 0, 0, (nint)dacl, 0);
            Assert.True(error == 0, $"SetSecurityInfo: {error}");
        }
        // SYSTEM (or an account with SeDebugPrivilege enabled) opens any process: nothing is unreadable for it.
        Assert.SkipWhen(EngineProcesses.Read(process.Id).Image is not null, "this account reads every process (SeDebugPrivilege)");
        Assert.Equal((false, (string?)null, (string?)null), EngineProcesses.Read(process.Id));
    }

    [LibraryImport("advapi32.dll")]
    private static partial uint SetSecurityInfo(SafeProcessHandle handle, int objectType, uint securityInfo, nint owner, nint group, nint dacl, nint sacl);

    [Fact]
    public async Task AnEngineThatCannotBeReadIsFoundByItsPortElseCountedAsUnknown()
    {
        using var bridge = StartBridge(0);
        int bridgePort = await ListeningAsync(bridge);
        int daemonPort = Ports.Free();
        Lock(bridge.Process);

        // Owner of the bridge's port: a bridge whose image is unknown, never taken for an older build.
        var entry = Entry(await CommandAsync(bridgePort, daemonPort), bridge.Process.Id) ?? throw new Xunit.Sdk.XunitException("unreadable bridge not listed");
        Assert.Equal("bridge", (string?)entry["role"]);
        Assert.Equal("port", (string?)entry["read_by"]);
        Assert.Null((string?)entry["image"]);

        // Owner of no product port: role unknown. The installer starts no second bridge or daemon and stops nothing.
        var list = await CommandAsync(Ports.FreePair(), daemonPort);
        entry = Entry(list, bridge.Process.Id) ?? throw new Xunit.Sdk.XunitException("unreadable engine not listed");
        Assert.Equal("unknown", (string?)entry["role"]);
        Assert.Equal("none", (string?)entry["read_by"]);

        string script = _dir["unknown.ps1"];
        string json = _dir["list.json"];
        File.WriteAllText(json, list.ToJsonString());
        File.WriteAllText(script, $"$ErrorActionPreference = 'Stop'\n. {Shells.Quote(Repo.File("scripts", "runtime.ps1"))}\n" +
            $"$p = @((Get-Content -LiteralPath {Shells.Quote(json)} -Raw | ConvertFrom-Json).processes)\n" +
            "foreach ($role in 'bridge', 'daemon') {\n" +
            "  $s = Split-EngineProcesses $p $role 'C:\\elsewhere\\NexusBrowser.exe'\n" +
            $"  $u = @($s.Unknown | Where-Object pid -eq {bridge.Process.Id})\n" +
            "  \"$(@($s.Others | Where-Object pid -eq " + S(bridge.Process.Id) + ").Count) $($u.Count) $(Test-TaskStart 'Ready' $s.Instances.Count) $(Format-UnreadEngine $u[0] $role)\"\n" +
            "}\n", Encoding.ASCII);
        var (code, stdout, stderr) = await Shells.FileAsync(Shells.Pwsh, script, timeoutSeconds: 120);
        Assert.True(code == 0, stdout + stderr);
        string[] lines = Shells.Lines(stdout);
        Assert.Equal(2, lines.Length);
        Assert.StartsWith($"0 1 False NexusBrowser.exe {bridge.Process.Id}: role unreadable", lines[0]);
        Assert.StartsWith($"0 1 False NexusBrowser.exe {bridge.Process.Id}: role unreadable", lines[1]);
        Assert.True(EngineProcesses.Read(bridge.Process.Id) is (false, null, null));
        Assert.False(bridge.Process.HasExited);  // nothing stopped
    }

    // ---------------------------------------------------------------------------------------------
    // Elevated engine read by a standard (medium integrity) installer: runs when the tests run as administrator
    // (GitHub's Windows runners), skipped otherwise.
    // ---------------------------------------------------------------------------------------------

    [Fact]
    public async Task AnElevatedEngineIsReadByAStandardInstaller()
    {
        Assert.SkipUnless(Environment.IsPrivilegedProcess, "needs an elevated test run: the engine started here is the elevated one");
        int bridgePort = Ports.FreePair(), daemonPort = Ports.Free();
        using var bridge = StartBridge(bridgePort);  // inherits this elevated token
        await ListeningAsync(bridge, bridgePort);

        string output = _dir["medium.json"];
        int code = MediumIntegrity.Run($"\"{NativeExe.Path}\" --engine-processes --bridge-port {bridgePort} --daemon-port {daemonPort}", output);
        string text = File.ReadAllText(output);
        Assert.True(code == 0, text);
        var entry = Entry(JsonNode.Parse(text)!.AsObject(), bridge.Process.Id) ?? throw new Xunit.Sdk.XunitException($"elevated bridge not listed: {text}");
        Assert.Equal("bridge", (string?)entry["role"]);
        Assert.Equal("command_line", (string?)entry["read_by"]);
        Assert.Equal(Path.GetFullPath(NativeExe.Path), (string?)entry["image"], ignoreCase: true);
    }

    /// <summary>Runs a command line with this account's token reduced to a standard user's at medium integrity (SAFER
    /// "normal user" level, the token of a non-elevated session), standard output and error to a file, no window.</summary>
    private static partial class MediumIntegrity
    {
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
        private struct ProcessInformation { public nint hProcess, hThread; public int dwProcessId, dwThreadId; }

        [StructLayout(LayoutKind.Sequential)]
        private struct SidAndAttributes { public nint Sid; public uint Attributes; }

        [LibraryImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static partial bool SaferCreateLevel(uint scope, uint level, uint flags, out nint handle, nint reserved);

        [LibraryImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static partial bool SaferComputeTokenFromLevel(nint level, nint inToken, out nint outToken, uint flags, nint reserved);

        [LibraryImport("advapi32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static partial bool SaferCloseLevel(nint handle);

        [LibraryImport("advapi32.dll", EntryPoint = "ConvertStringSidToSidW", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static partial bool ConvertStringSidToSid(string sid, out nint result);

        [LibraryImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static partial bool SetTokenInformation(nint token, int infoClass, ref SidAndAttributes info, int length);

        [LibraryImport("advapi32.dll", EntryPoint = "CreateProcessAsUserW", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static partial bool CreateProcessAsUser(nint token, string? application, ref char commandLine, nint processAttributes, nint threadAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint creationFlags, nint environment, string? currentDirectory, ref StartupInfo startup, out ProcessInformation info);

        [LibraryImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static partial bool SetHandleInformation(SafeFileHandle handle, uint mask, uint flags);

        [LibraryImport("kernel32.dll")]
        private static partial uint WaitForSingleObject(nint handle, uint milliseconds);

        [LibraryImport("kernel32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static partial bool GetExitCodeProcess(nint process, out uint code);

        [LibraryImport("kernel32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static partial bool CloseHandle(nint handle);

        [LibraryImport("kernel32.dll")]
        private static partial nint LocalFree(nint memory);

        public static int Run(string commandLine, string outputFile)
        {
            const uint SaferScopeUser = 2, SaferLevelNormalUser = 0x20000, SaferLevelOpen = 1, StartfUseStdHandles = 0x100;
            const uint CreateNoWindow = 0x08000000, HandleFlagInherit = 1, SeGroupIntegrity = 0x20;
            const int TokenIntegrityLevel = 25;
            if (!SaferCreateLevel(SaferScopeUser, SaferLevelNormalUser, SaferLevelOpen, out nint level, 0)) throw new Win32Exception();
            nint token = 0, sid = 0;
            try
            {
                if (!SaferComputeTokenFromLevel(level, 0, out token, 0, 0)) throw new Win32Exception();
                if (!ConvertStringSidToSid("S-1-16-8192", out sid)) throw new Win32Exception();  // medium integrity
                var label = new SidAndAttributes { Sid = sid, Attributes = SeGroupIntegrity };
                if (!SetTokenInformation(token, TokenIntegrityLevel, ref label, Marshal.SizeOf<SidAndAttributes>() + 4)) throw new Win32Exception();
                using var output = File.Open(outputFile, FileMode.Create, FileAccess.Write, FileShare.ReadWrite);
                if (!SetHandleInformation(output.SafeFileHandle, HandleFlagInherit, HandleFlagInherit)) throw new Win32Exception();
                nint handle = output.SafeFileHandle.DangerousGetHandle();
                var startup = new StartupInfo { cb = Marshal.SizeOf<StartupInfo>(), dwFlags = (int)StartfUseStdHandles, hStdOutput = handle, hStdError = handle };
                char[] buffer = (commandLine + '\0').ToCharArray();
                if (!CreateProcessAsUser(token, null, ref buffer[0], 0, 0, true, CreateNoWindow, 0, null, ref startup, out var info)) throw new Win32Exception();
                try
                {
                    if (WaitForSingleObject(info.hProcess, 60_000) != 0) throw new TimeoutException("medium-integrity reader did not exit");
                    return GetExitCodeProcess(info.hProcess, out uint code) ? (int)code : -1;
                }
                finally { CloseHandle(info.hThread); CloseHandle(info.hProcess); }
            }
            finally
            {
                if (sid != 0) LocalFree(sid);
                if (token != 0) CloseHandle(token);
                SaferCloseLevel(level);
            }
        }
    }
}
