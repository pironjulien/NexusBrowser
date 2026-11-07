using System.Text;
using Xunit;

namespace NexusBrowser.Tests;

/// <summary>
/// The cleanup of older engine builds (scripts\runtime.ps1, Remove-UnusedEngineBuilds) keeps a folder whose engine.lock
/// an engine holds, keeps every folder while a running engine cannot be read, and reads process images with
/// QueryFullProcessImageNameW. Windows renames the folder of a running single-file program (only mapped, no file open),
/// so neither a rename nor WMI's ExecutablePath (empty for an elevated process) can tell a folder in use.
/// </summary>
public sealed class EngineCleanupTests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    private async Task<string[]> RuntimeAsync(string commands)
    {
        string script = _dir[$"runtime-{Guid.NewGuid():N}.ps1"];
        File.WriteAllText(script, $"$ErrorActionPreference = 'Stop'\n. {Shells.Quote(Repo.File("scripts", "runtime.ps1"))}\n{commands}\n", Encoding.ASCII);
        var (code, stdout, stderr) = await Shells.FileAsync(Shells.Pwsh, script, timeoutSeconds: 120);
        Assert.True(code == 0, stdout + stderr);
        return Shells.Lines(stdout);
    }

    private static string Build(string versions, string name)
    {
        string folder = Path.Join(versions, name);
        Directory.CreateDirectory(folder);
        File.WriteAllText(Path.Join(folder, "NexusBrowser.exe"), "engine");
        File.WriteAllText(Path.Join(folder, "engine.lock"), "");
        return folder;
    }

    private const string NoProcess = "([pscustomobject]@{ Paths = @(); Unknown = $false })";

    [Fact]
    public async Task AFolderWhoseEngineLockIsHeldStaysUntilReleased()
    {
        string versions = _dir["versions"];
        string held = Build(versions, "aaaaaaaaaaaaaaaa"), keep = Build(versions, "bbbbbbbbbbbbbbbb");
        string command = $"Remove-UnusedEngineBuilds {Shells.Quote(versions)} {Shells.Quote(keep)} {NoProcess}";
        using (new FileStream(Path.Join(held, "engine.lock"), FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        {
            await RuntimeAsync(command);
            Assert.True(File.Exists(Path.Join(held, "NexusBrowser.exe")));
            Assert.Equal(2, Directory.EnumerateDirectories(versions).Count());
        }
        await RuntimeAsync(command);
        Assert.Equal([keep], Directory.EnumerateDirectories(versions));
    }

    [Fact]
    public async Task NothingIsRemovedWhileARunningEngineCannotBeRead()
    {
        string versions = _dir["versions"];
        string old = Build(versions, "aaaaaaaaaaaaaaaa"), keep = Build(versions, "bbbbbbbbbbbbbbbb");
        await RuntimeAsync($"Remove-UnusedEngineBuilds {Shells.Quote(versions)} {Shells.Quote(keep)} ([pscustomobject]@{{ Paths = @(); Unknown = $true }})");
        Assert.True(File.Exists(Path.Join(old, "NexusBrowser.exe")));
    }

    [Fact]
    public async Task AFolderAProcessImageIsInStays()
    {
        string versions = _dir["versions"];
        string used = Build(versions, "aaaaaaaaaaaaaaaa"), keep = Build(versions, "bbbbbbbbbbbbbbbb");
        File.Delete(Path.Join(used, "engine.lock"));  // a build installed before the lock existed
        string image = Shells.Quote(Path.Join(used, "NexusBrowser.exe"));
        await RuntimeAsync($"Remove-UnusedEngineBuilds {Shells.Quote(versions)} {Shells.Quote(keep)} ([pscustomobject]@{{ Paths = @({image}); Unknown = $false }})");
        Assert.True(Directory.Exists(used));
    }

    [Fact]
    public async Task ALeftoverWhoseEngineLockIsHeldStaysWhole()
    {
        // No rename here: a leftover set aside is deleted directly, so only Test-FolderInUse's lock check keeps it whole
        // (without it, every file but the held lock would go).
        string versions = _dir["versions"];
        string keep = Build(versions, "bbbbbbbbbbbbbbbb");
        string leftover = Build(versions, "aaaaaaaaaaaaaaaa.42.removing");
        string legacy = Build(_dir["root"], "native.43.removing");
        string lockedProbe = $"[string](Test-FolderInUse {Shells.Quote(leftover)} {NoProcess})";
        using (new FileStream(Path.Join(leftover, "engine.lock"), FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        using (new FileStream(Path.Join(legacy, "engine.lock"), FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        {
            string[] lines = await RuntimeAsync(
                $"Remove-UnusedEngineBuilds {Shells.Quote(versions)} {Shells.Quote(keep)} {NoProcess}\n" +
                $"$null = Remove-FolderLeftovers {Shells.Quote(Path.Join(_dir["root"], "native"))} {NoProcess}\n" + lockedProbe);
            Assert.Equal(["True"], lines);
            Assert.True(File.Exists(Path.Join(leftover, "NexusBrowser.exe")));
            Assert.True(File.Exists(Path.Join(legacy, "NexusBrowser.exe")));
        }
        Assert.Equal(["False"], await RuntimeAsync(lockedProbe));
    }

    [Fact]
    public async Task LeftoversOfAnUnfinishedRemovalGoOnALaterPass()
    {
        // install-native.ps1 renames the legacy engine folder and the former venv aside before deleting them; what a
        // still-open file kept is removed on a later pass, the folder itself having gone.
        string root = _dir["root"];
        string legacy = Build(root, "native.1234.removing");
        string venv = Path.Join(root, "venv.77.removing");
        Directory.CreateDirectory(Path.Join(venv, "Scripts"));
        File.WriteAllText(Path.Join(venv, "Scripts", "python.exe"), "python");
        string other = Build(root, "native-other.5.removing"), unrelated = Build(root, "native.removing");
        string native = Shells.Quote(Path.Join(root, "native")), venvRoot = Shells.Quote(Path.Join(root, "venv"));

        // While a candidate process cannot be read, nothing goes.
        await RuntimeAsync($"$null = Remove-FolderLeftovers {native} ([pscustomobject]@{{ Paths = @(); Unknown = $true }})");
        Assert.True(Directory.Exists(legacy));

        string[] lines = await RuntimeAsync($"Remove-FolderLeftovers {native} {NoProcess}\nRemove-FolderLeftovers {venvRoot} {NoProcess}");
        Assert.Equal([legacy, venv], lines);
        Assert.False(Directory.Exists(legacy));
        Assert.False(Directory.Exists(venv));
        Assert.True(Directory.Exists(other));
        Assert.True(Directory.Exists(unrelated));

        string install = File.ReadAllText(Repo.File("scripts", "install-native.ps1"));
        Assert.Contains("Remove-FolderLeftovers $legacyDir $engineImages", install);
        Assert.Contains("Remove-FolderLeftovers $oldVenv $pythonImages", install);
    }

    [Fact]
    public void TheInstallerReadsBridgesAndDaemonsThroughTheEngine()
    {
        // Bridges and daemons are listed by the engine (EngineProcessesTests: real processes); WMI gave neither path
        // nor command line for an engine started as administrator.
        string install = File.ReadAllText(Repo.File("scripts", "install-native.ps1"));
        string runtime = File.ReadAllText(Repo.File("scripts", "runtime.ps1"));
        Assert.DoesNotContain("Win32_Process", install + runtime);
        Assert.DoesNotContain("ExecutablePath", install);
        Assert.Contains("Split-EngineProcesses (Get-EngineProcesses $controlExe) 'bridge' $exe", install);
        Assert.Contains("Split-EngineProcesses (Get-EngineProcesses $controlExe) 'daemon' $exe", install);
        // A task starts only when no instance of its role may run (unknown roles included).
        Assert.Contains("(Split-EngineProcesses (Get-EngineProcesses $controlExe) 'daemon' $exe).Instances.Count", install);
        Assert.Contains("Test-TaskStart (Get-ScheduledTask -TaskName $bridgeTaskName).State $runningBridges.Instances.Count", install);
    }

    [Fact]
    public async Task AFolderIsKeptWhileAProcessImageCannotBeRead()
    {
        // The reading function itself is replaced: every process runs but cannot be read.
        string[] lines = await RuntimeAsync("function Read-ProcessImage([int]$Id) { $null }\n[string](Get-ProcessImages 'pwsh').Unknown");
        Assert.Equal(["True"], lines);
    }

    [Fact]
    public async Task ProcessImagesAreReadByQueryFullProcessImageName()
    {
        // The script's own PowerShell is among the pwsh processes, found by its image path.
        string[] lines = await RuntimeAsync("$i = Get-ProcessImages 'pwsh'; [string]($i.Paths -contains [Environment]::ProcessPath)");
        Assert.Equal(["True"], lines);
    }
}
