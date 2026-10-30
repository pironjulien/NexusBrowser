using NexusBrowser.Native;
using Xunit;

namespace NexusBrowser.Tests;

public sealed class RestartRequestTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("nb-restart-").FullName;
    private string Request => Path.Combine(_dir, "daemon-restart.request");

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    [Fact]
    public void NoRequestNeverRestarts() => Assert.False(RestartRequest.Wanted(Request, "abc"));

    [Fact]
    public void SameBuildIsKeptAndTheRequestIsConsumed()
    {
        File.WriteAllText(Request, "code sha256:ABC");
        Assert.False(RestartRequest.Wanted(Request, "abc"));
        Assert.False(File.Exists(Request));
    }

    [Fact]
    public void AnotherBuildOrForceRestarts()
    {
        File.WriteAllText(Request, "code sha256:def");
        Assert.True(RestartRequest.Wanted(Request, "abc"));
        File.WriteAllText(Request, "force");
        Assert.True(RestartRequest.Wanted(Request, "abc"));
    }

    [Fact]
    public void RequestForAnotherProcessIsLeftForIt()
    {
        File.WriteAllText(Request, $"force pid:{Environment.ProcessId + 1}");
        Assert.False(RestartRequest.Wanted(Request, "abc"));
        Assert.True(File.Exists(Request));
    }

    [Fact]
    public async Task DaemonStopsOnlyOnceNoCallIsRunning()
    {
        File.WriteAllText(Request, "force");
        using var server = new McpServer(agent: "Claude", bridgeHttpPort: 1);
        using var stop = new CancellationTokenSource();
        await server.WatchRestartRequestAsync(Request, stop, TestContext.Current.CancellationToken, pollSeconds: 0.05);
        Assert.True(stop.IsCancellationRequested);
    }

    [Fact]
    public void FingerprintIsTheRunningCode() => Assert.Matches("^[0-9a-f]{64}$", RestartRequest.CodeFingerprint());

    [Theory]
    [InlineData("0123456789abcdef0123456789abcdef", true)]
    [InlineData("different-instance", false)]
    [InlineData(null, false)]
    public void SessionPreservingRequestTargetsOneInstanceAndIsInertToLegacyWatchers(string? instance, bool wanted)
    {
        const string actual = "0123456789abcdef0123456789abcdef";
        string content = $"sessions-v1 code:{new string('a', 64)} pid:{Environment.ProcessId} instance:{actual}";
        File.WriteAllText(Request, content);
        // Exact old-watcher decision, not a version regex or an assumption about its request prefix.
        string? legacyTarget = content.Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault(s => s.StartsWith("sha256:", StringComparison.Ordinal))?[7..];
        Assert.False(content.StartsWith("force", StringComparison.Ordinal) || legacyTarget is not null && legacyTarget != "loaded");
        Assert.Equal(wanted, RestartRequest.Wanted(Request, "loaded", instance));
        File.WriteAllText(Request, content.Replace($"pid:{Environment.ProcessId}", $"pid:{Environment.ProcessId + 1}"));
        Assert.False(RestartRequest.Wanted(Request, "loaded", actual));
        Assert.True(File.Exists(Request));
    }
}
