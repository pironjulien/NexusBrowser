using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Xml.Linq;
using NexusBrowser.Native;
using Xunit;

namespace NexusBrowser.Tests;

/// <summary>Task Scheduler stand-in: definitions kept as the XML the installer registers.</summary>
internal sealed class FakeTasks : ITaskStore
{
    public Dictionary<string, string> Definitions { get; } = new(StringComparer.OrdinalIgnoreCase);
    public HashSet<string> Running { get; } = new(StringComparer.OrdinalIgnoreCase);
    public List<string> Started { get; } = [];
    public Action<string>? OnRun { get; set; }

    public string? Xml(string name) => Definitions.GetValueOrDefault(name);

    public string State(string name)
    {
        if (!Definitions.TryGetValue(name, out string? xml)) return "Absent";
        if (Running.Contains(name)) return "Running";
        return XDocument.Parse(xml).Root!.Element(TaskXml.Ns + "Settings")?.Element(TaskXml.Ns + "Enabled")?.Value == "false" ? "Disabled" : "Ready";
    }

    public void Register(string name, string xml)
    {
        Assert.Equal("Task", XDocument.Parse(xml).Root!.Name.LocalName);
        Definitions[name] = xml;
    }

    public void Delete(string name) => Definitions.Remove(name);

    public void Run(string name)
    {
        Started.Add(name);
        OnRun?.Invoke(name);
    }

    public static string Disabled(string xml)
    {
        // The Task Scheduler leaves a default setting out of the definition it gives back (Enabled when true).
        var doc = XDocument.Parse(xml);
        var settings = doc.Root!.Element(TaskXml.Ns + "Settings")!;
        if (settings.Element(TaskXml.Ns + "Enabled") is { } enabled) enabled.Value = "false";
        else settings.Add(new XElement(TaskXml.Ns + "Enabled", "false"));
        return doc.Root.ToString();
    }
}

internal sealed class FakeRegistry : IRegistryStore
{
    public Dictionary<string, string> Keys { get; } = new(StringComparer.OrdinalIgnoreCase);
    public int Calls { get; private set; }

    public IReadOnlyList<string?> Apply(IReadOnlyList<RegistryOperation> operations)
    {
        Calls++;
        return [.. operations.Select(o => o.Action switch
        {
            "set" => Keys[o.Key] = o.Value ?? "",
            "get" => Keys.GetValueOrDefault(o.Key),
            "remove" => Keys.Remove(o.Key) ? "true" : "false",
            _ => throw new ArgumentException(o.Action),
        })];
    }
}

/// <summary>The installer's Windows host, recorded: engines are text files "engine &lt;version&gt; &lt;tag&gt;", answered here.</summary>
internal sealed class FakeHost(InstallLayout layout) : IInstallHost
{
    public FakeTasks FakeTasks { get; } = new();
    public FakeRegistry FakeRegistry { get; } = new();
    public ITaskStore Tasks => FakeTasks;
    public IRegistryStore Registry(string workerExe) => FakeRegistry;
    public string UserId => @"PC\tester";
    public List<(string Exe, string[] Args)> Calls { get; } = [];
    public Func<string, string[], (int, string)?>? OnEngine { get; set; }
    public List<EngineProcesses.Entry> Processes { get; } = [];
    public ProcessImages RunningImages { get; set; } = ProcessImages.None;
    public Dictionary<string, string> UserVariables { get; } = [];
    public Dictionary<string, string> Variables { get; } = [];
    public List<string> Scripts { get; } = [];

    public (int Code, string Output) RunEngine(string exe, IReadOnlyList<string> args, int timeoutSeconds)
    {
        string[] list = [.. args];
        Calls.Add((exe, list));
        if (OnEngine?.Invoke(exe, list) is { } answer) return answer;
        return list[0] switch
        {
            "--version" => (0, File.ReadAllText(exe).Split(' ')[1]),
            "--register" => (0, "Claude Code: declared\nCodex: declared"),
            "--refresh-extension" => (2, """{"verified":false}"""),
            "--shutdown-bridge" => (0, "bridge stopped"),
            "--restart-daemon" => (0, "daemon restarted"),
            _ => (0, ""),
        };
    }

    public IReadOnlyList<EngineProcesses.Entry> EngineProcesses() => Processes;
    public ProcessImages Images(params string[] names) => RunningImages;
    public string? ProcessImage(int pid) => pid == 4242 ? Files.ReadObject(layout.CurrentFile)?["exe"]?.ToString() : "";

    public JsonObject? GetJson(string url, IReadOnlyDictionary<string, string>? headers, int timeoutSeconds) =>
        url.EndsWith("/health", StringComparison.Ordinal) && Files.ReadObject(layout.CurrentFile) is { } current
            ? new JsonObject { ["status"] = "ok", ["service"] = "nexus-browser", ["version"] = current["version"]?.ToString(), ["pid"] = 4242 }
            : null;

    public string? UserVariable(string name) => UserVariables.GetValueOrDefault(name);
    public void SetUserVariable(string name, string value) => UserVariables[name] = value;
    public string? Variable(string name) => Variables.GetValueOrDefault(name);
    public void SetVariable(string name, string value) => Variables[name] = value;
    public bool IsRunning(string processName) => false;

    public int RunScript(string script, IReadOnlyList<string> args, TextWriter output)
    {
        Scripts.Add(script);
        return 0;
    }

    public void Pause(TimeSpan delay) { }

    public string[] Registrations => [.. Calls.Where(c => c.Args[0] == "--register").Select(c => string.Join(' ', c.Args))];
}

/// <summary>
/// The installer of the engine (native\Installer.cs) on disposable folders, with the Windows host recorded: a fresh
/// public install, an update while an engine of the previous build runs, a failed update restored with the previous
/// package's own files (never its scripts), a restore refused when that package changed, and the compatibility paths.
/// </summary>
public sealed class InstallerTests : IDisposable
{
    private readonly TempDir _dir = new();
    private readonly InstallLayout _layout;
    private readonly FakeHost _host;
    private readonly StringWriter _output = new();

    public InstallerTests()
    {
        _layout = new InstallLayout(_dir["local\\NexusBrowser"], _dir["home"]);
        _host = new FakeHost(_layout);
    }

    public void Dispose()
    {
        _output.Dispose();
        _dir.Dispose();
    }

    private Installer Make() => new(_layout, _host, _output);

    /// <summary>A release package as package-release.ps1 lays it out, with a text engine.</summary>
    private string Package(string version, string tag = "a")
    {
        string root = _dir[$"package-{version}-{tag}-{Guid.NewGuid():N}"];
        Directory.CreateDirectory(Path.Join(root, "engine"));
        File.WriteAllText(Path.Join(root, "engine", "NexusBrowser.exe"), $"engine {version} {tag}");
        File.WriteAllText(Path.Join(root, "VERSION"), version + "\n");
        File.WriteAllText(Path.Join(root, "install.ps1"), "throw 'A package script must never run'");
        Directory.CreateDirectory(Path.Join(root, "native", "resources"));
        File.Copy(Repo.File("native", "resources", "bridge_config.json"), Path.Join(root, "native", "resources", "bridge_config.json"));
        Directory.CreateDirectory(Path.Join(root, "extension"));
        File.WriteAllText(Path.Join(root, "extension", "manifest.json"), $$"""{"version":"{{version}}"}""");
        return root;
    }

    private static string Fingerprint(string package) =>
        Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(Path.Join(package, "engine", "NexusBrowser.exe"))));

    private JsonObject Current() => Files.ReadObject(_layout.CurrentFile)!;

    private Installer.Options Options(bool register = true, bool updateOnly = false, bool skipLaunch = false, string? controller = null) =>
        new(controller ?? Path.Join(_dir.Path, "controller", "NexusBrowser.exe"), Register: register, UpdateOnly: updateOnly, SkipLaunch: skipLaunch, Pack: updateOnly);

    /// <summary>The controller: the new package's own engine (get.ps1 starts it from the checked package).</summary>
    private static Installer.Options From(string package, Installer.Options options) => options with { ControllerExe = Path.Join(package, "engine", "NexusBrowser.exe") };

    [Fact]
    public void AFreshPublicInstallRegistersEverythingFromTheCheckedPackage()
    {
        string package = Package("2.36.0");
        string sha = new('c', 64);
        Assert.Equal(0, Make().Switch(package, From(package, Options()), sha, sandbox: false));

        string fingerprint = Fingerprint(package), build = Path.Join(_layout.Versions, fingerprint[..16]);
        var current = Current();
        Assert.Equal(Path.Join(build, "NexusBrowser.exe"), current["exe"]!.ToString());
        Assert.Equal("2.36.0", current["version"]!.ToString());
        Assert.Equal(fingerprint, current["fingerprint"]!.ToString());
        Assert.True(File.Exists(Path.Join(build, "engine.lock")));
        Assert.Equal(_layout.App, Files.ReadObject(Path.Join(build, "installation.json"))!["repository_root"]!.ToString());
        Assert.Equal("engine 2.36.0 a", File.ReadAllText(Path.Join(_layout.App, "engine", "NexusBrowser.exe")));
        Assert.False(Directory.Exists(_layout.App + ".next"));
        Assert.False(Directory.Exists(_layout.App + ".previous"));

        // Native host: manifest outside AppData naming the installed engine, declared in the real HKCU.
        string manifest = Path.Join(_layout.LocalRoot, "native-host", "com.nexus.browser_auth.json");
        Assert.Equal(current["exe"]!.ToString(), Files.ReadObject(manifest)!["path"]!.ToString());
        Assert.Equal(manifest, _host.FakeRegistry.Keys[@"HKCU\Software\Google\Chrome\NativeMessagingHosts\com.nexus.browser_auth"]);
        Assert.Equal(1, _host.FakeRegistry.Calls);  // one real-registry pass (one out-of-package task at most)

        // Tasks: the bridge on demand (no trigger), the daemon at logon, the update task on this engine's --self-update.
        var tasks = _host.FakeTasks;
        Assert.Equal(current["exe"]!.ToString(), TaskXml.Command(tasks.Xml(TaskNames.Bridge)));
        Assert.StartsWith("--bridge --token-file", TaskXml.Arguments(tasks.Xml(TaskNames.Bridge)));
        Assert.False(TaskXml.HasTrigger(tasks.Xml(TaskNames.Bridge)));
        Assert.True(TaskXml.HasTrigger(tasks.Xml(TaskNames.Daemon)));
        Assert.Equal("--http 16182", TaskXml.Arguments(tasks.Xml(TaskNames.Daemon)));
        Assert.Equal(current["exe"]!.ToString(), TaskXml.Command(tasks.Xml(TaskNames.Update)));
        Assert.Equal("--self-update", TaskXml.Arguments(tasks.Xml(TaskNames.Update)));
        Assert.Contains(TaskNames.Bridge, tasks.Started);
        Assert.Contains(TaskNames.Daemon, tasks.Started);

        // One shared token per PC, mirrored in the user variable; the clients found are declared (public install).
        string token = File.ReadAllText(Path.Join(_layout.Home, ".nexus", "mcp-token.txt")).Trim();
        Assert.Matches("^[0-9a-f]{64}$", token);
        Assert.Equal(token, _host.UserVariables["NEXUS_MCP_TOKEN"]);
        Assert.Equal([$"--register --engine-exe {current["exe"]} --source-root {_layout.App} --backups {_layout.Backups}"], _host.Registrations);
        Assert.Single(_host.Scripts, s => s.EndsWith(@"scripts\guide-extension.ps1", StringComparison.Ordinal));  // extension not connected yet
        Assert.Contains("Shared MCP daemon 2.36.0 confirmed (pid 4242).", _output.ToString());
        // Every engine run is the controller's (the checked package), or the installed build's version check.
        Assert.All(_host.Calls, c => Assert.True(c.Args[0] == "--version" || c.Exe == Path.Join(package, "engine", "NexusBrowser.exe"), string.Join(' ', c.Args)));

        var receipt = Files.ReadObject(_layout.CacheReceipt)!;
        Assert.Equal(sha, receipt["archive_sha256"]!.ToString());
        Assert.Equal(PayloadDigest.Compute(_layout.App), receipt["payload_fingerprint"]!.ToString());
    }

    [Fact]
    public void AnUpdateWhileTheOldEngineRunsKeepsItsFolderUntilItExits()
    {
        string first = Package("2.36.0", "first");
        Make().Switch(first, From(first, Options()), null, sandbox: false);
        string oldExe = Current()["exe"]!.ToString(), oldBuild = Path.GetDirectoryName(oldExe)!;

        // The bridge and the daemon of the first build serve AI sessions: each engine holds its folder's engine.lock.
        _host.Processes.Add(new EngineProcesses.Entry(101, oldExe, EngineProcesses.Bridge, "command_line"));
        _host.Processes.Add(new EngineProcesses.Entry(102, oldExe, EngineProcesses.Daemon, "command_line"));
        _host.RunningImages = new ProcessImages([oldExe], false);
        _host.Calls.Clear();
        string second = Package("2.36.1", "second");
        using (new FileStream(Path.Join(oldBuild, "engine.lock"), FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            Assert.Equal(0, Make().Switch(second, From(second, Options()), null, sandbox: false));

        string newExe = Current()["exe"]!.ToString();
        Assert.NotEqual(oldExe, newExe);
        Assert.Equal("2.36.1", Current()["version"]!.ToString());
        Assert.True(File.Exists(oldExe));  // never replaced nor removed under a running engine
        // The old bridge is asked to exit once idle, the old daemon to restart once its sessions are done: never killed.
        Assert.Contains(_host.Calls, c => string.Join(' ', c.Args).StartsWith("--shutdown-bridge --expected-pid 101", StringComparison.Ordinal));
        Assert.Contains(_host.Calls, c => string.Join(' ', c.Args).StartsWith("--restart-daemon --expected-pid 102", StringComparison.Ordinal));
        Assert.Equal(newExe, TaskXml.Command(_host.FakeTasks.Xml(TaskNames.Bridge)));
        Assert.Equal(newExe, TaskXml.Command(_host.FakeTasks.Xml(TaskNames.Daemon)));

        // Once that engine has exited, the next pass removes its folder.
        _host.Processes.Clear();
        _host.RunningImages = ProcessImages.None;
        Make().Core(_layout.App, Options(register: false, skipLaunch: true, controller: newExe));
        Assert.False(Directory.Exists(oldBuild));
        Assert.True(File.Exists(newExe));
    }

    [Fact]
    public void AFailedUpdateRestoresThePreviousPackageWithTheNewController()
    {
        string first = Package("2.36.0", "first");
        Make().Switch(first, From(first, Options()), null, sandbox: false);
        string firstExe = Current()["exe"]!.ToString();
        File.WriteAllText(Path.Join(_layout.App, "install.ps1"), "throw 'Legacy installer trap'");  // the previous scripts never run
        string firstDigest = PayloadDigest.Compute(_layout.App);

        string second = Package("2.36.1", "second");
        string controller = Path.Join(second, "engine", "NexusBrowser.exe");
        // The new build's client registration fails: the update must leave the previous version working.
        _host.OnEngine = (exe, args) => args[0] == "--register" && args[2] != firstExe ? (1, "Codex: failed (config unreadable)") : null;
        _host.Calls.Clear();
        var error = Assert.Throws<InvalidOperationException>(() => Make().Switch(second, From(second, Options()), new string('d', 64), sandbox: false));
        Assert.Contains("the previous version is restored", error.Message);

        Assert.Equal(firstDigest, PayloadDigest.Compute(_layout.App));
        Assert.Equal(firstExe, Current()["exe"]!.ToString());
        Assert.Equal("2.36.0", Current()["version"]!.ToString());
        Assert.Equal(firstExe, TaskXml.Command(_host.FakeTasks.Xml(TaskNames.Bridge)));
        // The update task keeps the NEW controller's --self-update (never an updater of the restored package).
        Assert.Equal(Path.Join(_layout.Versions, Fingerprint(second)[..16], "NexusBrowser.exe"), TaskXml.Command(_host.FakeTasks.Xml(TaskNames.Update)));
        Assert.All(_host.Calls.Where(c => c.Args[0] != "--version"), c => Assert.Equal(controller, c.Exe));
        Assert.Equal(2, _host.Registrations.Length);
        Assert.Contains($"--engine-exe {firstExe}", _host.Registrations[1]);
        foreach (string leftover in new[] { ".next", ".previous", ".failed" }) Assert.False(Directory.Exists(_layout.App + leftover), leftover);
        Assert.False(File.Exists(_layout.CacheReceipt));  // no receipt for a package that did not install
        Assert.Contains("restoring the previous version", File.ReadAllText(_layout.Journal));
    }

    [Fact]
    public void ARestoreIsRefusedWhenThePreviousPackageChangedMeanwhile()
    {
        string first = Package("2.36.0", "first");
        Make().Switch(first, From(first, Options()), null, sandbox: false);
        string firstExe = Current()["exe"]!.ToString();
        string second = Package("2.36.1", "second");
        _host.OnEngine = (exe, args) =>
        {
            if (args[0] != "--register" || args[2] == firstExe) return null;
            File.AppendAllText(Path.Join(_layout.App + ".previous", "VERSION"), "changed");
            return (1, "failed");
        };
        var error = Assert.Throws<InvalidOperationException>(() => Make().Switch(second, From(second, Options()), null, sandbox: false));
        Assert.Contains("restoring the previous version did not complete", error.Message);
        Assert.Contains("Previous payload changed", error.Message);
        Assert.True(Directory.Exists(_layout.App + ".failed"));  // the failed package kept for diagnosis
        Assert.Equal(1, _host.Registrations.Count(r => r.Contains(firstExe, StringComparison.Ordinal)));  // only the first install's
    }

    [Fact]
    public void AnInterruptedRecoveryIsTakenOverByTheNextPackage()
    {
        string first = Package("2.36.0", "first");
        Make().Switch(first, From(first, Options()), null, sandbox: false);
        // What a restore stopped midway leaves: the failed package in app.failed, the previous one in app.previous.
        Directory.Move(_layout.App, _layout.App + ".previous");
        Directory.CreateDirectory(_layout.App + ".failed");
        File.WriteAllText(Path.Join(_layout.App + ".failed", "install.ps1"), "throw 'never run'");
        string second = Package("2.36.1", "second");
        Assert.Equal(0, Make().Switch(second, From(second, Options()), null, sandbox: false));
        Assert.Contains("Interrupted recovery taken over", _output.ToString());
        Assert.Equal("2.36.1", Current()["version"]!.ToString());
        foreach (string leftover in new[] { ".next", ".previous", ".failed" }) Assert.False(Directory.Exists(_layout.App + leftover), leftover);
    }

    [Fact]
    public void AConcurrentInstallDefersWithoutTouchingAnything()
    {
        Directory.CreateDirectory(_layout.NativeRoot);
        using var held = new FileStream(_layout.UpdateLock, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        string package = Package("2.36.0");
        Assert.Equal(0, Make().Switch(package, From(package, Options(updateOnly: true)), null, sandbox: false));
        Assert.Contains("\"reason\":\"maintenance-in-progress\"", _output.ToString());
        Assert.False(Directory.Exists(_layout.App + ".next"));
        Assert.False(File.Exists(_layout.CurrentFile));
    }

    [Fact]
    public void MaintenanceKeepsEveryChoiceAndReportsActivation()
    {
        string first = Package("2.36.0", "first");
        Make().Switch(first, From(first, Options()), null, sandbox: false);
        // The user disabled the update task; maintenance (UpdateOnly) must not enable it, nor declare new clients.
        _host.FakeTasks.Definitions[TaskNames.Update] = FakeTasks.Disabled(_host.FakeTasks.Definitions[TaskNames.Update]);
        _host.Calls.Clear();
        string second = Package("2.36.1", "second");
        Assert.Equal(0, Make().Switch(second, From(second, Options(register: false, updateOnly: true)), null, sandbox: false));
        Assert.Equal("Disabled", _host.FakeTasks.State(TaskNames.Update));
        Assert.Single(_host.Registrations, r => r.EndsWith("--update-only", StringComparison.Ordinal));
        Assert.Single(_host.Scripts);  // the guide of the first install only: maintenance shows nothing
        var line = _output.ToString().Split('\n').Select(l => l.Trim()).Last(l => l.StartsWith("NEXUS_UPDATE_RESULT ", StringComparison.Ordinal));
        var receipt = JsonNode.Parse(line["NEXUS_UPDATE_RESULT ".Length..])!;
        Assert.Equal("deferred", receipt["state"]!.ToString());  // installed files are not proof of loaded code
        Assert.Equal("2.36.1", receipt["installed"]!.ToString());
        Assert.True(File.Exists(Path.Join(_layout.LocalRoot, "update-receipt.json")));
    }

    [Fact]
    public void TasksOfTheOtherNameSetAreRenamedKeepingTheirStateAndJournaled()
    {
        // An install before 2.35.12: its tasks are called "Nexus Browser ...", the update task disabled by the user.
        string legacyUpdate = FakeTasks.Disabled(TaskXml.Build(new TaskXml.Options("old", @"C:\old\NexusBrowser.exe", "", "", @"PC\tester")));
        _host.FakeTasks.Definitions[TaskNames.LegacyUpdate] = legacyUpdate;
        _host.FakeTasks.Definitions[TaskNames.LegacyBridge] = TaskXml.Build(new TaskXml.Options("old", @"C:\old\NexusBrowser.exe", "--bridge", "", @"PC\tester"));
        _host.FakeTasks.Definitions[TaskNames.Bridge] = TaskXml.Build(new TaskXml.Options("new", @"C:\old\NexusBrowser.exe", "--bridge", "", @"PC\tester"));
        string package = Package("2.36.0");
        Make().Switch(package, From(package, Options()), null, sandbox: false);
        Assert.Null(_host.FakeTasks.Xml(TaskNames.LegacyUpdate));
        Assert.Null(_host.FakeTasks.Xml(TaskNames.LegacyBridge));
        Assert.Equal("Disabled", _host.FakeTasks.State(TaskNames.Update));
        string journal = File.ReadAllText(_layout.Journal);
        Assert.Contains("Task 'Nexus Browser Update' renamed 'NexusBrowser Update'.", journal);
        Assert.Contains("Task 'Nexus Browser Bridge' removed ('NexusBrowser Bridge' kept).", journal);
    }

    [Fact]
    public void TaskMigrationPlansFollowTheEnginesNames()
    {
        string Plan(string version, params string[] existing) =>
            string.Join(",", TaskNames.Migration(version, existing).Select(s => $"{s.Role}:{(s.Rename ? "Rename" : "Remove")}:{s.From}>{s.To}")) is { Length: > 0 } p ? p : "none";
        string[] legacy = ["Nexus Browser Bridge", "Nexus Browser MCP", "Nexus Browser Update"], current = ["NexusBrowser Bridge", "NexusBrowser MCP", "NexusBrowser Update"];
        Assert.Equal("Bridge:Rename:Nexus Browser Bridge>NexusBrowser Bridge,Daemon:Rename:Nexus Browser MCP>NexusBrowser MCP,Update:Rename:Nexus Browser Update>NexusBrowser Update", Plan("2.35.12", legacy));
        Assert.Equal("Bridge:Remove:Nexus Browser Bridge>NexusBrowser Bridge,Update:Rename:Nexus Browser Update>NexusBrowser Update",
            Plan("2.35.12", "Nexus Browser Bridge", "NexusBrowser Bridge", "Nexus Browser Update", "NexusAGY Browser Bridge"));
        Assert.Equal("none", Plan("2.36.0", current));
        Assert.Equal("Bridge:Rename:NexusBrowser Bridge>Nexus Browser Bridge,Daemon:Rename:NexusBrowser MCP>Nexus Browser MCP,Update:Rename:NexusBrowser Update>Nexus Browser Update", Plan("2.35.11", current));
        Assert.Equal("none", Plan("2.35.12"));
        Assert.Equal("Nexus Browser Bridge", TaskNames.For("2.35.11").Keep.Bridge);
        Assert.Equal([true, false, false, false, false], new[] { TaskNames.ShouldStart("Ready", 0), TaskNames.ShouldStart("Ready", 1),
            TaskNames.ShouldStart("Running", 0), TaskNames.ShouldStart("Disabled", 0), TaskNames.ShouldStart("Absent", 0) });
    }

    [Fact]
    public void ARenamedTaskKeepsItsWholeDefinitionAndAnUpdatedActionKeepsTheRest()
    {
        string xml = FakeTasks.Disabled(TaskXml.Build(new TaskXml.Options("d", @"C:\a\NexusBrowser.exe", "--bridge", @"C:\w", @"PC\tester", RestartCount: 3)));
        var exported = XDocument.Parse(xml);
        exported.Root!.Element(TaskXml.Ns + "RegistrationInfo")!.Add(new XElement(TaskXml.Ns + "URI", @"\Nexus Browser Bridge"));
        string renamed = TaskXml.ForRename(exported.Root.ToString());
        Assert.DoesNotContain("<URI>", renamed);
        Assert.Contains("<Count>3</Count>", renamed);
        string updated = TaskXml.WithAction(renamed, @"C:\b\NexusBrowser.exe", "--bridge --token-file \"C:\\x y\\t\"", @"C:\w");
        Assert.Equal(@"C:\b\NexusBrowser.exe", TaskXml.Command(updated));
        Assert.Equal("--bridge --token-file \"C:\\x y\\t\"", TaskXml.Arguments(updated));
        Assert.Contains("<Enabled>false</Enabled>", updated);
        Assert.Contains("<Count>3</Count>", updated);
    }

    [Fact]
    public void TheReleaseReceiptAllowsAReuseOnlyWhileThePackageIsUnchanged()
    {
        string package = Package("2.36.0");
        Make().Switch(package, From(package, Options()), new string('e', 64), sandbox: false);
        string current = Current()["exe"]!.ToString();
        _host.Calls.Clear();
        Assert.Equal(0, Make().Reuse(Options(register: false, updateOnly: true, controller: current)));
        Assert.Contains("retrying safe activation without downloading it again", _output.ToString());
        Assert.Single(_host.Registrations);
        File.AppendAllText(Path.Join(_layout.App, "extension", "manifest.json"), " ");
        Assert.Equal(Native.Installer.NotReusable, Make().Reuse(Options(register: false, updateOnly: true, controller: current)));
    }

    [Fact]
    public void TheLegacyRestoreAcceptsOnlyItsOwnLayoutAndAnUnchangedPayload()
    {
        // get.ps1 of 2.35.32 or earlier restores through this package's scripts\install-native.ps1, from app.failed.
        string first = Package("2.36.0", "first");
        Make().Switch(first, From(first, Options()), null, sandbox: false);
        File.Delete(_layout.CurrentFile);
        string digest = PayloadDigest.Compute(_layout.App);
        string failedController = Path.Join(_layout.App + ".failed", "engine", "NexusBrowser.exe");
        Directory.CreateDirectory(Path.GetDirectoryName(failedController)!);
        File.WriteAllText(failedController, "engine 2.36.1 new");

        Assert.Contains("Rollback source must be", Assert.Throws<InvalidOperationException>(() =>
            Make().Restore(_dir.Path, digest, Options(controller: failedController))).Message);
        Assert.Contains("Rollback source must be", Assert.Throws<InvalidOperationException>(() =>
            Make().Restore(_layout.App, digest, Options(controller: Path.Join(_dir.Path, "elsewhere", "engine", "NexusBrowser.exe")))).Message);
        Assert.Contains("Previous payload changed", Assert.Throws<InvalidDataException>(() =>
            Make().Restore(_layout.App, new string('0', 64), Options(controller: failedController))).Message);
        Assert.False(File.Exists(_layout.CurrentFile));  // refused before any change

        Assert.Equal(0, Make().Restore(_layout.App, digest, Options(register: false, updateOnly: true, controller: failedController)));
        Assert.Equal("2.36.0", Current()["version"]!.ToString());
    }

    [Fact]
    public void ACorruptBuildCacheIsNeverRunNorOverwritten()
    {
        string package = Package("2.36.0");
        string cache = Path.Join(_layout.Versions, Fingerprint(package)[..16], "NexusBrowser.exe");
        Directory.CreateDirectory(Path.GetDirectoryName(cache)!);
        File.WriteAllText(cache, "corrupt cache must never run");
        var error = Assert.Throws<InvalidDataException>(() => Make().Switch(package, From(package, Options()), null, sandbox: false));
        Assert.Contains("Installed build cache does not match", error.Message);
        Assert.Equal("corrupt cache must never run", File.ReadAllText(cache));
        Assert.DoesNotContain(_host.Calls, c => c.Exe == cache);
    }

    [Fact]
    public void ADevelopmentInstallOnlyRefreshesWhatIsInstalled()
    {
        // install.ps1 of a checkout (without -Register): its own build, no update task, existing clients refreshed only.
        string checkout = Package("2.36.0", "checkout");
        string build = Path.Join(checkout, "engine");
        Directory.Move(build, _dir["dev-build"]);
        Make().Core(checkout, Options(register: false, skipLaunch: true, controller: _dir["dev-build\\NexusBrowser.exe"]) with { Candidate = _dir["dev-build"] });
        Assert.Equal("2.36.0", Current()["version"]!.ToString());
        Assert.Null(_host.FakeTasks.Xml(TaskNames.Update));
        Assert.Single(_host.Registrations, r => r.EndsWith("--update-only", StringComparison.Ordinal));
        Assert.Equal(checkout, Files.ReadObject(Path.Join(Path.GetDirectoryName(Current()["exe"]!.ToString())!, "installation.json"))!["repository_root"]!.ToString());
    }

    [Fact]
    public void AWorkstationDeclaresTheSupervisedDaemonAndAntigravitysPluginOnce()
    {
        _host.FakeTasks.Definitions[TaskNames.Supervisor] = TaskXml.Build(new TaskXml.Options("sup", @"C:\s.exe", "", "", @"PC\tester"));
        string oneDrive = _dir["onedrive"];
        Directory.CreateDirectory(Path.Join(oneDrive, "Documents", "NexusSecure", "agents"));
        File.WriteAllText(Path.Join(oneDrive, "Documents", "NexusSecure", "agents", "nexus-mcp-token.txt"), new string('t', 64));
        _host.Variables["OneDrive"] = oneDrive;
        string agy = Path.Join(_layout.Home, ".gemini", "config");
        Directory.CreateDirectory(Path.Join(agy, "skills", "nexus-browser"));
        File.WriteAllText(Path.Join(agy, "mcp_config.json"), """{"mcpServers":{"nexus-browser":{"command":"x"},"other":{"command":"y"}}}""");
        File.WriteAllText(Path.Join(agy, "config.json"), """{"theme":"dark"}""");
        string package = Package("2.36.0");
        Directory.CreateDirectory(Path.Join(package, "plugin", "skills", "nexus-browser"));
        File.WriteAllText(Path.Join(package, "plugin", "plugin.json"), "{}");
        File.WriteAllText(Path.Join(package, "plugin", "logo.png"), "png");
        File.WriteAllText(Path.Join(package, "plugin", "skills", "nexus-browser", "SKILL.md"), "skill");

        Make().Switch(package, From(package, Options()), null, sandbox: false);
        var spec = Files.ReadObject(_layout.DaemonSpec)!;
        Assert.Equal(Current()["exe"]!.ToString(), spec["exe"]!.ToString());
        Assert.Equal(16182, spec["port"]!.GetValue<int>());
        Assert.Null(_host.FakeTasks.Xml(TaskNames.Daemon));  // the supervisor runs it
        var servers = Files.ReadObject(Path.Join(agy, "mcp_config.json"))!["mcpServers"]!.AsObject();
        Assert.False(servers.ContainsKey("nexus-browser"));
        Assert.True(servers.ContainsKey("other"));
        Assert.Equal("Bearer " + new string('t', 64), Files.ReadObject(Path.Join(agy, "plugins", "nexus-browser", "mcp_config.json"))!["mcpServers"]!["nexus-browser"]!["headers"]!["Authorization"]!.ToString());
        Assert.Equal("dark", Files.ReadObject(Path.Join(agy, "config.json"))!["theme"]!.ToString());
        Assert.True(Files.ReadObject(Path.Join(agy, "config.json"))!["plugins"]!["nexus-browser"]!["enabled"]!.GetValue<bool>());
        Assert.False(Directory.Exists(Path.Join(agy, "skills", "nexus-browser")));
    }

    [Fact]
    public void ActivationIsDoneOnlyWhenEveryComponentRunsTheInstalledBuild()
    {
        string hash = new('a', 64);
        var current = new JsonObject { ["version"] = "2.36.0", ["fingerprint"] = hash };
        JsonObject Daemon(string fingerprint) => new() { ["status"] = "ok", ["service"] = "nexus-browser", ["version"] = "2.36.0", ["fingerprint"] = fingerprint, ["pid"] = 1 };
        var bridge = new JsonObject { ["status"] = "online", ["version"] = "2.36.0", ["fingerprint"] = hash, ["pid"] = 2 };
        var done = Native.Installer.ActivationState(current, Daemon(hash), bridge, new JsonObject { ["verified"] = true }, "2.36.0");
        Assert.Equal("done", done["state"]!.ToString());
        Assert.Equal("2.36.0", done["active"]!.ToString());
        var stale = Native.Installer.ActivationState(current, Daemon(new string('b', 64)), bridge, new JsonObject { ["verified"] = true }, "2.36.0");
        Assert.Equal("deferred", stale["state"]!.ToString());
        Assert.Null(stale["active"]);
        Assert.Equal("daemon-activation-pending", stale["reason"]!.ToString());
        Assert.Equal("extension-activation-pending",
            Native.Installer.ActivationState(current, Daemon(hash), bridge, new JsonObject { ["verified"] = false }, "2.36.0")["reason"]!.ToString());
    }

    [Fact]
    public void Sha256SumsAreParsedStrictly()
    {
        string a = new('a', 64), b = new('B', 64);
        Assert.Equal(a, SelfUpdate.ExpectedHash($"{a}  NexusBrowser-win-x64.zip\r\n{b} *NexusBrowser-win-arm64.zip\n", "NexusBrowser-win-x64.zip"));
        Assert.Equal(b.ToLowerInvariant(), SelfUpdate.ExpectedHash($"{a}  NexusBrowser-win-x64.zip\n{b} *NexusBrowser-win-arm64.zip\n", "NexusBrowser-win-arm64.zip"));
        Assert.Contains("absent", Assert.Throws<InvalidDataException>(() => SelfUpdate.ExpectedHash($"{a}  NexusBrowser-win-x64.zip\n", "nexusbrowser-win-x64.zip")).Message);
        Assert.Contains("twice", Assert.Throws<InvalidDataException>(() => SelfUpdate.ExpectedHash($"{a}  X.zip\n{b}  X.zip\n", "X.zip")).Message);
        Assert.Contains("invalid line", Assert.Throws<InvalidDataException>(() => SelfUpdate.ExpectedHash($"{a}  X.zip\nnot a sum line\n", "X.zip")).Message);
        Assert.Contains("invalid line", Assert.Throws<InvalidDataException>(() => SelfUpdate.ExpectedHash($"{a[..63]}  X.zip\n", "X.zip")).Message);
        Assert.Matches(SelfUpdate.ReleaseTag(), "v2.36.0-dev.4");
        Assert.DoesNotMatch(SelfUpdate.ReleaseTag(), "2.36.0");
    }

    [Fact]
    public void TheTaskSchedulerApiKeepsWhatTheInstallerRegisters()
    {
        // The Task Scheduler's own COM API, on a throwaway task of this account (no trigger), removed at the end.
        var store = new WindowsTaskStore();
        string name = "NexusBrowser.Tests-" + Guid.NewGuid().ToString("N")[..12];
        try
        {
            Assert.Null(store.Xml(name));
            Assert.Equal("Absent", store.State(name));
            string user = System.Security.Principal.WindowsIdentity.GetCurrent().Name;
            store.Register(name, TaskXml.Build(new TaskXml.Options("NexusBrowser test task.", NativeExe.Path, "--version", _dir.Path, user, RestartCount: 3)));
            Assert.Equal("Ready", store.State(name));
            Assert.Equal(NativeExe.Path, TaskXml.Command(store.Xml(name)), ignoreCase: true);
            store.Register(name, FakeTasks.Disabled(TaskXml.WithAction(store.Xml(name)!, NativeExe.Path, "--version --again", _dir.Path)));
            Assert.Equal("Disabled", store.State(name));
            Assert.Equal("--version --again", TaskXml.Arguments(store.Xml(name)));
            Assert.Contains("<Count>3</Count>", store.Xml(name));
            string renamed = name + "-renamed";
            store.Register(renamed, TaskXml.ForRename(store.Xml(name)!));
            store.Delete(name);
            Assert.Equal("Disabled", store.State(renamed));
            store.Delete(renamed);
            Assert.Equal("Absent", store.State(renamed));
        }
        finally
        {
            store.Delete(name);
            store.Delete(name + "-renamed");
        }
    }

    [Fact]
    public void TheRealRegistryWritesInPlaceOrThroughItsOutOfPackageWorker()
    {
        // Out of a package the .NET API writes here; under a packaged app (a Claude session) a one-shot task runs this
        // engine's --registry-worker outside the package, its answer read back, the task and its files removed. Only a
        // throwaway key is touched.
        string key = @"HKCU\Software\NexusBrowser.Tests-" + Guid.NewGuid().ToString("N");
        string exchange = _dir["exchange"];
        try
        {
            var local = new RealRegistry(new FakeTasks(), "unused.exe", exchange, packaged: () => false);
            Assert.Equal(new string?[] { null, @"C:\x y\%TEMP%\m.json", @"C:\x y\%TEMP%\m.json", "true", "false" }, local.Apply([
                new("get", key), new("set", key + @"\host", @"C:\x y\%TEMP%\m.json"), new("get", key + @"\host"),
                new("remove", key + @"\host"), new("remove", key + @"\host")]));

            var tasks = new FakeTasks();
            tasks.OnRun = name =>
            {
                // What Windows does outside the package: the task's own command line runs.
                string[] argv = EngineProcesses.SplitCommandLine("NexusBrowser.exe " + TaskXml.Arguments(tasks.Xml(name)));
                Assert.Equal("--registry-worker", argv[1]);
                Assert.Equal(0, RealRegistry.Worker(Program.GetArgValue(argv, "--request")!, Program.GetArgValue(argv, "--response")!));
            };
            var packaged = new RealRegistry(tasks, @"C:\engine\NexusBrowser.exe", exchange, packaged: () => true, userId: @"PC\tester");
            Assert.Equal(new string?[] { "w", "w", null }, packaged.Apply([new("set", key + @"\worker", "w"), new("get", key + @"\worker"), new("get", key + @"\none")]));
            Assert.Single(tasks.Started);
            Assert.Empty(tasks.Definitions);
            Assert.Empty(Directory.EnumerateFiles(exchange));
            _ = RealRegistry.HasPackagedAncestor();  // reads this process's ancestors without failing
        }
        finally { Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(key[5..], false); }
    }
}