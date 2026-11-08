using System.Diagnostics;
using System.Globalization;
using System.Net.Http;
using System.Text;
using System.Text.Json.Nodes;

namespace NexusBrowser.Native;

/// <summary>What the installer needs from Windows, replaced by a stand-in in the tests: tasks, real HKCU, engine runs,
/// processes, local HTTP endpoints, user variables.</summary>
internal interface IInstallHost
{
    ITaskStore Tasks { get; }

    /// <summary>Real HKCU; an out-of-package write (packaged ancestor) runs <paramref name="workerExe"/>.</summary>
    IRegistryStore Registry(string workerExe);

    /// <summary>DOMAIN\user the product's tasks run as.</summary>
    string UserId { get; }

    /// <summary>Runs an engine (a WinExe) hidden and waits: exit code and output (stdout then stderr).</summary>
    (int Code, string Output) RunEngine(string exe, IReadOnlyList<string> args, int timeoutSeconds);

    /// <summary>The NexusBrowser.exe processes of this PC (this one excepted), with image and role.</summary>
    IReadOnlyList<EngineProcesses.Entry> EngineProcesses();

    ProcessImages Images(params string[] names);

    /// <summary>Image of one process: "" once it has exited, null while it runs but cannot be read.</summary>
    string? ProcessImage(int pid);

    JsonObject? GetJson(string url, IReadOnlyDictionary<string, string>? headers, int timeoutSeconds);

    string? UserVariable(string name);

    void SetUserVariable(string name, string value);

    /// <summary>This process's environment (inherited by the engines it runs).</summary>
    string? Variable(string name);

    void SetVariable(string name, string value);

    bool IsRunning(string processName);

    /// <summary>Runs a PowerShell script file (the extension guide) and forwards its output.</summary>
    int RunScript(string script, IReadOnlyList<string> args, TextWriter output);

    void Pause(TimeSpan delay);
}

/// <summary>The real Windows host.</summary>
internal sealed class WindowsInstallHost : IInstallHost, IDisposable
{
    private readonly HttpClient _http = new(new SocketsHttpHandler { UseProxy = false });

    public void Dispose() => _http.Dispose();

    public ITaskStore Tasks { get; } = new WindowsTaskStore();

    public IRegistryStore Registry(string workerExe) => new RealRegistry(Tasks, workerExe, Path.Join(BridgeSecurity.HomeDir(), ".nexus"));

    public string UserId => System.Security.Principal.WindowsIdentity.GetCurrent().Name;

    public (int Code, string Output) RunEngine(string exe, IReadOnlyList<string> args, int timeoutSeconds)
    {
        var info = new ProcessStartInfo(exe)
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (string arg in args) info.ArgumentList.Add(arg);
        using var process = Process.Start(info) ?? throw new IOException($"{exe} not started");
        process.StandardInput.Close();  // an engine that took the arguments for a stdio server ends at once
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(timeoutSeconds * 1000))
        {
            process.Kill(entireProcessTree: true);
            throw new TimeoutException($"{exe} {string.Join(' ', args)}: no answer in {timeoutSeconds} s.");
        }
        return (process.ExitCode, (stdout.Result + stderr.Result).Trim());
    }

    public IReadOnlyList<EngineProcesses.Entry> EngineProcesses() => Native.EngineProcesses.List();

    public ProcessImages Images(params string[] names) => ProcessImages.Read(names);

    public string? ProcessImage(int pid)
    {
        var read = Native.EngineProcesses.Read(pid);
        return read.Exited ? "" : read.Image;
    }

    public JsonObject? GetJson(string url, IReadOnlyDictionary<string, string>? headers, int timeoutSeconds)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            foreach (var (name, value) in headers ?? new Dictionary<string, string>()) request.Headers.TryAddWithoutValidation(name, value);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(timeoutSeconds));
            using var response = _http.Send(request, timeout.Token);
            if (!response.IsSuccessStatusCode) return null;
            using var reader = new StreamReader(response.Content.ReadAsStream(timeout.Token));
            return JsonNode.Parse(reader.ReadToEnd()) as JsonObject;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or OperationCanceledException or System.Text.Json.JsonException or IOException) { return null; }
    }

    public string? UserVariable(string name) => Environment.GetEnvironmentVariable(name, EnvironmentVariableTarget.User);

    public void SetUserVariable(string name, string value) => Environment.SetEnvironmentVariable(name, value, EnvironmentVariableTarget.User);

    public string? Variable(string name) => Environment.GetEnvironmentVariable(name);

    public void SetVariable(string name, string value) => Environment.SetEnvironmentVariable(name, value);

    public bool IsRunning(string processName)
    {
        var processes = Process.GetProcessesByName(processName);
        foreach (var process in processes) process.Dispose();
        return processes.Length > 0;
    }

    public int RunScript(string script, IReadOnlyList<string> args, TextWriter output)
    {
        var info = new ProcessStartInfo(Path.Join(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe"))
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (string arg in new[] { "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script }.Concat(args)) info.ArgumentList.Add(arg);
        using var process = Process.Start(info) ?? throw new IOException("powershell.exe not started");
        var stderr = process.StandardError.ReadToEndAsync();
        while (process.StandardOutput.ReadLine() is { } line) output.WriteLine(line);
        process.WaitForExit();
        if (stderr.Result.Trim() is { Length: > 0 } errors) output.WriteLine(errors);
        return process.ExitCode;
    }

    public void Pause(TimeSpan delay) => Thread.Sleep(delay);
}

/// <summary>
/// The installation and update of NexusBrowser, all in the engine (the downloaded get.ps1 only fetches, checks and
/// starts it). Every pass is safe to run again:
///  - engine: the package's prebuilt engine (or a development build) installed once per build in
///    %LOCALAPPDATA%\NexusBrowser\versions\&lt;fingerprint&gt;, never written again, named by current.json;
///  - native host com.nexus.browser_auth declared to Chrome (real HKCU, out of the package under the Claude app);
///  - task "NexusBrowser Bridge" without trigger (the bridge starts on demand), task "NexusBrowser Update" (public
///    install) that runs this engine's --self-update;
///  - shared MCP daemon (127.0.0.1:16182, bearer token): on a Nexus workstation declared to the daemon supervisor,
///    else (public install) task "NexusBrowser MCP" at logon with the user token NEXUS_MCP_TOKEN;
///  - AI clients: public install, the clients found get the server; any other pass refreshes only what is installed;
///  - a running bridge or daemon an agent uses is never stopped: its build waits for its next start;
///  - older builds no process runs any more are removed.
/// A public update prepares the new package beside the working one (app.next), switches the folder by a single rename,
/// and on failure puts the previous folder back and installs it again with this same controller: the previous
/// package's own scripts are never executed.
/// </summary>
internal sealed class Installer(InstallLayout layout, IInstallHost host, TextWriter output)
{
    public sealed record Options(string ControllerExe, bool Register = false, bool UpdateOnly = false, bool SkipLaunch = false,
        bool Pack = false, string? Candidate = null);

    public const int Port = 16182;
    /// <summary>Further 30-second waits for an extension connected before the update (90 s in all: the extension's
    /// 30 s reconnection backoff, then its one-minute keep-alive alarm).</summary>
    internal const int ExtensionReconnectWaits = 2;
    /// <summary>Exit code of --reuse-installed when the installed release cannot be reused (get.ps1 then downloads it).</summary>
    public const int NotReusable = 10;

    private static readonly int[] TransientMoveErrors = [unchecked((int)0x80070020), unchecked((int)0x80070021), unchecked((int)0x80070005)];

    // ---------------------------------------------------------------------------------------------------------------
    // Output and journal
    // ---------------------------------------------------------------------------------------------------------------

    private void Say(string text) => output.WriteLine(text);

    private void Warn(string text) => output.WriteLine("WARNING: " + text);

    private void Journal(string text)
    {
        Say(text);
        try
        {
            Directory.CreateDirectory(layout.LocalRoot);
            File.AppendAllText(layout.Journal, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + " " + text + Environment.NewLine, Files.Utf8);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { /* the journal never fails an install */ }
    }

    private void Result(string state, string reason, bool retryable) =>
        Say("NEXUS_UPDATE_RESULT " + new JsonObject { ["product"] = "browser", ["state"] = state, ["reason"] = reason, ["retryable"] = retryable }.ToJsonString());

    private bool IsPublic(string sourceRoot) =>
        string.Equals(Path.GetFullPath(sourceRoot).TrimEnd('\\'), Path.GetFullPath(layout.App).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);

    private FileStream? TakeUpdateLock()
    {
        Directory.CreateDirectory(layout.NativeRoot);
        try { return new FileStream(layout.UpdateLock, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
        catch (IOException) { return null; }
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Public update: new package beside the working one, one rename, rollback with this controller
    // ---------------------------------------------------------------------------------------------------------------

    /// <summary>Folder rename that waits out an external, transient hold (antivirus or indexing services open freshly
    /// written executables for a moment: "being used by another process", seen on a fresh GitHub Windows runner), at most
    /// 10 s; any other error, or a longer hold, fails.</summary>
    internal static void MoveStaged(string from, string to, Action<TimeSpan> pause)
    {
        for (int attempt = 1; ; attempt++)
        {
            try { Directory.Move(from, to); return; }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                bool held = TransientMoveErrors.Contains(e.HResult) && Directory.Exists(from) && !Directory.Exists(to);
                if (!held || attempt >= 40) throw new IOException($"Cannot move {from} to {to}: {e.Message}", e);
                pause(TimeSpan.FromMilliseconds(250));
            }
        }
    }

    /// <summary>--install --switch --source &lt;checked package&gt;: get.ps1 and --self-update. Sandbox (NEXUS_BROWSER_ROOT,
    /// tests): unpack and check the engine only, nothing registered on the PC.</summary>
    public int Switch(string package, Options options, string? archiveSha256, bool sandbox)
    {
        using var updateLock = TakeUpdateLock();
        if (updateLock is null)
        {
            Result("deferred", "maintenance-in-progress", true);
            return 0;
        }
        string source = Path.GetFullPath(package);
        if (!File.Exists(Path.Join(source, "engine", "NexusBrowser.exe"))) throw new InvalidDataException("Not a NexusBrowser package (engine\\NexusBrowser.exe missing).");
        string app = layout.App, next = app + ".next", previous = app + ".previous", failed = app + ".failed";

        // app.failed is left only when a failed update could not finish restoring the previous version. This pass holds
        // a freshly verified package that registers everything again, under the same lock: the interrupted restore is
        // taken over (the previous version goes back to app if the second rename never happened).
        if (Directory.Exists(failed))
        {
            if (!Directory.Exists(app) && Directory.Exists(previous)) Directory.Move(previous, app);
            Directory.Delete(failed, recursive: true);
            Say($"Interrupted recovery taken over: {failed} removed, this verified package installs again.");
        }
        if (Directory.Exists(next)) Directory.Delete(next, recursive: true);
        EngineBuilds.CopyTree(source, next, new HashSet<string>(StringComparer.OrdinalIgnoreCase) { ".git" });
        Files.Unblock(next);

        if (sandbox)
        {
            if (Directory.Exists(app)) Directory.Delete(app, recursive: true);
            // Tests only: NEXUS_BROWSER_STAGED_SIGNAL names a file written once app.next is complete; the switch then
            // waits, at most 60 s, until the test removes it, so a simulated scanner holds app.next before the rename.
            if (host.Variable("NEXUS_BROWSER_STAGED_SIGNAL") is { Length: > 0 } signal)
            {
                File.WriteAllText(signal, next);
                var until = DateTime.UtcNow.AddSeconds(60);
                while (File.Exists(signal) && DateTime.UtcNow < until) host.Pause(TimeSpan.FromMilliseconds(20));
                if (File.Exists(signal)) throw new TimeoutException($"NEXUS_BROWSER_STAGED_SIGNAL: {signal} was not taken within 60 s.");
            }
            MoveStaged(next, app, host.Pause);
            string expected = File.ReadAllText(Path.Join(app, "VERSION")).Trim();
            var answer = host.RunEngine(Path.Join(app, "engine", "NexusBrowser.exe"), ["--version"], 30);
            if (answer.Code != 0 || answer.Output != expected) throw new InvalidDataException($"Unpacked engine answers '{answer.Output}', expected {expected}.");
            Say($"NexusBrowser {answer.Output} unpacked in {app} (test folder: nothing registered).");
            return 0;
        }

        bool hadApp = Directory.Exists(app);
        string? previousDigest = hadApp ? PayloadDigest.Compute(app) : null;
        if (Directory.Exists(previous)) Directory.Delete(previous, recursive: true);
        if (hadApp)
        {
            try { Directory.Move(app, previous); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                EngineBuilds.TryDelete(next);
                throw new IOException($"The folder {app} is in use ({e.Message}): nothing was changed. Close what uses it and try again.", e);
            }
        }
        try { MoveStaged(next, app, host.Pause); }
        catch
        {
            // The previous version goes back in place: a failed switch changes nothing.
            if (hadApp && !Directory.Exists(app)) Directory.Move(previous, app);
            EngineBuilds.TryDelete(next);
            throw;
        }

        try { Core(app, options); }
        catch (Exception error) when (hadApp && Boundary.Recoverable(error))
        {
            Journal($"The installation failed ({error.Message}): restoring the previous version.");
            MoveStaged(app, failed, host.Pause);
            MoveStaged(previous, app, host.Pause);
            try
            {
                if (PayloadDigest.Compute(app) != previousDigest)
                    throw new InvalidDataException("Previous payload changed after the update started: rollback refused before changing the installation.");
                // This controller registers the restored payload: its verified files and engine only, never its scripts.
                Core(app, options with { Candidate = null });
            }
            catch (Exception restore) when (Boundary.Recoverable(restore))
            {
                throw new InvalidOperationException($"The update failed and restoring the previous version did not complete ({restore.Message}). " +
                    $"The failed package is kept in {failed}. Log: {layout.Journal}", restore);
            }
            EngineBuilds.TryDelete(failed);
            throw new InvalidOperationException($"The update failed; the previous version is restored. Log: {layout.Journal}", error);
        }
        if (archiveSha256 is { Length: 64 } && archiveSha256.All(Uri.IsHexDigit))
        {
            Files.WriteAtomic(layout.CacheReceipt, new JsonObject
            {
                ["version"] = File.ReadAllText(Path.Join(app, "VERSION")).Trim(),
                ["archive_sha256"] = archiveSha256.ToLowerInvariant(),
                ["payload_fingerprint"] = PayloadDigest.Compute(app),
                ["digest"] = "payload-v2",
            }.ToJsonString(Files.Indented));
        }
        EngineBuilds.TryDelete(previous);
        return 0;
    }

    /// <summary>--install --reuse-installed --update-only: the published release is the installed one (a deferred
    /// switch retried by maintenance): its package is checked against the receipt of its verified installation and
    /// registered again without downloading it. <see cref="NotReusable"/> when that cannot be proved.</summary>
    public int Reuse(Options options)
    {
        using var updateLock = TakeUpdateLock();
        if (updateLock is null)
        {
            Result("deferred", "maintenance-in-progress", true);
            return 0;
        }
        var current = Files.ReadObject(layout.CurrentFile);
        var receipt = Files.ReadObject(layout.CacheReceipt);
        string? version = current?["version"]?.ToString(), exe = current?["exe"]?.ToString(), fingerprint = current?["fingerprint"]?.ToString();
        string versionFile = Path.Join(layout.App, "VERSION"), appEngine = Path.Join(layout.App, "engine", "NexusBrowser.exe");
        bool reusable = version is not null && exe is not null && fingerprint is { Length: 64 } && File.Exists(exe) && File.Exists(appEngine) &&
            File.Exists(versionFile) && File.ReadAllText(versionFile).Trim() == version && receipt?["version"]?.ToString() == version &&
            receipt["digest"]?.ToString() == "payload-v2" &&
            string.Equals(EngineBuilds.Fingerprint(Path.GetDirectoryName(appEngine)!), fingerprint, StringComparison.OrdinalIgnoreCase) &&
            PayloadDigest.Compute(layout.App) == receipt["payload_fingerprint"]?.ToString();
        if (!reusable) return NotReusable;
        Say("Published release is already installed; retrying safe activation without downloading it again.");
        Core(layout.App, options);
        return 0;
    }

    /// <summary>--install --restore-payload app --expected-payload-hash H: the restore of a failed update started by
    /// get.ps1 of NexusBrowser 2.35.32 or earlier through this package's scripts\install-native.ps1 (in app.failed).
    /// Only that layout is accepted; a changed payload is refused before any registry, task or file change.</summary>
    public int Restore(string payloadRoot, string expectedDigest, Options options)
    {
        string controllerRoot = Path.GetDirectoryName(Path.GetDirectoryName(Path.GetFullPath(options.ControllerExe))!)!;
        if (!string.Equals(Path.GetFullPath(payloadRoot).TrimEnd('\\'), layout.App, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(controllerRoot.TrimEnd('\\'), layout.App + ".failed", StringComparison.OrdinalIgnoreCase) ||
            expectedDigest.Length != 64 || !expectedDigest.All(Uri.IsHexDigit))
            throw new InvalidOperationException("Rollback source must be the restored public app beside this update controller.");
        if (PayloadDigest.Compute(layout.App) != expectedDigest)
            throw new InvalidDataException("Previous payload changed after the update started: rollback refused before changing the installation.");
        if (!File.Exists(Path.Join(layout.App, "engine", "NexusBrowser.exe"))) throw new InvalidDataException("Previous payload has no native engine.");
        Core(layout.App, options);
        return 0;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // One installation pass
    // ---------------------------------------------------------------------------------------------------------------

    /// <summary>Installs the payload <paramref name="sourceRoot"/> (a public package, or a development checkout with
    /// <see cref="Options.Candidate"/>, its build) and registers it on this PC.</summary>
    public void Core(string sourceRoot, Options o)
    {
        sourceRoot = Path.GetFullPath(sourceRoot);
        string controlExe = Path.GetFullPath(o.ControllerExe);
        string version = File.ReadAllText(Path.Join(sourceRoot, "VERSION")).Trim();
        bool isPublic = IsPublic(sourceRoot);
        Directory.CreateDirectory(layout.LocalRoot);
        var tasks = host.Tasks;

        // --- 1. Engine: one immutable folder per build.
        string candidate = o.Candidate ?? Path.Join(sourceRoot, "engine");
        if (!File.Exists(Path.Join(candidate, "NexusBrowser.exe")))
            throw new InvalidDataException(o.UpdateOnly ? "UpdateOnly requires a prebuilt release; development checkouts are not built automatically."
                : $"No engine in {candidate}: install.ps1 builds a development checkout first.");
        var build = EngineBuilds.Install(candidate, layout.Versions);
        if (build.New) Journal($"Engine {version} installed in {build.Directory}.");
        string exe = build.Exe;
        var check = host.RunEngine(exe, ["--version"], 30);
        if (check.Code != 0 || check.Output != version) throw new InvalidDataException($"Installed engine answers '{check.Output}', expected {version}.");

        // The task names this engine calls ("NexusBrowser ..." since 2.35.12); the other set's tasks are renamed,
        // keeping their settings and disabled state, or removed. A rollback to an older engine renames them back.
        var (names, retired) = TaskNames.For(version);
        var existing = names.Roles.Concat(retired.Roles).Select(r => r.Name).Where(n => tasks.Xml(n) is not null).ToList();
        foreach (var step in TaskNames.Migration(version, existing))
        {
            if (step.Rename) tasks.Register(step.To, TaskXml.ForRename(tasks.Xml(step.From)!));
            tasks.Delete(step.From);  // a running instance stays alive: a rename never stops a process
            Journal(step.Rename ? $"Task '{step.From}' renamed '{step.To}'." : $"Task '{step.From}' removed ('{step.To}' kept).");
        }
        bool keepBridgeDisabled = tasks.State(names.Bridge) == "Disabled";
        bool keepUpdateDisabled = tasks.State(names.Update) == "Disabled";
        // Where the plugin, skill and update state are read from (public update, client registration).
        Files.WriteIfChanged(Path.Join(build.Directory, "installation.json"), new JsonObject { ["repository_root"] = sourceRoot }.ToJsonString(Files.Indented));

        // --- 2. Agents driving tabs: the running bridge and daemon are left alone (their new build waits for the next start).
        bool busy = false, extensionLinked = false;
        if (!o.SkipLaunch && File.Exists(layout.TokenFile))
        {
            int linked = host.RunEngine(controlExe, ["--refresh-extension", "--check-only", "--source-root", sourceRoot], 60).Code;
            busy = linked == 3;
            // Connected before the update (up to date, behind or busy): the extension is in Chrome, whatever happens next.
            extensionLinked = linked is 0 or 1 or 3;
            if (busy) Warn("Agents are driving Chrome tabs: the running bridge and daemon keep their build until their next start.");
        }
        Files.WriteAtomic(layout.CurrentFile, new JsonObject { ["exe"] = exe, ["version"] = version, ["fingerprint"] = build.Fingerprint }.ToJsonString(Files.Indented));

        // --- 3. Native host, and the leftovers of the bridge before 17/10/2026 (NexusAGY), in one real-registry pass.
        string manifest = WriteNativeHostManifest(exe, sourceRoot);
        var registry = host.Registry(exe).Apply([
            new RegistryOperation("remove", @"HKCU\Software\Google\Chrome\NativeMessagingHosts\com.nexusagy.bridge_auth"),
            new RegistryOperation("set", @"HKCU\Software\Google\Chrome\NativeMessagingHosts\com.nexus.browser_auth", manifest),
        ]);
        if (registry[0] == "true") Journal("Old native host com.nexusagy.bridge_auth removed from Chrome (HKCU key).");
        if (registry[1] != manifest) throw new IOException($"Native host com.nexus.browser_auth: registry key not written ({registry[1]}).");
        Say($"Native host com.nexus.browser_auth declared to Chrome ({manifest} -> {exe}).");
        if (tasks.Xml(TaskNames.NexusAgyBridge) is not null)
        {
            tasks.Delete(TaskNames.NexusAgyBridge);
            Journal($"Old task \"{TaskNames.NexusAgyBridge}\" removed.");
        }
        string agyRoot = Path.Join(layout.Home, ".nexusagy");
        foreach (string old in new[] { Path.Join(agyRoot, "bridge-token"), Path.Join(agyRoot, "native-host", "com.nexusagy.bridge_auth.json"),
                     Path.Join(agyRoot, "native-host", "nexusagy_bridge_auth.cmd") })
        {
            if (!File.Exists(old)) continue;
            File.Delete(old);
            Journal($"Old NexusAGY bridge file removed: {old}");
        }

        // --- 4. Bridge task, started on demand (no trigger). An older bridge, even started as administrator, is shut
        //     down through its own endpoint; one whose image or role cannot be read is never stopped (deferred, reported).
        string bridgeArguments = $"--bridge --token-file \"{layout.TokenFile}\" --log-file \"{Path.Join(layout.LocalRoot, "bridge.log")}\"";
        var bridges = EngineSplit.Of(host.EngineProcesses(), EngineProcesses.Bridge, exe);
        bool bridgeDeferred = bridges.Unknown.Count > 0;
        foreach (var unread in bridges.Unknown) Journal(EngineSplit.Unread(unread, EngineProcesses.Bridge));
        if (bridges.Others.Count > 0 && !busy && !o.SkipLaunch && !keepBridgeDisabled)
        {
            foreach (var old in bridges.Others)
            {
                var shutdown = host.RunEngine(controlExe, ["--shutdown-bridge", "--expected-pid", old.Pid.ToString(CultureInfo.InvariantCulture),
                    "--wait-seconds", "10", "--token-file", layout.TokenFile], 20);
                Journal($"Bridge {old.Pid}: {shutdown.Output}");
                if (shutdown.Code != 0) bridgeDeferred = true;
            }
        }
        else if (bridges.Others.Count > 0) bridgeDeferred = true;
        // Existing task settings and disabled state are user choices: updating its action does not reset them.
        if (tasks.Xml(names.Bridge) is { } bridgeTask) tasks.Register(names.Bridge, TaskXml.WithAction(bridgeTask, exe, bridgeArguments, layout.LocalRoot));
        else tasks.Register(names.Bridge, TaskXml.Build(new TaskXml.Options(
            "NexusBrowser Chrome bridge (Antigravity, Claude, Codex), started on demand (no trigger).", exe, bridgeArguments, layout.LocalRoot,
            host.UserId, RestartCount: 3, StartWhenAvailable: true)));
        Say($"Task '{names.Bridge}' -> {exe}");

        // --- 5. Update task (public install only): the bridge starts it on POST /api/update; it runs --self-update of
        //     THIS controller's build (installed in versions like any build), never an updater of a restored older
        //     payload. A clone updates through git.
        string? updaterFolder = null;
        if (isPublic)
        {
            var updater = EngineBuilds.Install(Path.GetDirectoryName(controlExe)!, layout.Versions);
            updaterFolder = updater.Directory;
            tasks.Delete(names.Update);
            tasks.Register(names.Update, TaskXml.Build(new TaskXml.Options("NexusBrowser update, started by its bridge (POST /api/update), no trigger.",
                updater.Exe, "--self-update", layout.LocalRoot, host.UserId, Enabled: !keepUpdateDisabled, ExecutionTimeLimit: TimeSpan.FromMinutes(30))));
            Say($"Task '{names.Update}' installed.");
        }

        // --- 6. Shared MCP daemon (port 16182): one nexus-browser server for every session of Claude, Codex and Antigravity.
        string supervisorState = tasks.State(TaskNames.Supervisor);
        bool supervised = supervisorState != "Absent", keepSupervisorDisabled = supervisorState == "Disabled";
        // Nexus workstation token, shared by both PCs: created once by Sync-NexusPoste, never here.
        string? workstationToken = host.Variable("OneDrive") is { Length: > 0 } oneDrive
            ? Path.Join(oneDrive, "Documents", "NexusSecure", "agents", "nexus-mcp-token.txt") : null;
        string? token = supervised && workstationToken is not null && File.Exists(workstationToken) ? File.ReadAllText(workstationToken).Trim() : null;
        var daemons = EngineSplit.Of(host.EngineProcesses(), EngineProcesses.Daemon, exe);
        foreach (var unread in daemons.Unknown) Journal(EngineSplit.Unread(unread, EngineProcesses.Daemon));
        void RestartDaemons(string tokenFile, string warning)
        {
            foreach (var old in daemons.Others)
            {
                var restart = host.RunEngine(controlExe, ["--restart-daemon", "--expected-pid", old.Pid.ToString(CultureInfo.InvariantCulture),
                    "--port", Port.ToString(CultureInfo.InvariantCulture), "--mcp-token-file", tokenFile, "--request-file", layout.RestartRequest,
                    "--target-fingerprint", build.Fingerprint, "--wait-seconds", "10"], 20);
                Journal($"Daemon {old.Pid}: {restart.Output}");
                if (restart.Code != 0) Warn(warning);
            }
        }
        string daemonTaskState = tasks.State(names.Daemon);
        if (token is { Length: > 0 })
        {
            // exe: the supervisor's key. python (same value): read by supervisors built before the exe key.
            string spec = new JsonObject
            {
                ["port"] = Port, ["exe"] = exe, ["python"] = exe, ["args"] = new JsonArray(), ["env"] = new JsonObject(),
                ["restart_request"] = layout.RestartRequest,
            }.ToJsonString(Files.Indented);
            if (Files.WriteIfChanged(layout.DaemonSpec, spec)) Journal($"Daemon spec -> {exe}");
            foreach (string leftover in new[] { ".runtime-switch", ".pause", ".installing" })
                if (File.Exists(layout.DaemonSpec + leftover)) File.Delete(layout.DaemonSpec + leftover);
            if (daemons.Others.Count > 0 && !busy && !o.SkipLaunch && !keepSupervisorDisabled)
                RestartDaemons(workstationToken!, "Daemon upgrade deferred: valid sessions are preserved; legacy or unknown instances wait for natural exit.");
        }
        else if ((o.Register || (o.UpdateOnly && daemonTaskState != "Absent")) && !supervised)
        {
            string tokenFile = SharedToken.ResolveFile([host.Variable("NEXUS_MCP_TOKEN_FILE"), host.UserVariable("NEXUS_MCP_TOKEN_FILE")], layout.Home);
            token = File.ReadAllText(tokenFile).Trim();
            if (host.UserVariable("NEXUS_MCP_TOKEN") != token)
            {
                host.SetUserVariable("NEXUS_MCP_TOKEN", token);
                Say("User variable NEXUS_MCP_TOKEN set (restart the AI apps to see it).");
            }
            host.SetVariable("NEXUS_MCP_TOKEN", token);
            string arguments = $"--http {Port}";
            if (tasks.Xml(names.Daemon) is { } daemonTask)
            {
                if (!string.Equals(TaskXml.Command(daemonTask), exe, StringComparison.OrdinalIgnoreCase))
                    tasks.Register(names.Daemon, TaskXml.WithAction(daemonTask, exe, arguments, layout.LocalRoot));
                if (daemonTaskState != "Disabled" && !busy && !o.SkipLaunch)
                    RestartDaemons(tokenFile, "Previous daemon kept: a valid HTTP session remains, or this instance does not prove session-preserving restart.");
            }
            else
            {
                tasks.Register(names.Daemon, TaskXml.Build(new TaskXml.Options(
                    $"NexusBrowser MCP daemon (127.0.0.1:{Port}) shared by the AI apps, bearer token NEXUS_MCP_TOKEN.", exe, arguments, layout.LocalRoot,
                    host.UserId, LogonTrigger: true, RestartCount: 999)));
            }
            if (!o.SkipLaunch && TaskNames.ShouldStart(tasks.State(names.Daemon), EngineSplit.Of(host.EngineProcesses(), EngineProcesses.Daemon, exe).Instances.Count))
                tasks.Run(names.Daemon);
            Say($"Task '{names.Daemon}' -> {exe} --http {Port}");
        }
        else if (!supervised) Warn("No Nexus daemon supervisor and no -Register: shared daemon not installed (stdio servers still work).");
        else Warn($"Shared MCP token absent ({workstationToken}): daemon not declared. Wait for OneDrive, run Sync-NexusPoste.ps1 -Apply, then install again.");

        // --- 7. Antigravity (Nexus workstation): plugin nexus-browser on the shared daemon, its skill; one declaration only.
        if (o.Register && !o.UpdateOnly && supervised && token is { Length: > 0 }) WorkstationAntigravity(sourceRoot, token);

        // --- 8. AI clients. Public install: the clients found get the server (stdio, this engine). Every other pass:
        //        only what is already installed follows this engine; transports, custom routes and disabled choices kept.
        List<string> registrationArgs = ["--register", "--engine-exe", exe, "--source-root", sourceRoot, "--backups", layout.Backups];
        if (!o.Register) registrationArgs.Add("--update-only");
        var registration = host.RunEngine(controlExe, registrationArgs, 120);
        if (!o.Pack) Say(registration.Output);
        if (registration.Code != 0) throw new InvalidOperationException("Declaring the server to the AI clients failed (see above).");

        // --- 9. Bridge, extension and daemon checked.
        if (!o.SkipLaunch)
        {
            // One bridge: a kept instance (deferred, or started by the task's former name) is not doubled. A
            // NexusBrowser.exe whose role cannot be read counts as a running bridge: reported, never doubled nor stopped.
            var running = EngineSplit.Of(host.EngineProcesses(), EngineProcesses.Bridge, exe);
            if (TaskNames.ShouldStart(tasks.State(names.Bridge), running.Instances.Count)) tasks.Run(names.Bridge);
            else if (running.Unknown.Where(p => p.Role == EngineProcesses.Unknown).Select(p => p.Pid).ToList() is { Count: > 0 } unreadable)
                Warn($"Bridge task not started: NexusBrowser.exe {string.Join(", ", unreadable)} runs with a role that cannot be read (another account or SYSTEM).");
            if (bridgeDeferred) Warn("Bridge upgrade deferred: running instance kept until its next natural exit; the extension refresh has its own ownership check.");
            var refresh = host.RunEngine(controlExe, ["--refresh-extension", "--wait-ready", o.Pack ? "0" : "30", "--source-root", sourceRoot], 90);
            // A restarted bridge waits for the extension's next attempt: its backoff reaches 30 s, then its keep-alive
            // alarm runs every minute. An extension connected before the update gets that long, never the "add the
            // extension" guide (it opened chrome://extensions in the user's Chrome on 08/11/2026 for nothing).
            for (int wait = 0; refresh.Code == 2 && extensionLinked && !o.Pack && wait < ExtensionReconnectWaits; wait++)
                refresh = host.RunEngine(controlExe, ["--refresh-extension", "--wait-ready", "30", "--source-root", sourceRoot], 90);
            Say($"Extension: {refresh.Output}");
            if (refresh.Code == 2 && extensionLinked)
                Warn("The extension was connected before this update and has not reconnected yet: it reconnects by itself, nothing to add to Chrome.");
            else if (refresh.Code == 2 && o.Register)
            {
                if (!o.Pack) host.RunScript(Path.Join(sourceRoot, "scripts", "guide-extension.ps1"), [], output);
            }
            else if (refresh.Code == 2 && host.IsRunning("chrome")) Warn("Chrome is open but its NexusBrowser extension is not connected to the bridge.");
            else if (refresh.Code == 1) Warn("The loaded extension is not this version yet: reload it in chrome://extensions.");
            else if (refresh.Code == 3)
                Warn("Extension reload deferred while agents work (commands still running, or an extension older than 2.35.10 that would lose their tabs). " +
                    "NexusBrowser.exe --refresh-extension --force-reload reloads it anyway, when the user asks.");
            if (token is { Length: > 0 } && !busy && !o.UpdateOnly) ConfirmDaemon(version, exe);
        }

        if (o.UpdateOnly) Say("NEXUS_UPDATE_RESULT " + Receipt(version).ToJsonString());

        // --- 10. Older builds no process runs any more, the legacy fixed folder and the former updaters are removed.
        //     Process images read by QueryFullProcessImageNameW; nothing is removed while a candidate cannot be read.
        var images = host.Images("NexusBrowser");
        EngineBuilds.RemoveUnused(layout.Versions, updaterFolder is null ? [build.Directory] : [build.Directory, updaterFolder], images);
        string legacy = layout.LegacyEngineFolder;
        if (Directory.Exists(legacy) && EngineBuilds.RemoveIfUnused(legacy, images)) Journal($"Legacy engine folder removed: {legacy}");
        foreach (string gone in EngineBuilds.RemoveLeftovers(legacy, images)) Journal($"Legacy engine leftover removed: {gone}");
        string venv = Path.Join(layout.LocalRoot, "venv");
        var pythons = host.Images("python", "pythonw");
        if (Directory.Exists(venv) && EngineBuilds.RemoveIfUnused(venv, pythons)) Journal($"Former Python environment removed: {venv}");
        foreach (string gone in EngineBuilds.RemoveLeftovers(venv, pythons)) Journal($"Former Python environment leftover removed: {gone}");
        if (isPublic && Directory.Exists(layout.Updaters))
        {
            // PowerShell updaters of 2.35.32 and earlier: the update task now runs the engine itself.
            EngineBuilds.TryDelete(layout.Updaters);
            if (!Directory.Exists(layout.Updaters)) Journal($"Former PowerShell updaters removed: {layout.Updaters}");
        }
        if (o.Register && o.Pack) Say(registration.Output);  // the NEXUS_PACK_RESULT line stays the last
        else if (bridgeDeferred) Say($"NexusBrowser {version} prepared; the running bridge is kept until its next natural exit.");
        else Say($"NexusBrowser {version} installed.");
    }

    /// <summary>Native host com.nexus.browser_auth: the Chrome extension has the engine (started by Chrome) compute the
    /// local bridge's authentication proofs; the token is never handed to Chrome. Declared for the current user only,
    /// for the extension IDs of native\resources\bridge_config.json. Manifest outside OneDrive and AppData.</summary>
    private string WriteNativeHostManifest(string exe, string sourceRoot)
    {
        var origins = (JsonNode.Parse(File.ReadAllText(Path.Join(sourceRoot, "native", "resources", "bridge_config.json")))?["allowed_origins"] as JsonArray)
            ?.Select(o => o?.ToString()).Where(o => !string.IsNullOrEmpty(o)).ToList();
        if (origins is not { Count: > 0 }) throw new InvalidDataException("No extension origin in native\\resources\\bridge_config.json.");
        string manifest = Path.Join(layout.NativeHostFolder, "com.nexus.browser_auth.json");
        Files.WriteAtomic(manifest, new JsonObject
        {
            ["name"] = "com.nexus.browser_auth",
            ["description"] = "NexusBrowser : preuves d'authentification du pont local (jeton jamais livre a Chrome)",
            ["path"] = exe,
            ["type"] = "stdio",
            ["allowed_origins"] = new JsonArray([.. origins.Select(o => (JsonNode)o!)]),
        }.ToJsonString(Files.Indented) + "\n");
        string oldLauncher = Path.Join(layout.NativeHostFolder, "nexus_browser_auth.cmd");  // Python launcher before 2.33.0
        if (File.Exists(oldLauncher)) File.Delete(oldLauncher);
        return manifest;
    }

    /// <summary>Antigravity on a Nexus workstation: the plugin nexus-browser on the shared daemon with its skill, one
    /// declaration only (a global entry in mcp_config.json would start a second server).</summary>
    private void WorkstationAntigravity(string sourceRoot, string token)
    {
        string agyRoot = Path.Join(layout.Home, ".gemini", "config"), agyConfig = Path.Join(agyRoot, "mcp_config.json");
        if (!File.Exists(agyConfig)) return;
        string plugin = Path.Join(agyRoot, "plugins", "nexus-browser"), pluginSource = Path.Join(sourceRoot, "plugin");
        Directory.CreateDirectory(Path.Join(plugin, "skills", "nexus-browser"));
        File.Copy(Path.Join(pluginSource, "plugin.json"), Path.Join(plugin, "plugin.json"), overwrite: true);
        File.Copy(Path.Join(pluginSource, "logo.png"), Path.Join(plugin, "logo.png"), overwrite: true);
        File.Copy(Path.Join(pluginSource, "skills", "nexus-browser", "SKILL.md"), Path.Join(plugin, "skills", "nexus-browser", "SKILL.md"), overwrite: true);
        Files.WriteAtomic(Path.Join(plugin, "mcp_config.json"), new JsonObject
        {
            ["mcpServers"] = new JsonObject
            {
                ["nexus-browser"] = new JsonObject
                {
                    ["serverUrl"] = $"http://127.0.0.1:{Port}/mcp?agent=antigravity",
                    ["headers"] = new JsonObject { ["Authorization"] = "Bearer " + token },
                },
            },
        }.ToJsonString(Files.Indented));
        string oldSkill = Path.Join(agyRoot, "skills", "nexus-browser");
        if (Directory.Exists(oldSkill))
        {
            string saved = Path.Join(layout.Backups, "agy-skill-nexus-browser-" + DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture));
            Directory.CreateDirectory(layout.Backups);
            Directory.Move(oldSkill, saved);
            Journal($"Antigravity: global copy of the nexus-browser skill removed (duplicate of the plugin), saved in {saved}");
        }
        // Plugin enabled in config.json only while Antigravity is closed (open, it writes its file back on exit).
        string agyApp = Path.Join(agyRoot, "config.json");
        if (File.Exists(agyApp) && !host.IsRunning("Antigravity") && JsonNode.Parse(File.ReadAllText(agyApp)) is JsonObject settings)
        {
            if (settings["plugins"] is not JsonObject plugins) settings["plugins"] = plugins = [];
            if (plugins["nexus-browser"]?["enabled"]?.GetValueKind() != System.Text.Json.JsonValueKind.True)
            {
                plugins["nexus-browser"] = new JsonObject { ["enabled"] = true };
                Files.WriteAtomic(agyApp, settings.ToJsonString(Files.Indented));
            }
        }
        bool pluginOn = Files.ReadObject(agyApp)?["plugins"]?["nexus-browser"]?["enabled"]?.GetValueKind() == System.Text.Json.JsonValueKind.True;
        if (pluginOn) { if (RemoveAntigravityDuplicate(agyConfig, layout.Backups) is { } removed) Journal(removed); }
        else Warn("Antigravity open and plugin nexus-browser not enabled yet: global entry kept (install again with Antigravity closed).");
        Say("Antigravity: nexus-browser declared (plugin only).");
    }

    /// <summary>Removes the nexus-browser entry of Antigravity's global mcp_config.json (its plugin declares it), other
    /// servers and settings kept, after a backup, by an atomic write. Null when there is nothing to remove.</summary>
    internal static string? RemoveAntigravityDuplicate(string configPath, string backups)
    {
        if (!File.Exists(configPath)) return null;
        string raw = File.ReadAllText(configPath);
        if (JsonNode.Parse(raw) is not JsonObject config || config["mcpServers"] is not JsonObject servers || !servers.ContainsKey("nexus-browser")) return null;
        Directory.CreateDirectory(backups);
        string backup = Path.Join(backups, "gemini-mcp_config-" + DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture) + ".json");
        File.WriteAllText(backup, raw, Files.Utf8);
        servers.Remove("nexus-browser");
        Files.WriteAtomic(configPath, config.ToJsonString(Files.Indented));
        return $"Antigravity: nexus-browser entry removed from {configPath} (its plugin declares it; backup: {backup}).";
    }

    /// <summary>The shared daemon answers with this version from this engine (its owner image read natively).</summary>
    private void ConfirmDaemon(string version, string exe)
    {
        var deadline = DateTime.UtcNow.AddSeconds(60);
        while (true)
        {
            var health = host.GetJson($"http://127.0.0.1:{Port}/health", null, 2);
            if (health is not null && health["status"]?.ToString() == "ok" && health["service"]?.ToString() == "nexus-browser" &&
                health["version"]?.ToString() == version && int.TryParse(health["pid"]?.ToString(), out int pid) &&
                host.ProcessImage(pid) is { Length: > 0 } owner &&
                string.Equals(Path.GetFullPath(owner), Path.GetFullPath(exe), StringComparison.OrdinalIgnoreCase))
            {
                Say($"Shared MCP daemon {version} confirmed (pid {pid}).");
                return;
            }
            if (DateTime.UtcNow >= deadline) break;
            host.Pause(TimeSpan.FromMilliseconds(500));
        }
        Warn("Daemon upgrade deferred: valid HTTP sessions and responses keep serving; legacy instances await natural exit.");
    }

    /// <summary>Read-only activation receipt (~\.nexus\nexus-browser\update-receipt.json): installed files are never
    /// taken as proof of loaded code; done only when the daemon, the bridge and the extension run this build.</summary>
    internal JsonObject Receipt(string published)
    {
        var current = Files.ReadObject(layout.CurrentFile) ?? [];
        var daemon = host.GetJson($"http://127.0.0.1:{Port}/health", null, 3);
        JsonObject? bridge = null, extension = null;
        if (File.Exists(layout.TokenFile))
        {
            bridge = host.GetJson("http://127.0.0.1:9225/api/status", new Dictionary<string, string> { ["X-Nexus-Browser-Token"] = File.ReadAllText(layout.TokenFile).Trim() }, 3);
            if (bridge is not null && current["exe"]?.ToString() is { Length: > 0 } exe)
            {
                try { extension = JsonNode.Parse(host.RunEngine(exe, ["--refresh-extension", "--check-only"], 15).Output) as JsonObject; }
                catch (Exception e) when (e is System.Text.Json.JsonException or IOException or TimeoutException or System.ComponentModel.Win32Exception) { extension = null; }
            }
        }
        var receipt = ActivationState(current, daemon, bridge, extension, published);
        Files.WriteAtomic(Path.Join(layout.LocalRoot, "update-receipt.json"), receipt.ToJsonString());
        return receipt;
    }

    internal static JsonObject ActivationState(JsonObject current, JsonObject? daemon, JsonObject? bridge, JsonObject? extension, string published)
    {
        string? version = current["version"]?.ToString(), fingerprint = current["fingerprint"]?.ToString();
        bool valid = fingerprint is { Length: 64 } && fingerprint.All(Uri.IsHexDigit);
        bool daemonOk = valid && daemon?["status"]?.ToString() == "ok" && daemon["service"]?.ToString() == "nexus-browser" &&
            daemon["version"]?.ToString() == version && daemon["fingerprint"]?.ToString() == fingerprint;
        bool bridgeOk = valid && bridge?["status"]?.ToString() == "online" && bridge["version"]?.ToString() == version &&
            bridge["fingerprint"]?.ToString() == fingerprint;
        bool extensionOk = extension?["verified"]?.GetValueKind() == System.Text.Json.JsonValueKind.True;
        bool ok = daemonOk && bridgeOk && extensionOk;
        JsonObject Component(JsonObject? c, bool verified) => new()
        {
            ["version"] = c?["version"]?.DeepClone(), ["fingerprint"] = c?["fingerprint"]?.DeepClone(), ["pid"] = c?["pid"]?.DeepClone(), ["verified"] = verified,
        };
        return new JsonObject
        {
            ["schema"] = 1, ["product"] = "browser", ["state"] = ok ? "done" : "deferred",
            ["published"] = published, ["installed"] = version, ["active"] = ok ? version : null,
            ["fingerprint"] = fingerprint, ["retryable"] = !ok,
            ["reason"] = ok ? "loaded-code-verified" : !daemonOk ? "daemon-activation-pending" : !bridgeOk ? "bridge-activation-pending" : "extension-activation-pending",
            ["components"] = new JsonObject
            {
                ["daemon"] = Component(daemon, daemonOk), ["bridge"] = Component(bridge, bridgeOk), ["extension"] = extension?.DeepClone(),
            },
        };
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Command line
    // ---------------------------------------------------------------------------------------------------------------

    /// <summary>
    /// --install, the installer's one entry point:
    ///   --switch --source P [--archive-sha256 H]   a checked release package (get.ps1, --self-update): folder switch, rollback
    ///   --source R [--engine B]                    install in place: the package itself (install.ps1), or a checkout and its build
    ///   --reuse-installed                          the installed release again (deferred activation retried), else exit 10
    ///   --restore-payload app --expected-payload-hash H   restore started by get.ps1 of 2.35.32 or earlier
    /// with --register (public install: declare to the AI clients found) or --update-only (keep every existing choice),
    /// --skip-launch; NEXUS_PACK=1: no question, no wait, no window, NEXUS_PACK_RESULT last.
    /// </summary>
    public static int Run(string[] args, TextWriter output)
    {
        bool Has(string flag) => args.Contains(flag, StringComparer.OrdinalIgnoreCase);
        string controller = Environment.ProcessPath ?? throw new InvalidOperationException("Executable path unknown.");
        var options = new Options(controller, Register: Has("--register"), UpdateOnly: Has("--update-only"), SkipLaunch: Has("--skip-launch"),
            Pack: Environment.GetEnvironmentVariable("NEXUS_PACK") == "1" || Has("--update-only"),
            Candidate: Program.GetArgValue(args, "--engine") is { } engine ? Path.GetFullPath(engine) : null);
        string? sandbox = Environment.GetEnvironmentVariable("NEXUS_BROWSER_ROOT");
        var layout = sandbox is { Length: > 0 } ? InstallLayout.ForUser() with { NativeRoot = Path.GetFullPath(sandbox) } : InstallLayout.ForUser();
        using var host = new WindowsInstallHost();
        var installer = new Installer(layout, host, output);
        try
        {
            if (Program.GetArgValue(args, "--restore-payload") is { } payload)
                return installer.Restore(payload, Program.GetArgValue(args, "--expected-payload-hash") ?? "", options);
            if (Has("--reuse-installed")) return installer.Reuse(options);
            string source = Program.GetArgValue(args, "--source") ?? throw new ArgumentException("--install needs --source <folder>.");
            if (Has("--switch")) return installer.Switch(source, options, Program.GetArgValue(args, "--archive-sha256"), sandbox is { Length: > 0 });
            installer.Core(source, options);
            return 0;
        }
        catch (Exception error) when (Boundary.Recoverable(error))
        {
            installer.Journal("Installation failed: " + error.Message);
            throw;
        }
    }
}
