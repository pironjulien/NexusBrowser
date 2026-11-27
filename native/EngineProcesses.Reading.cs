using System;
using System.Runtime.InteropServices;

namespace NexusBrowser.Native;

// Process reading of EngineProcesses, in its own file: ChromeLauncher reads Chrome's command lines with it, and the
// launcher's lifetime fixture (tests\native_lifetime) compiles it without the rest of the engine.
public static partial class EngineProcesses
{
    // ---------------------------------------------------------------------------------------------
    // Process reading
    // ---------------------------------------------------------------------------------------------

    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const int ErrorInvalidParameter = 87;
    private const uint StillActive = 259;
    private const int ProcessCommandLineInformation = 60;
    private const int StatusInfoLengthMismatch = unchecked((int)0xC0000004);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    private static partial nint OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, int pid);

    [LibraryImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CloseHandle(nint handle);

    [LibraryImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetExitCodeProcess(nint process, out uint code);

    [LibraryImport("kernel32.dll", EntryPoint = "QueryFullProcessImageNameW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static unsafe partial bool QueryFullProcessImageName(nint process, uint flags, char* name, ref uint size);

    [LibraryImport("ntdll.dll")]
    private static unsafe partial int NtQueryInformationProcess(nint process, int infoClass, void* info, int length, out int returned);

    [LibraryImport("shell32.dll", EntryPoint = "CommandLineToArgvW", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    private static partial nint CommandLineToArgv(string commandLine, out int count);

    [LibraryImport("kernel32.dll")]
    private static partial nint LocalFree(nint memory);

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeString
    {
        public ushort Length, MaximumLength;
        public nint Buffer;
    }

    /// <summary>Image and command line of a process (null: unreadable); Exited when it is gone.</summary>
    internal static (bool Exited, string? Image, string? CommandLine) Read(int pid)
    {
        nint handle = OpenProcess(ProcessQueryLimitedInformation, false, pid);
        if (handle == 0) return (Marshal.GetLastPInvokeError() == ErrorInvalidParameter, null, null);
        try
        {
            string? image = ImageOf(handle), commandLine = CommandLineOf(handle);
            bool exited = image is null && commandLine is null && GetExitCodeProcess(handle, out uint code) && code != StillActive;
            return (exited, image, commandLine);
        }
        finally { CloseHandle(handle); }
    }

    private static unsafe string? ImageOf(nint handle)
    {
        char* buffer = stackalloc char[32768];
        uint size = 32768;
        return QueryFullProcessImageName(handle, 0, buffer, ref size) ? new string(buffer, 0, (int)size) : null;
    }

    private static unsafe string? CommandLineOf(nint handle)
    {
        int length = 4096;
        for (int attempt = 0; attempt < 4; attempt++)
        {
            byte[] buffer = new byte[length];
            fixed (byte* data = buffer)
            {
                int status = NtQueryInformationProcess(handle, ProcessCommandLineInformation, data, buffer.Length, out int returned);
                if (status == StatusInfoLengthMismatch && returned > length) { length = returned; continue; }
                if (status < 0) return null;
                var text = *(UnicodeString*)data;
                return text.Buffer == 0 ? "" : new string((char*)text.Buffer, 0, text.Length / 2);
            }
        }
        return null;
    }

    /// <summary>argv as Windows splits it (CommandLineToArgvW), the executable first.</summary>
    internal static string[] SplitCommandLine(string commandLine)
    {
        if (string.IsNullOrWhiteSpace(commandLine)) return [];
        nint argv = CommandLineToArgv(commandLine, out int count);
        if (argv == 0) return [];
        try
        {
            var args = new string[count];
            for (int i = 0; i < count; i++) args[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i * IntPtr.Size)) ?? "";
            return args;
        }
        finally { LocalFree(argv); }
    }

}
