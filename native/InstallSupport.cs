using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Xml.Linq;

namespace NexusBrowser.Native;

/// <summary>
/// Where NexusBrowser lives on this PC, outside OneDrive: data in ~\.nexus\nexus-browser (token, logs, captures,
/// exports), immutable engine builds in %LOCALAPPDATA%\NexusBrowser\versions\&lt;fingerprint&gt;, the one in use named by
/// current.json, the published package (extension folder Chrome loads, plugin, guide) in %LOCALAPPDATA%\NexusBrowser\app.
/// Every path is a contract read by NexusSystem's maintenance (current.json, versions, app) and by older engines.
/// </summary>
internal sealed record InstallLayout(string NativeRoot, string Home)
{
    public static InstallLayout ForUser() =>
        new(Path.Join(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NexusBrowser"), BridgeSecurity.HomeDir());

    public string App => Path.Join(NativeRoot, "app");
    public string Versions => Path.Join(NativeRoot, "versions");
    public string CurrentFile => Path.Join(NativeRoot, "current.json");
    public string CacheReceipt => Path.Join(NativeRoot, "release-cache.json");
    public string UpdateLock => Path.Join(NativeRoot, "update.lock");
    public string LegacyEngineFolder => Path.Join(NativeRoot, "native");
    public string Updaters => Path.Join(NativeRoot, "updaters");
    public string LocalRoot => Path.Join(Home, ".nexus", "nexus-browser");
    public string TokenFile => Path.Join(LocalRoot, "bridge-token");
    public string Journal => Path.Join(LocalRoot, "install.log");
    public string Backups => Path.Join(LocalRoot, "backups");
    public string DaemonSpec => Path.Join(Home, ".nexus", "daemons", "specs", "nexus-browser.json");
    public string RestartRequest => Path.Join(LocalRoot, "daemon-restart.request");
    public string NativeHostFolder => Path.Join(LocalRoot, "native-host");
}

/// <summary>Scheduled task names. Engines before 2.35.12 start their bridge and update task by the names written with
/// a space: the installer keeps the set the installed engine calls (a rollback to such an engine included) and renames
/// or removes the other set, so one task per role, never two bridges or daemons.</summary>
internal static class TaskNames
{
    public const string Bridge = "NexusBrowser Bridge", Daemon = "NexusBrowser MCP", Update = "NexusBrowser Update";
    public const string LegacyBridge = "Nexus Browser Bridge", LegacyDaemon = "Nexus Browser MCP", LegacyUpdate = "Nexus Browser Update";
    public const string Supervisor = "Nexus MCP Daemons";
    public const string NexusAgyBridge = "NexusAGY Browser Bridge";
    private static readonly Version Since = new(2, 35, 12);

    public sealed record Set(string Bridge, string Daemon, string Update)
    {
        public IEnumerable<(string Role, string Name)> Roles => [("Bridge", Bridge), ("Daemon", Daemon), ("Update", Update)];
    }

    public static readonly Set Current = new(Bridge, Daemon, Update);
    public static readonly Set Legacy = new(LegacyBridge, LegacyDaemon, LegacyUpdate);

    /// <summary>The set the engine of this version calls (Keep) and the other one (Retire).</summary>
    public static (Set Keep, Set Retire) For(string engineVersion) =>
        Version.TryParse(engineVersion, out var version) && version < Since ? (Legacy, Current) : (Current, Legacy);

    /// <summary>Per role, a task under the other set's name only is renamed (same action, trigger, principal,
    /// settings and disabled state), and removed when the kept name already exists.</summary>
    public static List<(string Role, bool Rename, string From, string To)> Migration(string engineVersion, IReadOnlyCollection<string> existing)
    {
        var (keep, retire) = For(engineVersion);
        var steps = new List<(string, bool, string, string)>();
        foreach (var ((role, kept), (_, retired)) in keep.Roles.Zip(retire.Roles))
        {
            if (!existing.Contains(retired)) continue;
            steps.Add((role, !existing.Contains(kept), retired, kept));
        }
        return steps;
    }

    /// <summary>A bridge or daemon kept by a deferred update may run outside its task (renamed meanwhile): a task is
    /// started only when it is neither running nor disabled and no instance of its role runs.</summary>
    public static bool ShouldStart(string state, int runningInstances) => state is not ("Running" or "Disabled" or "Absent") && runningInstances == 0;
}

/// <summary>SHA-256 digest of a whole payload folder: one "relative/path:sha256" line per file, in the order
/// PowerShell's Sort-Object FullName gives (current culture, case-insensitive), so it equals what
/// scripts\payload-integrity.ps1 computes (installers up to 2.35.32 bind a rollback with that script). A reparse
/// point anywhere is refused: a payload never reaches outside its folder.</summary>
internal static class PayloadDigest
{
    public static string Compute(string folder)
    {
        string root = Path.GetFullPath(folder).TrimEnd('\\');
        if ((File.GetAttributes(root) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Payload root must not be a reparse point.");
        var entries = new DirectoryInfo(root).EnumerateFileSystemInfos("*", new EnumerationOptions
        { RecurseSubdirectories = true, AttributesToSkip = 0, IgnoreInaccessible = false, ReturnSpecialDirectories = false }).ToList();
        if (entries.Any(e => (e.Attributes & FileAttributes.ReparsePoint) != 0)) throw new InvalidDataException("Payload contains a reparse point.");
        var comparer = StringComparer.Create(CultureInfo.CurrentCulture, ignoreCase: true);
        var lines = entries.OfType<FileInfo>().OrderBy(f => f.FullName, comparer).Select(f =>
        {
            using var stream = f.OpenRead();
            return f.FullName[(root.Length + 1)..].Replace('\\', '/') + ":" + Convert.ToHexStringLower(SHA256.HashData(stream));
        });
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join("\n", lines))));
    }
}

/// <summary>Image paths of running processes, read by QueryFullProcessImageNameW (an elevated process of the same
/// user included). Unknown: one of them runs but cannot be read at all; callers then keep every folder.</summary>
internal sealed record ProcessImages(IReadOnlyList<string> Paths, bool Unknown)
{
    public static readonly ProcessImages None = new([], false);

    public static ProcessImages Read(params string[] names)
    {
        var paths = new List<string>();
        bool unknown = false;
        foreach (string name in names)
        {
            foreach (var process in Process.GetProcessesByName(name))
            {
                int pid = process.Id;
                process.Dispose();
                if (pid == Environment.ProcessId) continue;
                var read = EngineProcesses.Read(pid);
                if (read.Exited) continue;
                if (read.Image is null) unknown = true; else paths.Add(read.Image);
            }
        }
        return new ProcessImages(paths, unknown);
    }
}

/// <summary>
/// One immutable folder per engine build, &lt;versions&gt;\&lt;first 16 characters of its fingerprint&gt;, never written
/// again: a release engine is a .NET single file that reads its own executable for each assembly on first use, so an
/// engine in use must never see its file renamed or replaced under it (NexusFree 1.3.3). Older folders go only once no
/// engine runs from them.
/// </summary>
internal static class EngineBuilds
{
    public sealed record Build(string Directory, string Fingerprint, bool New)
    {
        public string Exe => Path.Join(Directory, "NexusBrowser.exe");
    }

    /// <summary>Same value as the engine's RestartRequest.CodeFingerprint: its main assembly (framework-dependent build)
    /// or the single-file executable (release build).</summary>
    public static string Fingerprint(string folder)
    {
        string dll = Path.Join(folder, "NexusBrowser.dll");
        using var stream = File.OpenRead(File.Exists(dll) ? dll : Path.Join(folder, "NexusBrowser.exe"));
        return Convert.ToHexStringLower(SHA256.HashData(stream));
    }

    /// <summary>Installs a build once. An incomplete leftover (no executable) is replaced; an existing folder whose
    /// engine does not match the fingerprint is refused, never run or overwritten.</summary>
    public static Build Install(string candidate, string versions)
    {
        string fingerprint = Fingerprint(candidate);
        string directory = Path.Join(versions, fingerprint[..16]);
        bool isNew = !File.Exists(Path.Join(directory, "NexusBrowser.exe"));
        if (isNew)
        {
            string staging = $"{directory}.tmp-{Environment.ProcessId}";
            if (System.IO.Directory.Exists(staging)) System.IO.Directory.Delete(staging, recursive: true);
            CopyTree(candidate, staging, null);
            File.WriteAllText(Path.Join(staging, EngineLock.FileName), "");  // held by each engine run from here
            if (System.IO.Directory.Exists(directory)) System.IO.Directory.Delete(directory, recursive: true);  // incomplete leftover
            Installer.MoveStaged(staging, directory, Thread.Sleep);  // waits out a scanner briefly holding the fresh engine
        }
        if (!string.Equals(Fingerprint(directory), fingerprint, StringComparison.Ordinal))
            throw new InvalidDataException($"Installed build cache does not match the verified payload: {directory}. It was not executed or overwritten.");
        // A build installed before 2.35.26 gets its lock file (a new empty file: nothing an engine reads changes).
        string lockFile = Path.Join(directory, EngineLock.FileName);
        if (!File.Exists(lockFile)) File.WriteAllText(lockFile, "");
        return new Build(directory, fingerprint, isNew);
    }

    /// <summary>Copies a folder tree (subfolders named in <paramref name="skip"/> left out).</summary>
    public static void CopyTree(string from, string to, ISet<string>? skip)
    {
        System.IO.Directory.CreateDirectory(to);
        foreach (string file in System.IO.Directory.EnumerateFiles(from)) File.Copy(file, Path.Join(to, Path.GetFileName(file)), overwrite: true);
        foreach (string folder in System.IO.Directory.EnumerateDirectories(from))
        {
            string name = Path.GetFileName(folder);
            if (skip?.Contains(name) == true) continue;
            CopyTree(folder, Path.Join(to, name), null);
        }
    }

    /// <summary>True when a folder may still be used: a process image in it, an unreadable process, or its
    /// engine.lock held (every engine holds the one of its folder for its whole life, whatever path spelling started it).</summary>
    public static bool InUse(string folder, ProcessImages images)
    {
        if (images.Unknown) return true;
        string prefix = folder.TrimEnd('\\') + "\\";
        if (images.Paths.Any(p => p.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))) return true;
        string lockFile = Path.Join(folder, EngineLock.FileName);
        if (!File.Exists(lockFile)) return false;
        try { new FileStream(lockFile, FileMode.Open, FileAccess.ReadWrite, FileShare.None).Dispose(); return false; }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return true; }
    }

    /// <summary>Removes a folder no process uses: renamed aside first (Windows refuses while a file in it is open: an
    /// engine starting meanwhile holds its lock), then deleted. True when it is gone; a folder in use stays whole.</summary>
    public static bool RemoveIfUnused(string folder, ProcessImages images)
    {
        if (InUse(folder, images)) return false;
        string aside = $"{folder.TrimEnd('\\')}.{Environment.ProcessId}.removing";
        try { System.IO.Directory.Move(folder, aside); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { return false; }
        TryDelete(aside);  // anything left goes next time
        return !System.IO.Directory.Exists(aside);
    }

    /// <summary>Removes what earlier passes left renamed aside (&lt;folder&gt;.&lt;pid&gt;.removing), checked the same way.
    /// Returns the leftovers removed.</summary>
    public static List<string> RemoveLeftovers(string folder, ProcessImages images)
    {
        var removed = new List<string>();
        string parent = Path.GetDirectoryName(folder.TrimEnd('\\'))!, name = Path.GetFileName(folder.TrimEnd('\\'));
        if (!System.IO.Directory.Exists(parent)) return removed;
        var pattern = new System.Text.RegularExpressions.Regex("^" + System.Text.RegularExpressions.Regex.Escape(name) + @"\.\d+\.removing$");
        foreach (string dir in System.IO.Directory.EnumerateDirectories(parent).Where(d => pattern.IsMatch(Path.GetFileName(d))).ToList())
        {
            if (InUse(dir, images)) continue;
            TryDelete(dir);
            if (!System.IO.Directory.Exists(dir)) removed.Add(dir);
        }
        return removed;
    }

    /// <summary>Removes the build folders other than <paramref name="keep"/> that no engine uses: an engine still
    /// serving an AI session keeps its whole folder until it exits, and a later update removes it.</summary>
    public static void RemoveUnused(string versions, IReadOnlyCollection<string> keep, ProcessImages images)
    {
        if (!System.IO.Directory.Exists(versions)) return;
        foreach (string dir in System.IO.Directory.EnumerateDirectories(versions).ToList())
        {
            if (keep.Any(k => string.Equals(Path.GetFullPath(k).TrimEnd('\\'), Path.GetFullPath(dir).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))) continue;
            if (dir.EndsWith(".removing", StringComparison.OrdinalIgnoreCase))
            {
                if (!InUse(dir, images)) TryDelete(dir);
                continue;
            }
            if (System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(dir), @"\.tmp-\d+$") && !InUse(dir, images)) { TryDelete(dir); continue; }
            RemoveIfUnused(dir, images);
        }
    }

    public static void TryDelete(string folder)
    {
        try { if (System.IO.Directory.Exists(folder)) System.IO.Directory.Delete(folder, recursive: true); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { /* a file still open: a later pass */ }
    }
}

/// <summary>The engine processes of one role ('bridge', 'daemon'). Others: another build of that role (shut down or
/// restarted by the installer); Unknown: that role with an unreadable image, or any process whose role cannot be read,
/// never touched (the caller defers and reports it); Instances: every process that may be one of that role (no second
/// bridge or daemon while one may run).</summary>
internal static class EngineSplit
{
    public sealed record Result(List<EngineProcesses.Entry> Others, List<EngineProcesses.Entry> Unknown, List<EngineProcesses.Entry> Instances);

    public static Result Of(IEnumerable<EngineProcesses.Entry> processes, string role, string exe)
    {
        string target = Path.GetFullPath(exe);
        var result = new Result([], [], []);
        foreach (var process in processes)
        {
            if (process.Role != role && process.Role != EngineProcesses.Unknown) continue;
            result.Instances.Add(process);
            if (process.Role == EngineProcesses.Unknown || process.Image is null) result.Unknown.Add(process);
            else if (!string.Equals(Path.GetFullPath(process.Image), target, StringComparison.OrdinalIgnoreCase)) result.Others.Add(process);
        }
        return result;
    }

    public static string Unread(EngineProcesses.Entry process, string role) => process.Role == EngineProcesses.Unknown
        ? $"NexusBrowser.exe {process.Pid}: role unreadable (another account or SYSTEM, no {role} port), counted as a running {role}, nothing stopped; no second {role} started."
        : $"NexusBrowser {role} {process.Pid}: engine image unreadable (role read by {process.ReadBy}), kept until its natural exit.";
}

/// <summary>The Task Scheduler as the installer uses it: task definitions as XML, so every setting, trigger,
/// principal and the disabled state travel unchanged through a rename or an action update.</summary>
internal interface ITaskStore
{
    /// <summary>The task's definition, or null when there is no such task.</summary>
    string? Xml(string name);

    /// <summary>Absent, Disabled, Queued, Ready, Running or Unknown.</summary>
    string State(string name);

    /// <summary>Creates or replaces the task.</summary>
    void Register(string name, string xml);

    void Delete(string name);

    void Run(string name);
}

/// <summary>Task XML (Task Scheduler schema 1.2) for the product's tasks, and the edits the installer makes to an
/// existing definition.</summary>
internal static class TaskXml
{
    public static readonly XNamespace Ns = "http://schemas.microsoft.com/windows/2004/02/mit/task";

    public sealed record Options(string Description, string Execute, string Arguments, string WorkingDirectory, string UserId,
        bool Enabled = true, bool LogonTrigger = false, int RestartCount = 0, TimeSpan? ExecutionTimeLimit = null, bool StartWhenAvailable = false);

    private static string Duration(TimeSpan span) => span == TimeSpan.Zero ? "PT0S" : System.Xml.XmlConvert.ToString(span);

    public static string Build(Options o)
    {
        var settings = new XElement(Ns + "Settings",
            new XElement(Ns + "MultipleInstancesPolicy", "IgnoreNew"),
            new XElement(Ns + "DisallowStartIfOnBatteries", "false"),
            new XElement(Ns + "StopIfGoingOnBatteries", "false"),
            new XElement(Ns + "AllowHardTerminate", "true"),
            new XElement(Ns + "StartWhenAvailable", o.StartWhenAvailable ? "true" : "false"),
            new XElement(Ns + "RunOnlyIfNetworkAvailable", "false"),
            new XElement(Ns + "IdleSettings", new XElement(Ns + "StopOnIdleEnd", "true"), new XElement(Ns + "RestartOnIdle", "false")),
            new XElement(Ns + "AllowStartOnDemand", "true"),
            new XElement(Ns + "Enabled", o.Enabled ? "true" : "false"),
            new XElement(Ns + "Hidden", "true"),
            new XElement(Ns + "RunOnlyIfIdle", "false"),
            new XElement(Ns + "WakeToRun", "false"),
            new XElement(Ns + "ExecutionTimeLimit", Duration(o.ExecutionTimeLimit ?? TimeSpan.Zero)),
            new XElement(Ns + "Priority", "7"));
        if (o.RestartCount > 0)
            settings.Add(new XElement(Ns + "RestartOnFailure", new XElement(Ns + "Interval", "PT1M"), new XElement(Ns + "Count", o.RestartCount)));
        var task = new XElement(Ns + "Task", new XAttribute("version", "1.2"),
            new XElement(Ns + "RegistrationInfo", new XElement(Ns + "Description", o.Description)),
            new XElement(Ns + "Triggers", o.LogonTrigger
                ? new XElement(Ns + "LogonTrigger", new XElement(Ns + "Enabled", "true"), new XElement(Ns + "UserId", o.UserId))
                : null),
            new XElement(Ns + "Principals", new XElement(Ns + "Principal", new XAttribute("id", "Author"),
                new XElement(Ns + "UserId", o.UserId), new XElement(Ns + "LogonType", "InteractiveToken"), new XElement(Ns + "RunLevel", "LeastPrivilege"))),
            settings,
            new XElement(Ns + "Actions", new XAttribute("Context", "Author"), Exec(o.Execute, o.Arguments, o.WorkingDirectory)));
        return task.ToString();
    }

    private static XElement Exec(string execute, string arguments, string workingDirectory)
    {
        var exec = new XElement(Ns + "Exec", new XElement(Ns + "Command", execute));
        if (arguments.Length > 0) exec.Add(new XElement(Ns + "Arguments", arguments));
        if (workingDirectory.Length > 0) exec.Add(new XElement(Ns + "WorkingDirectory", workingDirectory));
        return exec;
    }

    private static XDocument Parse(string xml) => XDocument.Parse(xml);

    /// <summary>The definition with its first action replaced; settings, triggers, principal and state kept.</summary>
    public static string WithAction(string xml, string execute, string arguments, string workingDirectory)
    {
        var doc = Parse(xml);
        var actions = doc.Root!.Element(Ns + "Actions") ?? throw new InvalidDataException("Task without actions.");
        var first = actions.Elements(Ns + "Exec").FirstOrDefault();
        var replacement = Exec(execute, arguments, workingDirectory);
        if (first is null) actions.AddFirst(replacement); else first.ReplaceWith(replacement);
        return doc.Root.ToString();
    }

    /// <summary>The definition ready for another name (its URI dropped: the name it is registered under rules).</summary>
    public static string ForRename(string xml)
    {
        var doc = Parse(xml);
        doc.Root!.Element(Ns + "RegistrationInfo")?.Element(Ns + "URI")?.Remove();
        return doc.Root.ToString();
    }

    public static string? Command(string? xml) =>
        xml is null ? null : Parse(xml).Root?.Element(Ns + "Actions")?.Element(Ns + "Exec")?.Element(Ns + "Command")?.Value;

    public static string? Arguments(string? xml) =>
        xml is null ? null : Parse(xml).Root?.Element(Ns + "Actions")?.Element(Ns + "Exec")?.Element(Ns + "Arguments")?.Value;

    public static bool HasTrigger(string? xml) =>
        xml is not null && Parse(xml).Root?.Element(Ns + "Triggers")?.HasElements == true;
}

/// <summary>The Task Scheduler's own COM API (Schedule.Service), root folder: no schtasks.exe, no PowerShell.</summary>
internal sealed class WindowsTaskStore : ITaskStore
{
    private const int TaskCreateOrUpdate = 6, LogonInteractiveToken = 3;

    private static dynamic Folder()
    {
        var type = Type.GetTypeFromProgID("Schedule.Service", throwOnError: true)!;
        dynamic service = Activator.CreateInstance(type)!;
        service.Connect();
        return service.GetFolder("\\");
    }

    /// <summary>No such task (or folder): the COM binder raises it as a FileNotFoundException, others as COMException.</summary>
    private static bool Missing(Exception e) => e.HResult is unchecked((int)0x80070002) or unchecked((int)0x80070003);

    private static dynamic? Find(string name)
    {
        try { return Folder().GetTask(name); }
        catch (Exception e) when (Missing(e)) { return null; }
    }

    public string? Xml(string name) => Find(name) is { } task ? (string)task.Xml : null;

    public string State(string name)
    {
        if (Find(name) is not { } task) return "Absent";
        return (int)task.State switch { 1 => "Disabled", 2 => "Queued", 3 => "Ready", 4 => "Running", _ => "Unknown" };
    }

    public void Register(string name, string xml) =>
        Folder().RegisterTask(name, xml, TaskCreateOrUpdate, null, null, LogonInteractiveToken, null);

    public void Delete(string name)
    {
        try { Folder().DeleteTask(name, 0); }
        catch (Exception e) when (Missing(e)) { /* already gone */ }
    }

    public void Run(string name)
    {
        if (Find(name) is { } task) task.Run(null);
    }
}

/// <summary>Real HKCU (default value of a key): get, set (returns the value read back), remove (true when it existed).</summary>
internal interface IRegistryStore
{
    IReadOnlyList<string?> Apply(IReadOnlyList<RegistryOperation> operations);
}

internal sealed record RegistryOperation(string Action, string Key, string? Value = null);

/// <summary>
/// Real HKCU registry, even when started from a packaged app (MSIX, such as the Claude app): there HKCU\Software writes
/// go to a private registry Chrome never reads. Outside a package (the usual case: NexusSystem maintenance, a task, a
/// terminal) the .NET registry API writes in this very process. Under a packaged ancestor, this same engine runs once
/// outside the package in a one-shot scheduled task (--registry-worker, no shell, no reg.exe: "cmd /c reg add" looks
/// like a persistence trick to Microsoft Defender's heuristics), its JSON answer read back, then the task removed.
/// </summary>
internal sealed partial class RealRegistry(ITaskStore tasks, string workerExe, string exchangeFolder, Func<bool>? packaged = null, string? userId = null) : IRegistryStore
{
    public IReadOnlyList<string?> Apply(IReadOnlyList<RegistryOperation> operations) =>
        (packaged ?? HasPackagedAncestor)() ? OutOfPackage(operations) : Local(operations);

    private static string SubKey(string key)
    {
        foreach (string prefix in new[] { "HKCU\\", "HKEY_CURRENT_USER\\" })
            if (key.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return key[prefix.Length..].TrimEnd('\\');
        throw new ArgumentException($"Only HKCU keys are handled here: {key}");
    }

    public static List<string?> Local(IReadOnlyList<RegistryOperation> operations)
    {
        var results = new List<string?>();
        var root = Microsoft.Win32.Registry.CurrentUser;
        foreach (var operation in operations)
        {
            string subKey = SubKey(operation.Key);
            switch (operation.Action)
            {
                case "get":
                    using (var key = root.OpenSubKey(subKey))
                        results.Add(key?.GetValue("", null, Microsoft.Win32.RegistryValueOptions.DoNotExpandEnvironmentNames) as string);
                    break;
                case "set":
                    using (var key = root.CreateSubKey(subKey))
                    {
                        key.SetValue("", operation.Value ?? "", Microsoft.Win32.RegistryValueKind.String);
                        results.Add(key.GetValue("", null, Microsoft.Win32.RegistryValueOptions.DoNotExpandEnvironmentNames) as string);
                    }
                    break;
                case "remove":
                    bool existed;
                    using (var key = root.OpenSubKey(subKey)) existed = key is not null;
                    if (existed) root.DeleteSubKeyTree(subKey, throwOnMissingSubKey: false);
                    results.Add(existed ? "true" : "false");
                    break;
                default:
                    throw new ArgumentException($"Unknown registry operation: {operation.Action}");
            }
        }
        return results;
    }

    private List<string?> OutOfPackage(IReadOnlyList<RegistryOperation> operations)
    {
        string name = "NexusBrowser-registry-" + Guid.NewGuid().ToString("N")[..8];
        // Outside %AppData% and %LocalAppData% (virtualized for a packaged app as well), so the task sees these files.
        Directory.CreateDirectory(exchangeFolder);
        string request = Path.Join(exchangeFolder, name + ".request.json"), response = Path.Join(exchangeFolder, name + ".json");
        var array = new JsonArray([.. operations.Select(o => (JsonNode)new JsonObject { ["action"] = o.Action, ["key"] = o.Key, ["value"] = o.Value })]);
        File.WriteAllText(request, array.ToJsonString(), new UTF8Encoding(false));
        string user = userId ?? System.Security.Principal.WindowsIdentity.GetCurrent().Name;
        tasks.Register(name, TaskXml.Build(new TaskXml.Options("NexusBrowser: real HKCU registry write, removed at once.", workerExe,
            $"--registry-worker --request \"{request}\" --response \"{response}\"", exchangeFolder, user, ExecutionTimeLimit: TimeSpan.FromMinutes(2))));
        try
        {
            tasks.Run(name);
            // The answer appears in one rename once the work is done. A busy PC can delay a task start by tens of seconds.
            var deadline = DateTime.UtcNow.AddSeconds(90);
            while (!File.Exists(response) && DateTime.UtcNow < deadline) Thread.Sleep(200);
            if (!File.Exists(response)) throw new TimeoutException($"Real registry out of package: no answer from task {name} within 90 s (task {tasks.State(name)}).");
            var answer = JsonNode.Parse(File.ReadAllText(response))!.AsObject();
            if (answer["ok"]?.GetValue<bool>() != true) throw new IOException($"Real registry out of package: {answer["error"]}");
            return [.. answer["results"]!.AsArray().Select(r => r?.GetValue<string?>())];
        }
        finally
        {
            tasks.Delete(name);
            foreach (string file in new[] { request, response, response + ".tmp" }) { try { File.Delete(file); } catch (IOException) { } }
        }
    }

    /// <summary>--registry-worker --request F --response F: the out-of-package side, then one atomic rename.</summary>
    public static int Worker(string request, string response)
    {
        JsonObject answer;
        try
        {
            var operations = JsonNode.Parse(File.ReadAllText(request))!.AsArray()
                .Select(o => new RegistryOperation(o!["action"]!.GetValue<string>(), o["key"]!.GetValue<string>(), o["value"]?.GetValue<string>())).ToList();
            answer = new JsonObject { ["ok"] = true, ["results"] = new JsonArray([.. Local(operations).Select(r => (JsonNode?)JsonValue.Create(r))]) };
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException or ArgumentException or InvalidOperationException or System.Security.SecurityException)
        {
            answer = new JsonObject { ["ok"] = false, ["error"] = e.Message };
        }
        File.WriteAllText(response + ".tmp", answer.ToJsonString(), new UTF8Encoding(false));
        File.Move(response + ".tmp", response, overwrite: true);
        return answer["ok"]!.GetValue<bool>() ? 0 : 1;
    }

    // --- Packaged ancestor ------------------------------------------------------------------------------------------

    [LibraryImport("kernel32.dll", SetLastError = true)]
    private static partial nint OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, int pid);

    [LibraryImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CloseHandle(nint handle);

    [LibraryImport("kernel32.dll")]
    private static partial int GetPackageFullName(nint process, ref uint length, nint name);

    [LibraryImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetProcessTimes(nint process, out long creation, out long exit, out long kernel, out long user);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    private static partial nint CreateToolhelp32Snapshot(uint flags, uint pid);

    [LibraryImport("kernel32.dll", EntryPoint = "Process32FirstW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static unsafe partial bool Process32First(nint snapshot, ProcessEntry* entry);

    [LibraryImport("kernel32.dll", EntryPoint = "Process32NextW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static unsafe partial bool Process32Next(nint snapshot, ProcessEntry* entry);

    [StructLayout(LayoutKind.Sequential)]
    private unsafe struct ProcessEntry
    {
        public uint Size, Usage, ProcessId;
        public nint DefaultHeapId;
        public uint ModuleId, Threads, ParentProcessId;
        public int PriorityClassBase;
        public uint Flags;
        public fixed char ExeFile[260];
    }

    private const int AppModelErrorNoPackage = 15700;

    private static unsafe Dictionary<int, int> Parents()
    {
        var parents = new Dictionary<int, int>();
        nint snapshot = CreateToolhelp32Snapshot(0x2 /* TH32CS_SNAPPROCESS */, 0);
        if (snapshot == -1) return parents;
        try
        {
            ProcessEntry entry = default;
            entry.Size = (uint)sizeof(ProcessEntry);
            for (bool more = Process32First(snapshot, &entry); more; more = Process32Next(snapshot, &entry))
                parents[(int)entry.ProcessId] = (int)entry.ParentProcessId;
        }
        finally { CloseHandle(snapshot); }
        return parents;
    }

    private static long? Created(int pid)
    {
        nint handle = OpenProcess(0x1000, false, pid);
        if (handle == 0) return null;
        try { return GetProcessTimes(handle, out long creation, out _, out _, out _) ? creation : null; }
        finally { CloseHandle(handle); }
    }

    /// <summary>True when the HKCU seen here may be a packaged app's private registry. This process's own package
    /// identity is not enough: the Claude app starts its shells without one, yet they still see its private registry
    /// (07/11/2026). Any still running ancestor with a package identity therefore counts; a packaged ancestor whose
    /// children break away (Windows Terminal) only costs the slower out-of-package path, never a wrong registry.</summary>
    public static bool HasPackagedAncestor()
    {
        var parents = Parents();
        int id = Environment.ProcessId;
        var seen = new HashSet<int>();
        while (seen.Add(id))
        {
            nint handle = OpenProcess(0x1000, false, id);
            if (handle != 0)
            {
                try
                {
                    uint length = 0;
                    if (GetPackageFullName(handle, ref length, 0) != AppModelErrorNoPackage) return true;
                }
                finally { CloseHandle(handle); }
            }
            if (!parents.TryGetValue(id, out int parent) || parent == 0 || parent == id) break;
            // A parent id reused by a younger process is not the real parent: the chain ends there.
            if (Created(parent) is not { } parentCreated || Created(id) is not { } created || parentCreated > created) break;
            id = parent;
        }
        return false;
    }
}

/// <summary>Shared MCP token of the Nexus daemons (common rule of 30/10/2026, the same for Relay, Android and Browser):
/// its file (NEXUS_MCP_TOKEN_FILE, else ~\.nexus\mcp-token.txt) is reused when present, never regenerated, and created
/// exclusively otherwise (a stable sibling .lock file serializes concurrent installers), so installers run one after the
/// other or together end with the same token. The user variable NEXUS_MCP_TOKEN mirrors it for the AI apps.</summary>
internal static class SharedToken
{
    public static string ResolveFile(IEnumerable<string?> explicitFiles, string home)
    {
        string path = Path.GetFullPath(explicitFiles.FirstOrDefault(f => !string.IsNullOrWhiteSpace(f)) ?? Path.Join(home, ".nexus", "mcp-token.txt"));
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        FileStream? held = null;
        for (int attempt = 1; held is null; attempt++)
        {
            // Keep this lock file: deleting it could split concurrent installers between different file identities.
            // Never lock the token itself: consumers read it while another installer runs.
            try { held = new FileStream(path + ".lock", FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) when (attempt < 50) { Thread.Sleep(100); }
        }
        using (held)
        {
            string existing = File.Exists(path) ? File.ReadAllText(path).Trim() : "";
            if (existing.Length == 0) File.WriteAllText(path, Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32)), new UTF8Encoding(false));
        }
        return path;
    }
}

internal static class Files
{
    public static readonly UTF8Encoding Utf8 = new(false);
    public static readonly JsonSerializerOptions Indented = new() { WriteIndented = true };

    /// <summary>Writes through a temporary file then one rename, so a reader never sees half a file.</summary>
    public static void WriteAtomic(string path, string text)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        string temporary = $"{path}.{Environment.ProcessId}.tmp";
        File.WriteAllText(temporary, text, Utf8);
        File.Move(temporary, path, overwrite: true);
    }

    /// <summary>Writes only when the content differs (an engine folder is never written again for nothing).</summary>
    public static bool WriteIfChanged(string path, string text)
    {
        if (File.Exists(path) && File.ReadAllText(path) == text) return false;
        WriteAtomic(path, text);
        return true;
    }

    public static JsonObject? ReadObject(string path)
    {
        try { return File.Exists(path) ? JsonNode.Parse(File.ReadAllText(path)) as JsonObject : null; }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException) { return null; }
    }

    /// <summary>Removes the "downloaded from the Internet" mark (Zone.Identifier stream) of every file of a tree, as
    /// Unblock-File does: an unpacked release must not run under SmartScreen's prompts.</summary>
    public static void Unblock(string folder)
    {
        foreach (string file in Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories))
        {
            try { File.Delete(file + ":Zone.Identifier"); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or NotSupportedException) { /* no stream */ }
        }
    }
}
