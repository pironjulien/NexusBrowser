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
    public async Task ProcessImagesAreReadByQueryFullProcessImageName()
    {
        // The script's own PowerShell is among the pwsh processes, found by its image path.
        string[] lines = await RuntimeAsync("$i = Get-ProcessImages 'pwsh'; [string]($i.Paths -contains [Environment]::ProcessPath)");
        Assert.Equal(["True"], lines);
    }
}
