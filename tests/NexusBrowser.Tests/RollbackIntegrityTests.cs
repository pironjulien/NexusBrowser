using System.Text;
using Xunit;

namespace NexusBrowser.Tests;

public sealed class RollbackIntegrityTests : IDisposable
{
    private readonly TempDir _dir = new();
    public void Dispose() => _dir.Dispose();

    [Theory]
    [InlineData(Shells.WindowsPowerShell)]
    [InlineData(Shells.Pwsh)]
    public async Task PayloadDigestBindsEveryFileWithoutExecutingTheLegacyInstaller(string shell)
    {
        string payload = _dir["app"];
        Directory.CreateDirectory(Path.Join(payload, "engine"));
        File.WriteAllText(Path.Join(payload, "engine", "NexusBrowser.exe"), "payload data");
        File.WriteAllText(Path.Join(payload, "install.ps1"), "throw 'This legacy installer must never run'");
        async Task<string> Digest()
        {
            var result = await Shells.FileAsync(shell, Repo.File("scripts", "payload-integrity.ps1"), ["-Path", payload]);
            Assert.True(result.Code == 0, result.Stdout + result.Stderr);
            Assert.Matches("^[0-9a-f]{64}$", result.Stdout.Trim());
            return result.Stdout.Trim();
        }
        string first = await Digest();
        Assert.Equal(first, await Digest());
        File.AppendAllText(Path.Join(payload, "install.ps1"), "\n# changed");
        Assert.NotEqual(first, await Digest());
    }

    [Theory]
    [InlineData(Shells.WindowsPowerShell)]
    [InlineData(Shells.Pwsh)]
    public async Task RollbackRejectsAChangedOrUnownedPayloadBeforeWritingConfiguration(string shell)
    {
        string local = _dir["local"];
        string home = _dir["home"];
        string root = Path.Join(local, "NexusBrowser");
        string app = Path.Join(root, "app");
        string controller = Path.Join(root, "app.failed", "scripts");
        Directory.CreateDirectory(app);
        Directory.CreateDirectory(controller);
        foreach (string name in new[] { "install-native.ps1", "runtime.ps1", "Resolve-NexusToken.ps1", "payload-integrity.ps1" })
            File.Copy(Repo.File("scripts", name), Path.Join(controller, name));
        File.WriteAllText(Path.Join(app, "install.ps1"), "throw 'Legacy installer trap'");
        var env = new Dictionary<string, string?> { ["LOCALAPPDATA"] = local, ["USERPROFILE"] = home, ["HOME"] = home };
        var result = await Shells.FileAsync(shell, Path.Join(controller, "install-native.ps1"),
            ["-PayloadRoot", app, "-ExpectedPayloadHash", new string('0', 64), "-SkipTests", "-SkipLaunch"], env);
        Assert.NotEqual(0, result.Code);
        Assert.Contains("Previous payload changed", result.Stdout + result.Stderr);
        Assert.False(File.Exists(Path.Join(root, "current.json")));
        Assert.False(Directory.Exists(Path.Join(home, ".nexus", "nexus-browser")));
        var wrongRoot = await Shells.FileAsync(shell, Path.Join(controller, "install-native.ps1"),
            ["-PayloadRoot", _dir.Path, "-ExpectedPayloadHash", new string('0', 64), "-SkipTests", "-SkipLaunch"], env);
        Assert.NotEqual(0, wrongRoot.Code);
        Assert.Contains("Rollback source must be", wrongRoot.Stdout + wrongRoot.Stderr);
    }

    [Theory]
    [InlineData(Shells.WindowsPowerShell)]
    [InlineData(Shells.Pwsh)]
    public async Task CorruptCachedEngineIsRejectedBeforeExecutionAndNeverOverwritten(string shell)
    {
        string local = _dir["local"];
        string home = _dir["home"];
        string root = Path.Join(local, "NexusBrowser");
        string app = Path.Join(root, "app");
        string controller = Path.Join(root, "app.failed");
        Directory.CreateDirectory(Path.Join(app, "engine"));
        Directory.CreateDirectory(Path.Join(controller, "scripts"));
        Directory.CreateDirectory(Path.Join(controller, "engine"));
        foreach (string name in new[] { "install-native.ps1", "runtime.ps1", "Resolve-NexusToken.ps1", "payload-integrity.ps1" })
            File.Copy(Repo.File("scripts", name), Path.Join(controller, "scripts", name));
        File.WriteAllText(Path.Join(controller, "engine", "NexusBrowser.exe"), "current controller engine fixture");
        File.WriteAllText(Path.Join(app, "engine", "NexusBrowser.exe"), "verified previous payload bytes");
        File.WriteAllText(Path.Join(app, "VERSION"), "2.33.0");
        string fingerprint = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(Path.Join(app, "engine", "NexusBrowser.exe"))));
        string cache = Path.Join(root, "versions", fingerprint[..16], "NexusBrowser.exe");
        Directory.CreateDirectory(Path.GetDirectoryName(cache)!);
        File.WriteAllText(cache, "corrupt cache must never run");
        var digest = await Shells.FileAsync(shell, Repo.File("scripts", "payload-integrity.ps1"), ["-Path", app]);
        Assert.Equal(0, digest.Code);
        var result = await Shells.FileAsync(shell, Path.Join(controller, "scripts", "install-native.ps1"),
            ["-PayloadRoot", app, "-ExpectedPayloadHash", digest.Stdout.Trim(), "-SkipTests", "-SkipLaunch"],
            new Dictionary<string, string?> { ["LOCALAPPDATA"] = local, ["USERPROFILE"] = home, ["HOME"] = home });
        Assert.NotEqual(0, result.Code);
        Assert.Contains("Installed build cache does not match", result.Stdout + result.Stderr);
        Assert.Equal("corrupt cache must never run", File.ReadAllText(cache));
        Assert.False(File.Exists(Path.Join(root, "current.json")));
    }
}
