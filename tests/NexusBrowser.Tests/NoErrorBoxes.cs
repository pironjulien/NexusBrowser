using System.Diagnostics;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using Xunit;

namespace NexusBrowser.Tests;

/// <summary>
/// No test may ever show a Windows error box: a process started on a file that is not a valid image (the "16-bit
/// application not supported" box), a missing DLL or drive, a crash. Set once when the test assembly loads; every
/// process a test starts inherits the error mode (no CREATE_DEFAULT_ERROR_MODE), and so do theirs.
/// </summary>
internal static class NoErrorBoxes
{
    internal const uint Mode = 0x0001 /* SEM_FAILCRITICALERRORS */ | 0x0002 /* SEM_NOGPFAULTERRORBOX */ | 0x8000 /* SEM_NOOPENFILEERRORBOX */;

#pragma warning disable CA2255 // A module initializer is the only hook that runs before every test and every process a test starts.
    [ModuleInitializer]
#pragma warning restore CA2255
    internal static void Set() => _ = SetErrorMode(GetErrorMode() | Mode);

    [DllImport("kernel32.dll")]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    internal static extern uint SetErrorMode(uint mode);

    [DllImport("kernel32.dll")]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    internal static extern uint GetErrorMode();
}

public sealed class NoErrorBoxesTests
{
    [Fact]
    public async Task ProcessesStartedByTestsInheritTheNoErrorBoxMode()
    {
        Assert.Equal(NoErrorBoxes.Mode, NoErrorBoxes.GetErrorMode() & NoErrorBoxes.Mode);
        var start = new ProcessStartInfo("pwsh.exe")
        {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
        };
        foreach (string arg in new[] { "-NoProfile", "-NonInteractive", "-Command",
                     "Add-Type -Namespace NoErrorBoxesTest -Name ErrorMode -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint GetErrorMode();'; [NoErrorBoxesTest.ErrorMode]::GetErrorMode()" })
            start.ArgumentList.Add(arg);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(120));
        using var child = Process.Start(start)!;
        try
        {
            var error = child.StandardError.ReadToEndAsync(timeout.Token);
            string output = await child.StandardOutput.ReadToEndAsync(timeout.Token);
            await child.WaitForExitAsync(timeout.Token);
            Assert.True(child.ExitCode == 0, await error + output);
            Assert.Equal(NoErrorBoxes.Mode, uint.Parse(output.Trim(), CultureInfo.InvariantCulture) & NoErrorBoxes.Mode);
        }
        finally
        {
            if (!child.HasExited) child.Kill(entireProcessTree: true);
        }
    }
}
