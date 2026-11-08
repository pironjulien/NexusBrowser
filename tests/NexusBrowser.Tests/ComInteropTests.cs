using System.Runtime.InteropServices;
using NexusBrowser.Native;
using Xunit;

namespace NexusBrowser.Tests;

/// <summary>
/// The engine's COM calls without the `dynamic` binder (Native AOT): the Task Scheduler through its source-generated
/// interfaces and the Explorer launch broker through the generated IDispatch, against the real Windows services, read
/// only: nothing is registered, deleted, started or launched.
/// </summary>
public sealed partial class ComInteropTests
{
    [LibraryImport("user32.dll")] private static partial nint GetShellWindow();

    [Fact]
    public void ATaskThatDoesNotExistIsAbsentWithoutDefinition()
    {
        var tasks = new WindowsTaskStore();
        string name = "NexusBrowser test " + Guid.NewGuid().ToString("N");
        Assert.Equal("Absent", tasks.State(name));
        Assert.Null(tasks.Xml(name));
        tasks.Delete(name); // already gone: no error, as for a task removed meanwhile
    }

    [Fact]
    public void AnInstalledProductTaskIsReadWithItsDefinitionAndState()
    {
        var tasks = new WindowsTaskStore();
        string? found = new[] { TaskNames.Bridge, TaskNames.Daemon, TaskNames.Update }.FirstOrDefault(name => tasks.State(name) != "Absent");
        Assert.SkipWhen(found is null, "NexusBrowser is not installed for this account (no task to read).");
        // get_State and get_Xml sit at their taskschd.h vtable slots: a wrong slot returns garbage or crashes here.
        Assert.Contains(tasks.State(found!), new[] { "Disabled", "Queued", "Ready", "Running" });
        string xml = tasks.Xml(found!)!;
        Assert.Contains("<Task", xml, StringComparison.Ordinal);
        Assert.Contains("NexusBrowser", xml, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void TheDesktopBrokerFindsTheInteractiveShellDispatchByReferenceArguments()
    {
        Assert.SkipWhen(GetShellWindow() == 0, "No interactive Explorer shell in this session.");
        // FindWindowSW(ref CSIDL_DESKTOP, ref missing, SWC_DESKTOP, out hwnd, SWFO_NEEDDISPATCH), then the view's
        // Application: the IShellDispatch2 that launches user applications, here only read.
        using var application = UserApplication.DesktopApplication();
        using var windows = application.CallObject("Windows");
        Assert.NotNull(windows);
        Assert.IsType<int>(windows.Get("Count"));
    }
}
