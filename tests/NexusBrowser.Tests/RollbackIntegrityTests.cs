using Xunit;
using NexusBrowser.Native;

namespace NexusBrowser.Tests;

/// <summary>A rollback is bound to the exact previous payload: the engine's digest (PayloadDigest) is the one
/// scripts\payload-integrity.ps1 computes, the script get.ps1 of 2.35.32 and earlier runs from the NEW package before
/// it hands the restore to that package (scripts\install-native.ps1, then the engine). Both must agree byte for byte.</summary>
public sealed class RollbackIntegrityTests : IDisposable
{
    private readonly TempDir _dir = new();
    public void Dispose() => _dir.Dispose();

    [Theory]
    [InlineData(Shells.WindowsPowerShell)]
    [InlineData(Shells.Pwsh)]
    public async Task TheEnginesPayloadDigestIsTheOneOlderInstallersCompute(string shell)
    {
        string payload = _dir["app"];
        Directory.CreateDirectory(Path.Join(payload, "engine"));
        Directory.CreateDirectory(Path.Join(payload, "Extension", "icons"));
        File.WriteAllText(Path.Join(payload, "engine", "NexusBrowser.exe"), "payload data");
        File.WriteAllText(Path.Join(payload, "install.ps1"), "throw 'This legacy installer must never run'");
        File.WriteAllText(Path.Join(payload, "Extension", "icons", "B.png"), "b");
        File.WriteAllText(Path.Join(payload, "Extension", "a.js"), "a");
        File.WriteAllText(Path.Join(payload, "VERSION"), "2.36.0");
        async Task<string> Script()
        {
            var result = await Shells.FileAsync(shell, Repo.File("scripts", "payload-integrity.ps1"), ["-Path", payload]);
            Assert.True(result.Code == 0, result.Stdout + result.Stderr);
            return result.Stdout.Trim();
        }
        string first = PayloadDigest.Compute(payload);
        Assert.Matches("^[0-9a-f]{64}$", first);
        Assert.Equal(first, await Script());
        File.AppendAllText(Path.Join(payload, "install.ps1"), "\n# changed");
        string changed = PayloadDigest.Compute(payload);
        Assert.NotEqual(first, changed);
        Assert.Equal(changed, await Script());
    }
}
