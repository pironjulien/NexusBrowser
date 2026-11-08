using System.Diagnostics;
using System.Runtime.InteropServices;

namespace NexusBrowser.Native;

sealed class UserApplicationUnavailableException(string message, Exception? inner = null) : InvalidOperationException(message, inner);

// User applications belong to the interactive Windows shell, not to the MCP worker's process tree/job.
// This is the documented Explorer desktop-view -> IShellDispatch2 broker. A local Shell.Application object or
// Process.Start(UseShellExecute=true) still creates an inherited child: neither is a lifetime boundary.
// https://devblogs.microsoft.com/oldnewthing/20131118-00/?p=2643
// No fallback to an inherited process after an unavailable broker, and no retry after ShellExecute was entered.
static unsafe partial class UserApplication
{
    [LibraryImport("user32.dll")] private static partial nint GetShellWindow();
    [LibraryImport("user32.dll")] private static partial uint GetWindowThreadProcessId(nint hwnd, out uint pid);
    [LibraryImport("user32.dll", EntryPoint = "OpenDesktopW", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    private static partial nint OpenDesktop(string lpszDesktop, uint dwFlags, [MarshalAs(UnmanagedType.Bool)] bool fInherit, uint dwDesiredAccess);
    [LibraryImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static partial bool SetThreadDesktop(nint hDesktop);
    [LibraryImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static partial bool CloseDesktop(nint hDesktop);
    [LibraryImport("user32.dll")] private static partial nint GetThreadDesktop(int dwThreadId);
    [LibraryImport("kernel32.dll")] private static partial int GetCurrentThreadId();
    static nint* Table(nint value) => *(nint**)value;
    static void Check(int result) { if (result < 0) Marshal.ThrowExceptionForHR(result); }
    static void Release(nint value) { if (value != 0) Marshal.Release(value); }

    // Startup preparation performs no launch. Callers set their unknown-outcome marker only at `started`.
    public static void Start(ProcessStartInfo info, Action started, int show = 1 /* SW_SHOWNORMAL */)
    {
        if (string.IsNullOrWhiteSpace(info.FileName)) throw new UserApplicationUnavailableException("An application target is required; nothing was launched");
        if (info.ArgumentList.Count != 0 || info.RedirectStandardInput || info.RedirectStandardOutput || info.RedirectStandardError)
            throw new UserApplicationUnavailableException("The user-application broker takes an argument string and no redirected protocol handles; nothing was launched");
        ShellDispatch application;
        try { application = DesktopApplication(); }
        catch (Exception error) when (Boundary.Recoverable(error)) { throw new UserApplicationUnavailableException("The interactive Explorer launch broker is unavailable; nothing was launched", error); } // deliberate: any COM failure means no broker
        using (application)
        {
            started();
            // IShellDispatch2::ShellExecute(File, vArgs, vDir, vOperation, vShow), by name as the dynamic binder did.
            application.Call("ShellExecute", info.FileName, info.Arguments, info.WorkingDirectory, "open", show);
        }
    }

    internal static ShellDispatch DesktopApplication()
    {
        ShellDispatch? windows = null, desktop = null, folder = null;
        nint provider = 0, browser = 0, view = 0, dispatch = 0;
        nint originalDesktop = 0, defaultDesktop = 0;
        try
        {
            var shell = GetShellWindow();
            if (shell == 0)
            {
                defaultDesktop = OpenDesktop("Default", 0, false, 0x01FF);
                if (defaultDesktop != 0)
                {
                    originalDesktop = GetThreadDesktop(GetCurrentThreadId());
                    SetThreadDesktop(defaultDesktop);
                    shell = GetShellWindow();
                }
            }
            if (shell == 0 || GetWindowThreadProcessId(shell, out var shellPid) == 0 || shellPid == 0)
                throw new InvalidOperationException("There is no interactive desktop shell");
            windows = ShellDispatch.CreateShellWindows();
            // FindWindowSW(ref CSIDL_DESKTOP, ref missing, SWC_DESKTOP, out hwnd, SWFO_NEEDDISPATCH).
            var desktopHwnd = new ShellDispatch.Reference(0, integer: true);
            desktop = windows.CallObject("FindWindowSW", new ShellDispatch.Reference(0 /* CSIDL_DESKTOP */), new ShellDispatch.Reference(null), 8 /* SWC_DESKTOP */, desktopHwnd, 1 /* SWFO_NEEDDISPATCH */);
            if (desktop == null || GetWindowThreadProcessId((nint)(uint)(int)desktopHwnd.Value!, out var desktopPid) == 0 || desktopPid != shellPid)
                throw new InvalidOperationException("The desktop automation object is not owned by the interactive shell");
            provider = desktop.Query(new Guid("6D5140C1-7436-11CE-8034-00AA006009FA")); // IServiceProvider
            var topBrowser = new Guid("4C96BE40-915C-11CF-99D3-00AA004AE837");
            var browserInterface = new Guid("000214E2-0000-0000-C000-000000000046");
            // IServiceProvider::QueryService, then IShellBrowser::QueryActiveShellView.
            Check(((delegate* unmanaged[Stdcall]<nint, Guid*, Guid*, nint*, int>)Table(provider)[3])(provider, &topBrowser, &browserInterface, &browser));
            Check(((delegate* unmanaged[Stdcall]<nint, nint*, int>)Table(browser)[15])(browser, &view));
            var dispatchInterface = new Guid("00020400-0000-0000-C000-000000000046");
            // IShellView::GetItemObject(SVGIO_BACKGROUND, IID_IDispatch).
            Check(((delegate* unmanaged[Stdcall]<nint, uint, Guid*, nint*, int>)Table(view)[15])(view, 0, &dispatchInterface, &dispatch));
            folder = ShellDispatch.FromUnknown(dispatch);
            return folder.GetObject("Application") ?? throw new InvalidOperationException("The desktop has no Shell dispatch");
        }
        finally
        {
            folder?.Dispose(); Release(dispatch); Release(view); Release(browser); Release(provider);
            desktop?.Dispose(); windows?.Dispose();
            if (defaultDesktop != 0)
            {
                if (originalDesktop != 0) SetThreadDesktop(originalDesktop);
                CloseDesktop(defaultDesktop);
            }
        }
    }
}
