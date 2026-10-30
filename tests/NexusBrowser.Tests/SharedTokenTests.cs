using System.Text;
using Xunit;

namespace NexusBrowser.Tests;

public sealed class SharedTokenTests : IDisposable
{
    private readonly TempDir _dir = new();
    public void Dispose() => _dir.Dispose();

    [Theory]
    [InlineData(Shells.WindowsPowerShell)]
    [InlineData(Shells.Pwsh)]
    public async Task ConcurrentInstallersReuseOneTokenAndRepairAnEmptyFile(string shell)
    {
        string tokenFile = _dir[Path.Combine("shared", "token.txt")];
        Directory.CreateDirectory(Path.GetDirectoryName(tokenFile)!);
        string script = _dir["resolve.ps1"];
        File.WriteAllText(script, $"""
            $ErrorActionPreference = 'Stop'
            . {Shells.Quote(Repo.File("scripts", "Resolve-NexusToken.ps1"))}
            $file = Resolve-NexusTokenFile -Explicit @({Shells.Quote(tokenFile)})
            [IO.File]::ReadAllText($file).Trim()
            """, Encoding.ASCII);

        async Task<string> Run()
        {
            var result = await Shells.FileAsync(shell, script);
            Assert.True(result.Code == 0, result.Stderr);
            return result.Stdout.Trim();
        }

        foreach (bool emptyFile in new[] { false, true })
        {
            if (emptyFile) File.WriteAllText(tokenFile, "");
            var tokens = await Task.WhenAll(Run(), Run());
            Assert.Equal(tokens[0], tokens[1]);
            Assert.Matches("^[0-9a-f]{64}$", tokens[0]);
            Assert.Equal(tokens[0], File.ReadAllText(tokenFile));
            Assert.Equal(tokens[0], await Run());
        }

        const string existing = "already-installed-token-shared-by-every-daemon";
        File.WriteAllText(tokenFile, existing + "\n");
        Assert.Equal(existing, await Run());
        Assert.Equal(existing + "\n", File.ReadAllText(tokenFile));
    }
}
