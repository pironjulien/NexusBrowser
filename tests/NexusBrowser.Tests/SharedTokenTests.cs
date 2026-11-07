using NexusBrowser.Native;
using Xunit;

namespace NexusBrowser.Tests;

/// <summary>One shared MCP token per PC (native\InstallSupport.cs, SharedToken): concurrent installers end with the same
/// token, an empty file is repaired, an existing token is never regenerated, a daemon reading it never blocks them.</summary>
public sealed class SharedTokenTests : IDisposable
{
    private readonly TempDir _dir = new();
    public void Dispose() => _dir.Dispose();

    [Fact]
    public async Task ConcurrentInstallersReuseOneTokenAndRepairAnEmptyFile()
    {
        string tokenFile = _dir[Path.Join("shared", "token.txt")];
        Directory.CreateDirectory(Path.GetDirectoryName(tokenFile)!);
        string Run() => File.ReadAllText(SharedToken.ResolveFile([tokenFile], _dir["home"])).Trim();

        foreach (bool emptyFile in new[] { false, true })
        {
            if (emptyFile) File.WriteAllText(tokenFile, "");
            var tokens = await Task.WhenAll(Task.Run(Run), Task.Run(Run));
            Assert.Equal(tokens[0], tokens[1]);
            Assert.Matches("^[0-9a-f]{64}$", tokens[0]);
            Assert.Equal(tokens[0], File.ReadAllText(tokenFile));
            Assert.Equal(tokens[0], Run());
        }

        const string existing = "already-installed-token-shared-by-every-daemon";
        File.WriteAllText(tokenFile, existing + "\n");
        Assert.Equal(existing, Run());
        Assert.Equal(existing + "\n", File.ReadAllText(tokenFile));
        using var reader = File.Open(tokenFile, FileMode.Open, FileAccess.Read, FileShare.Read);
        Assert.Equal(existing, Run()); // existing daemon readers remain compatible with installer serialization
    }

    [Fact]
    public void WithoutAnExplicitFileTheTokenLivesInTheUsersNexusFolder()
    {
        string home = _dir["home"];
        Assert.Equal(Path.Join(home, ".nexus", "mcp-token.txt"), SharedToken.ResolveFile([null, ""], home));
    }
}
