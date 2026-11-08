using System.Runtime.InteropServices;
using System.Runtime.InteropServices.Marshalling;

namespace NexusBrowser.Native;

/// <summary>
/// The Task Scheduler 2.0 API (taskschd.dll), root folder, through source-generated COM interop: no schtasks.exe, no
/// PowerShell, no `dynamic` binder, so the engine stays trimmable and Native AOT compatible. Same interfaces as the
/// NexusApps maintenance engine (Nexus.Core/ScheduledTasks.cs).
/// </summary>
internal sealed partial class WindowsTaskStore : ITaskStore
{
    private const int TaskCreateOrUpdate = 6, LogonInteractiveToken = 3;
    private static readonly Guid TaskSchedulerClass = new("0F87369F-A4E5-4CFC-BD3E-73E6154572DD");
    private static readonly Guid TaskServiceInterface = new("2FABA4C7-4DA9-4013-9697-20CC3FD40F85");
    private static readonly StrategyBasedComWrappers Wrappers = new();

    [LibraryImport("ole32.dll")]
    private static partial int CoInitializeEx(nint reserved, uint model);

    [LibraryImport("ole32.dll")]
    private static partial int CoCreateInstance(in Guid classId, nint outer, uint context, in Guid interfaceId, out nint instance);

    private static ITaskFolder Folder()
    {
        // The calling thread joins the multithreaded apartment (a thread already initialized keeps its own).
        _ = CoInitializeEx(0, 0 /* COINIT_MULTITHREADED */);
        Marshal.ThrowExceptionForHR(CoCreateInstance(TaskSchedulerClass, 0, 0x17 /* CLSCTX_SERVER */, TaskServiceInterface, out var pointer));
        try
        {
            var service = (ITaskService)Wrappers.GetOrCreateObjectForComInstance(pointer, CreateObjectFlags.UniqueInstance);
            service.Connect(default, default, default, default);
            return service.GetFolder("\\");
        }
        finally { Marshal.Release(pointer); }
    }

    /// <summary>No such task (or folder): ERROR_FILE_NOT_FOUND or ERROR_PATH_NOT_FOUND as an HRESULT.</summary>
    internal static bool Missing(int hresult) => hresult is unchecked((int)0x80070002) or unchecked((int)0x80070003);

    private static IRegisteredTask? Find(string name)
    {
        int hr = Folder().GetTask(name, out var task);
        if (Missing(hr)) return null;
        Marshal.ThrowExceptionForHR(hr);
        return task;
    }

    public string? Xml(string name) => Find(name)?.GetXml();

    public string State(string name)
    {
        if (Find(name) is not { } task) return "Absent";
        return task.GetState() switch { 1 => "Disabled", 2 => "Queued", 3 => "Ready", 4 => "Running", _ => "Unknown" };
    }

    public void Register(string name, string xml) =>
        Folder().RegisterTask(name, xml, TaskCreateOrUpdate, default, default, LogonInteractiveToken, default);

    public void Delete(string name)
    {
        int hr = Folder().DeleteTask(name, 0);
        if (!Missing(hr)) Marshal.ThrowExceptionForHR(hr); // missing: already gone
    }

    public void Run(string name)
    {
        if (Find(name) is not { } task) return;
        nint running = task.Run(default);
        if (running != 0) Marshal.Release(running);
    }
}

/// <summary>
/// A VARIANT passed by value, always VT_EMPTY here (the defaults of Connect, RegisterTask and Run): 24 bytes on 64-bit
/// Windows. Its marshaller passes it as is, so the source generator handles it without disabling runtime marshalling.
/// </summary>
[NativeMarshalling(typeof(EmptyVariantMarshaller))]
[StructLayout(LayoutKind.Sequential)]
internal readonly struct EmptyVariant
{
    private readonly ushort type;
    private readonly ushort reserved1, reserved2, reserved3;
    private readonly nint value1, value2;
}

[CustomMarshaller(typeof(EmptyVariant), MarshalMode.Default, typeof(EmptyVariantMarshaller))]
internal static class EmptyVariantMarshaller
{
    public static EmptyVariant ConvertToUnmanaged(EmptyVariant managed) => managed;

    public static EmptyVariant ConvertToManaged(EmptyVariant unmanaged) => unmanaged;
}

// The three interfaces of taskschd.h used here, in their vtable order (checked against the Windows SDK header). They
// derive from IDispatch, whose four methods are declared as placeholders (never called) so the later slots line up.

[GeneratedComInterface]
[Guid("2FABA4C7-4DA9-4013-9697-20CC3FD40F85")]
internal partial interface ITaskService
{
    void DispatchGetTypeInfoCount();
    void DispatchGetTypeInfo();
    void DispatchGetIDsOfNames();
    void DispatchInvoke();
    ITaskFolder GetFolder([MarshalAs(UnmanagedType.BStr)] string path);
    void GetRunningTasks();
    void NewTask();
    void Connect(EmptyVariant serverName, EmptyVariant user, EmptyVariant domain, EmptyVariant password);
}

[GeneratedComInterface]
[Guid("8CFAC062-A080-4C15-9A88-AA7C2AF80DFC")]
internal partial interface ITaskFolder
{
    void DispatchGetTypeInfoCount();
    void DispatchGetTypeInfo();
    void DispatchGetIDsOfNames();
    void DispatchInvoke();
    void GetName();
    void GetPath();
    void GetFolder();
    void GetFolders();
    void CreateFolder();
    void DeleteFolder();
    [PreserveSig]
    int GetTask([MarshalAs(UnmanagedType.BStr)] string path, out IRegisteredTask? task);
    void GetTasks();
    [PreserveSig]
    int DeleteTask([MarshalAs(UnmanagedType.BStr)] string name, int flags);
    IRegisteredTask RegisterTask([MarshalAs(UnmanagedType.BStr)] string path, [MarshalAs(UnmanagedType.BStr)] string xml, int flags,
        EmptyVariant userId, EmptyVariant password, int logonType, EmptyVariant sddl);
}

[GeneratedComInterface]
[Guid("9C86F320-DEE3-4DD1-B972-A303F26B061E")]
internal partial interface IRegisteredTask
{
    void DispatchGetTypeInfoCount();
    void DispatchGetTypeInfo();
    void DispatchGetIDsOfNames();
    void DispatchInvoke();
    void GetName();
    void GetPath();
    int GetState();
    short GetEnabled();
    void SetEnabled(short enabled);
    nint Run(EmptyVariant parameters);
    void RunEx();
    void GetInstances();
    void GetLastRunTime();
    void GetLastTaskResult();
    void GetNumberOfMissedRuns();
    void GetNextRunTime();
    void GetDefinition();
    [return: MarshalAs(UnmanagedType.BStr)]
    string GetXml();
}
