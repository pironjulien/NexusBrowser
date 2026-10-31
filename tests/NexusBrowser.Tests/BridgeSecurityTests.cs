using System.Diagnostics;
using NexusBrowser.Native;
using Xunit;

namespace NexusBrowser.Tests;

/// <summary>Identity, pid and upload guards of the bridge (former --selftest, suite 3).</summary>
public sealed class BridgeSecurityTests
{
    [Fact]
    public void CurrentProcessIsRunningAndAnExitedOneIsNot()
    {
        Assert.True(BridgeSecurity.ProcessRunning(Environment.ProcessId));
        using var exited = Process.Start(new ProcessStartInfo("cmd.exe", "/c exit 0") { CreateNoWindow = true, UseShellExecute = false })!;
        exited.WaitForExit(5000);
        int pid = exited.Id;
        exited.Dispose(); // the handle we hold would keep the process object alive
        Assert.False(BridgeSecurity.ProcessRunning(pid));
        Assert.False(BridgeSecurity.ProcessRunning(0));
        Assert.False(BridgeSecurity.ProcessRunning(1L << 32));
    }

    [Theory]
    [InlineData("1234", 1234L)]
    [InlineData(" 42 ", 42L)]
    [InlineData("0", null)]
    [InlineData("-5", null)]
    [InlineData("4294967296", null)]
    [InlineData("12a", null)]
    [InlineData("", null)]
    [InlineData(null, null)]
    public void CheckPid(string? value, long? expected) => Assert.Equal(expected, BridgeSecurity.CheckPid(value));

    [Fact]
    public void CheckIdentity()
    {
        Assert.Equal(("Claude", "claude-123456"), BridgeSecurity.CheckIdentity("Claude", "claude-123456"));
        Assert.Equal(("Installer", "installer-0123456789ab"), BridgeSecurity.CheckIdentity(ExtensionRefresh.InstallerAgent, "installer-0123456789ab"));
        Assert.Null(BridgeSecurity.CheckIdentity(null, "claude-123456"));
        Assert.Null(BridgeSecurity.CheckIdentity("Claude", null));
    }

    public static TheoryData<string> ProtectedPaths()
    {
        string home = BridgeSecurity.HomeDir();
        return new TheoryData<string>
        {
            Path.Join(home, ".ssh", "id_ed25519"),
            Path.Join(home, ".ssh.", "id_ed25519"),
            Path.Join(home, ".nexus", "nexus-browser", "bridge-token"),
            Path.Join(home, "Documents", "NexusSecure", "secret.txt"),
            @"\\127.0.0.1\c$" + Path.Join(home, ".ssh", "id_rsa")[2..],
            @"\\?\" + Path.Join(home, ".codex", "auth.json"),
        };
    }

    [Theory]
    [MemberData(nameof(ProtectedPaths))]
    public void UploadFromASecretsFolderIsRefused(string path)
    {
        string? refusal = BridgeSecurity.UploadRefusal([path]);
        Assert.NotNull(refusal);
        Assert.Contains("secrets folder", refusal, StringComparison.Ordinal);
    }

    [Fact]
    public void UploadFromTempIsAllowed() =>
        Assert.Null(BridgeSecurity.UploadRefusal([Path.Join(Path.GetTempPath(), "safe-upload.txt")]));
}

/// <summary>Chrome startup on the installed Default profile (former --selftest ChromeLauncher checks). No real
/// Chrome is located or started: every dependency is injected.</summary>
public sealed class ChromeLauncherTests
{
    private const string Allowed = "--lang=fr-FR --accept-lang=fr-FR,fr,en-US,en --variations-override-country=us --disable-features=GlicCountryFiltering,GlicLocaleFiltering --force-dark-mode";
    private const string Forbidden = "--disable-web-security --headless --user-data-dir=C:/temp --load-extension=C:/x --remote-debugging-port=9222 --lang=fr;calc --force-dark-mode=1 --LANG=fr --disable-features=GlicX,IsolateOrigins https://example.com";

    [Fact]
    public void SafeOptInFlagsAreKeptAfterTheDefaultProfile() =>
        Assert.Equal(["--profile-directory=Default", .. Allowed.Split(' ')], ChromeLauncher.LaunchArguments(Allowed));

    [Fact]
    public void ProfileReplacementHeadlessCodeLoadingAndSecurityChangesAreDropped() =>
        Assert.Equal(["--profile-directory=Default"], ChromeLauncher.LaunchArguments(Forbidden));

    [Fact]
    public void NoExtraFlagsMeansTheDefaultProfileOnly() =>
        Assert.Equal(["--profile-directory=Default"], ChromeLauncher.LaunchArguments(null));

    [Fact]
    public void ClosedChromeIsStartedOnceDirectlyAndNeverByReadOnlyChecks()
    {
        var launches = new List<ProcessStartInfo>();
        var closed = new ChromeLauncher(() => false, () => @"C:\Chrome\chrome.exe", info => { launches.Add(info); return true; });
        Assert.False(closed.EnsureStarted(allowStart: false));
        Assert.Empty(launches);
        Assert.True(closed.EnsureStarted());
        var launch = Assert.Single(launches);
        Assert.Equal(@"C:\Chrome\chrome.exe", launch.FileName);
        Assert.False(launch.UseShellExecute);
        Assert.Equal("--profile-directory=Default", launch.ArgumentList[0]);
    }

    [Fact]
    public void RunningChromeIsPreserved()
    {
        var open = new ChromeLauncher(() => true, () => throw new InvalidOperationException("must not locate"), _ => throw new InvalidOperationException("must not launch"));
        Assert.True(open.EnsureStarted());
    }

    [Fact]
    public void MissingChromeIsReportedWithoutFabricatingSuccess()
    {
        var missing = new ChromeLauncher(() => false, () => null, _ => throw new InvalidOperationException("must not launch"));
        Assert.False(missing.EnsureStarted());
    }

    [Fact]
    public void FailedLaunchIsReported()
    {
        var failing = new ChromeLauncher(() => false, () => @"C:\Chrome\chrome.exe", _ => throw new System.ComponentModel.Win32Exception(2));
        Assert.False(failing.EnsureStarted());
    }
}
