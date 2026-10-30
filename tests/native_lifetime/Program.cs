using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using NexusBrowser.Native;

// Only this disposable WinExe is launched: no Chrome process, profile or user window is used.
internal static class Program
{
    public static int Main(string[] args)
    {
        string folder = AppContext.BaseDirectory;
        string ready = Path.Combine(folder, "parent-ready.json");
        string child = Path.Combine(folder, "child.json");
        try
        {
            if (args.SequenceEqual(new[] { "--test" }))
            {
                RunLifetimeTest(folder, broker: false); // The oracle must catch even ShellExecute=true inheriting.
                return RunLifetimeTest(folder, broker: true);
            }
            if (args.FirstOrDefault() == "--profile-directory=Default")
            {
                Write(child, new { pid = Environment.ProcessId, in_job = InJob() });
                string heartbeat = Path.Combine(folder, "heartbeat");
                var timer = Stopwatch.StartNew();
                while (!File.Exists(Path.Combine(folder, "child.stop")) && timer.Elapsed.TotalSeconds < 30)
                {
                    File.WriteAllText(heartbeat, timer.ElapsedTicks.ToString());
                    Thread.Sleep(50);
                }
                return 0;
            }
            if (args.SequenceEqual(new[] { "--caller" }) || args.SequenceEqual(new[] { "--caller-direct" }))
            {
                var timer = Stopwatch.StartNew();
                while (!File.Exists(Path.Combine(folder, "caller.gate")) && timer.Elapsed.TotalSeconds < 10) Thread.Sleep(10);
                if (!File.Exists(Path.Combine(folder, "caller.gate"))) return 2;
                bool inJob = InJob();
                Func<ProcessStartInfo, bool>? direct = args[0] == "--caller-direct" ? info =>
                {
                    info.UseShellExecute = true;
                    using var process = Process.Start(info);
                    return process is not null;
                } : null;
                bool started = new ChromeLauncher(() => false, () => Environment.ProcessPath, direct).EnsureStarted();
                Write(ready, new { pid = Environment.ProcessId, in_job = inJob, started });
                Thread.Sleep(30_000); // The test closes this fixture's job to prove caller death is harmless.
                return 0;
            }
            return 3;
        }
        catch (Exception error)
        {
            Write(ready, new { error = error.ToString() });
            Console.Error.WriteLine(error);
            return 1;
        }
    }

    private static void Write(string path, object value)
    {
        File.WriteAllText(path + ".tmp", JsonSerializer.Serialize(value));
        File.Move(path + ".tmp", path, true);
    }
    private static bool InJob()
    {
        using var process = Process.GetCurrentProcess();
        if (!IsProcessInJob(process.Handle, 0, out bool inJob)) throw new System.ComponentModel.Win32Exception();
        return inJob;
    }

    private static int RunLifetimeTest(string folder, bool broker)
    {
        string[] files = ["caller.gate", "parent-ready.json", "child.json", "heartbeat", "child.stop"];
        foreach (string file in files) File.Delete(Path.Combine(folder, file));
        nint job = CreateJobObjectW(0, null);
        if (job == 0) throw new System.ComponentModel.Win32Exception();
        Process? child = null; bool callerStarted = false;
        using var caller = new Process { StartInfo = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true } };
        caller.StartInfo.ArgumentList.Add(broker ? "--caller" : "--caller-direct");
        try
        {
            var info = new ExtendedLimits { Basic = new() { LimitFlags = 0x2000 /* KILL_ON_JOB_CLOSE */ } };
            if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf<ExtendedLimits>())) throw new System.ComponentModel.Win32Exception();
            callerStarted = caller.Start();
            if (!callerStarted || !AssignProcessToJobObject(job, caller.Handle)) throw new System.ComponentModel.Win32Exception();
            File.WriteAllText(Path.Combine(folder, "caller.gate"), "assigned");
            Wait(() => File.Exists(Path.Combine(folder, "parent-ready.json")), 10, "Caller did not report launch");
            using var report = JsonDocument.Parse(File.ReadAllText(Path.Combine(folder, "parent-ready.json")));
            if (!report.RootElement.TryGetProperty("in_job", out var inJob) || !inJob.GetBoolean() || !report.RootElement.GetProperty("started").GetBoolean())
                throw new InvalidOperationException("Caller/broker did not launch correctly: " + report.RootElement);
            Wait(() => File.Exists(Path.Combine(folder, "child.json")), 10, "Broker child did not start");
            using var proof = JsonDocument.Parse(File.ReadAllText(Path.Combine(folder, "child.json")));
            child = Process.GetProcessById(proof.RootElement.GetProperty("pid").GetInt32());
            if (!IsProcessInJob(child.Handle, job, out bool inherited) || inherited == broker)
                throw new InvalidOperationException("Unexpected job membership for " + (broker ? "Explorer broker" : "direct ShellExecute control"));
            Wait(() => File.Exists(Path.Combine(folder, "heartbeat")), 3, "Child heartbeat missing");
            string before = File.ReadAllText(Path.Combine(folder, "heartbeat"));
            CloseHandle(job); job = 0; // Only the disposable caller is owned by this kill-on-close job.
            if (!caller.WaitForExit(5000)) throw new InvalidOperationException("Closing the job did not stop the caller");
            if (broker)
            {
                Thread.Sleep(1618);
                if (child.HasExited || File.ReadAllText(Path.Combine(folder, "heartbeat")) == before)
                    throw new InvalidOperationException("User application did not survive caller/job closure");
                File.WriteAllText(Path.Combine(folder, "child.stop"), "normal exit");
                if (!child.WaitForExit(5000) || child.ExitCode != 0) throw new InvalidOperationException("Fixture child did not exit normally");
            }
            else if (!child.WaitForExit(5000)) throw new InvalidOperationException("Direct-launch control survived unexpectedly; oracle cannot reproduce the regression");
            Console.WriteLine(JsonSerializer.Serialize(new { ok = true, broker, caller_in_job = true, child_in_caller_job = inherited, survived_job_close = broker, child_normal_exit = broker }));
            return 0;
        }
        finally
        {
            File.WriteAllText(Path.Combine(folder, "child.stop"), "cleanup");
            if (job != 0) CloseHandle(job);
            if (child is not null) { child.WaitForExit(5000); child.Dispose(); }
            if (callerStarted) { caller.WaitForExit(5000); Console.Error.Write(caller.StandardError.ReadToEnd()); }
        }
    }

    private static void Wait(Func<bool> test, int seconds, string failure)
    {
        var timer = Stopwatch.StartNew();
        while (!test()) { if (timer.Elapsed.TotalSeconds > seconds) throw new TimeoutException(failure); Thread.Sleep(20); }
    }
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits
    {
        public long ProcessTime, JobTime; public uint LimitFlags; public nuint MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit; public nuint Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public nuint ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern nint CreateJobObjectW(nint security, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool SetInformationJobObject(nint job, int informationClass, ref ExtendedLimits info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool AssignProcessToJobObject(nint job, nint process);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(nint handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(nint process, nint job, [MarshalAs(UnmanagedType.Bool)] out bool result);
}
