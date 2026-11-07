using NexusBrowser.Native;
using Xunit;

namespace NexusBrowser.Tests;

/// <summary>
/// The cleanup of older engine builds (native\InstallSupport.cs, EngineBuilds) keeps a folder whose engine.lock an
/// engine holds, keeps every folder while a running engine cannot be read, and reads process images with
/// QueryFullProcessImageNameW. Windows renames the folder of a running single-file program (only mapped, no file open),
/// so neither a rename nor WMI's ExecutablePath (empty for an elevated process) can tell a folder in use.
/// </summary>
public sealed class EngineCleanupTests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    private static string Build(string versions, string name)
    {
        string folder = Path.Join(versions, name);
        Directory.CreateDirectory(folder);
        File.WriteAllText(Path.Join(folder, "NexusBrowser.exe"), "engine");
        File.WriteAllText(Path.Join(folder, "engine.lock"), "");
        return folder;
    }

    [Fact]
    public void AFolderWhoseEngineLockIsHeldStaysUntilReleased()
    {
        string versions = _dir["versions"];
        string held = Build(versions, "aaaaaaaaaaaaaaaa"), keep = Build(versions, "bbbbbbbbbbbbbbbb");
        using (new FileStream(Path.Join(held, "engine.lock"), FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        {
            EngineBuilds.RemoveUnused(versions, [keep], ProcessImages.None);
            Assert.True(File.Exists(Path.Join(held, "NexusBrowser.exe")));
            Assert.Equal(2, Directory.EnumerateDirectories(versions).Count());
        }
        EngineBuilds.RemoveUnused(versions, [keep], ProcessImages.None);
        Assert.Equal([keep], Directory.EnumerateDirectories(versions));
    }

    [Fact]
    public void NothingIsRemovedWhileARunningEngineCannotBeRead()
    {
        string versions = _dir["versions"];
        string old = Build(versions, "aaaaaaaaaaaaaaaa"), keep = Build(versions, "bbbbbbbbbbbbbbbb");
        EngineBuilds.RemoveUnused(versions, [keep], new ProcessImages([], Unknown: true));
        Assert.True(File.Exists(Path.Join(old, "NexusBrowser.exe")));
    }

    [Fact]
    public void AFolderAProcessImageIsInStays()
    {
        string versions = _dir["versions"];
        string used = Build(versions, "aaaaaaaaaaaaaaaa"), keep = Build(versions, "bbbbbbbbbbbbbbbb");
        File.Delete(Path.Join(used, "engine.lock"));  // a build installed before the lock existed
        EngineBuilds.RemoveUnused(versions, [keep], new ProcessImages([Path.Join(used, "NexusBrowser.exe")], false));
        Assert.True(Directory.Exists(used));
    }

    [Fact]
    public void ALeftoverWhoseEngineLockIsHeldStaysWhole()
    {
        string versions = _dir["versions"];
        string keep = Build(versions, "bbbbbbbbbbbbbbbb");
        string leftover = Build(versions, "aaaaaaaaaaaaaaaa.42.removing");
        string legacy = Build(_dir["root"], "native.43.removing");
        using (new FileStream(Path.Join(leftover, "engine.lock"), FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        using (new FileStream(Path.Join(legacy, "engine.lock"), FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        {
            EngineBuilds.RemoveUnused(versions, [keep], ProcessImages.None);
            Assert.Empty(EngineBuilds.RemoveLeftovers(Path.Join(_dir["root"], "native"), ProcessImages.None));
            Assert.True(EngineBuilds.InUse(leftover, ProcessImages.None));
            Assert.True(File.Exists(Path.Join(leftover, "NexusBrowser.exe")));
            Assert.True(File.Exists(Path.Join(legacy, "NexusBrowser.exe")));
        }
        Assert.False(EngineBuilds.InUse(leftover, ProcessImages.None));
    }

    [Fact]
    public void LeftoversOfAnUnfinishedRemovalGoOnALaterPass()
    {
        // The installer renames the legacy engine folder and the former venv aside before deleting them; what a
        // still-open file kept is removed on a later pass, the folder itself having gone.
        string root = _dir["root"];
        string legacy = Build(root, "native.1234.removing");
        string venv = Path.Join(root, "venv.77.removing");
        Directory.CreateDirectory(Path.Join(venv, "Scripts"));
        File.WriteAllText(Path.Join(venv, "Scripts", "python.exe"), "python");
        string other = Build(root, "native-other.5.removing"), unrelated = Build(root, "native.removing");

        // While a candidate process cannot be read, nothing goes.
        Assert.Empty(EngineBuilds.RemoveLeftovers(Path.Join(root, "native"), new ProcessImages([], Unknown: true)));
        Assert.True(Directory.Exists(legacy));

        Assert.Equal([legacy], EngineBuilds.RemoveLeftovers(Path.Join(root, "native"), ProcessImages.None));
        Assert.Equal([venv], EngineBuilds.RemoveLeftovers(Path.Join(root, "venv"), ProcessImages.None));
        Assert.False(Directory.Exists(legacy));
        Assert.False(Directory.Exists(venv));
        Assert.True(Directory.Exists(other));
        Assert.True(Directory.Exists(unrelated));
    }

    [Fact]
    public void AnEngineIsInstalledOnceInAFolderNamedByItsFingerprint()
    {
        string candidate = _dir["candidate"];
        Directory.CreateDirectory(candidate);
        File.WriteAllText(Path.Join(candidate, "NexusBrowser.exe"), "engine bytes");
        string versions = _dir["versions"];
        var first = EngineBuilds.Install(candidate, versions);
        Assert.True(first.New);
        Assert.Equal(Path.Join(versions, first.Fingerprint[..16]), first.Directory);
        Assert.True(File.Exists(Path.Join(first.Directory, "engine.lock")));
        var again = EngineBuilds.Install(candidate, versions);
        Assert.False(again.New);
        Assert.Equal(first.Directory, again.Directory);
        // A framework-dependent build is named by its main assembly, as the engine's own fingerprint.
        File.WriteAllText(Path.Join(candidate, "NexusBrowser.dll"), "assembly bytes");
        Assert.Equal(Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData("assembly bytes"u8.ToArray())), EngineBuilds.Fingerprint(candidate));
    }

    [Fact]
    public void ProcessImagesAreReadByQueryFullProcessImageName()
    {
        // A child of this account, read by its image path (the reader itself is never listed).
        using var child = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("pwsh.exe", "-NoProfile -NonInteractive -Command Start-Sleep 30")
        { UseShellExecute = false, CreateNoWindow = true })!;
        try
        {
            // Its image is readable once the process is initialized (a loaded PC can take a moment).
            string? image = null;
            for (var until = DateTime.UtcNow.AddSeconds(30); image is null && DateTime.UtcNow < until; Thread.Sleep(50))
                image = EngineProcesses.Read(child.Id).Image;
            Assert.EndsWith("pwsh.exe", image, StringComparison.OrdinalIgnoreCase);
            Assert.Contains(image, ProcessImages.Read("pwsh").Paths, StringComparer.OrdinalIgnoreCase);
        }
        finally { child.Kill(); child.WaitForExit(); }
    }

    [Fact]
    public void TheInstallerReadsBridgesAndDaemonsThroughTheEngine()
    {
        // Bridges and daemons are listed by the engine (EngineProcessesTests: real processes); WMI gave neither path
        // nor command line for an engine started as administrator. A task starts only when no instance of its role may run.
        string install = File.ReadAllText(Repo.File("native", "Installer.cs"));
        Assert.DoesNotContain("Win32_Process", install);
        Assert.Contains("EngineSplit.Of(host.EngineProcesses(), EngineProcesses.Bridge, exe)", install);
        Assert.Contains("EngineSplit.Of(host.EngineProcesses(), EngineProcesses.Daemon, exe)", install);
        Assert.Contains("TaskNames.ShouldStart(tasks.State(names.Bridge), running.Instances.Count)", install);
    }
}
