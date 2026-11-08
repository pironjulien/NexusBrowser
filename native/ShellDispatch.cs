using System.Runtime.InteropServices;
using System.Runtime.InteropServices.Marshalling;

namespace NexusBrowser.Native;

// Shared with NexusWindows (commun/engine/ShellDispatch.cs), where it is tested against the real shell.
// Late binding to the Windows shell's automation objects (Shell.Application, ShellWindows, Explorer views, AppsFolder
// items) through IDispatch as a source-generated COM interface: the same by-name calls the C# `dynamic` binder made,
// without the runtime binder or runtime callable wrappers, so the engine stays trimmable and Native AOT compatible.
// A failed call raises a COMException carrying the HRESULT, as the runtime callable wrapper did.
[GeneratedComInterface, Guid("00020400-0000-0000-C000-000000000046")]
internal unsafe partial interface IDispatch
{
    [PreserveSig] int GetTypeInfoCount(out uint count);
    [PreserveSig] int GetTypeInfo(uint index, uint locale, out nint info);
    [PreserveSig] int GetIDsOfNames(Guid* iid, char** names, uint count, uint locale, int* ids);
    [PreserveSig] int Invoke(int member, Guid* iid, uint locale, ushort flags, ShellDispatch.Parameters* parameters, ShellDispatch.Variant* result, nint exception, uint* argumentError);
}

sealed unsafe partial class ShellDispatch : IDisposable
{
    // VARIANT: a 16-bit type tag, three reserved words, then a union as large as two pointers.
    [StructLayout(LayoutKind.Sequential)]
    internal struct Variant
    {
        public ushort Type;
        public ushort Reserved1, Reserved2, Reserved3;
        public nint Value;
        public nint Record;
    }
    // DISPPARAMS
    [StructLayout(LayoutKind.Sequential)]
    internal struct Parameters
    {
        public Variant* Arguments;
        public int* Named;
        public uint Count;
        public uint NamedCount;
    }

    const ushort VtEmpty = 0, VtNull = 1, VtI2 = 2, VtI4 = 3, VtBstr = 8, VtDispatch = 9, VtError = 10, VtBool = 11, VtUnknown = 13,
        VtI1 = 16, VtUi1 = 17, VtUi2 = 18, VtUi4 = 19, VtI8 = 20, VtUi8 = 21, VtInt = 22, VtUint = 23, VtByRef = 0x4000;
    const ushort DispatchMethod = 1, DispatchPropertyGet = 2;
    const int ParameterNotFound = unchecked((int)0x80020004); // DISP_E_PARAMNOTFOUND: an omitted optional argument
    static readonly StrategyBasedComWrappers Wrappers = new();
    static readonly Guid DispatchInterface = new("00020400-0000-0000-C000-000000000046");
    static readonly Guid ShellApplication = new("13709620-C279-11CE-A49E-444553540000");
    static readonly Guid ShellWindowsClass = new("9BA05972-F6A8-11CF-A442-00A0C90A8F39");

    [LibraryImport("ole32.dll")] private static partial int CoCreateInstance(in Guid clsid, nint outer, uint context, in Guid iid, out nint instance);
    [LibraryImport("oleaut32.dll")] private static partial int VariantClear(Variant* value);
    [LibraryImport("oleaut32.dll")] private static partial nint SysAllocString([MarshalAs(UnmanagedType.LPWStr)] string text);

    readonly nint pointer; // the IDispatch reference this object owns
    readonly IDispatch dispatch;
    bool disposed;

    // Takes ownership of an IDispatch reference.
    ShellDispatch(nint pointer)
    {
        this.pointer = pointer;
        dispatch = (IDispatch)Wrappers.GetOrCreateObjectForComInstance(pointer, CreateObjectFlags.UniqueInstance);
    }

    // The shell's automation root (Shell.Application) and the ShellWindows collection, created as Activator did
    // (CLSCTX_SERVER: in-process, local or remote server).
    internal static ShellDispatch CreateShellApplication() => Create(ShellApplication);
    internal static ShellDispatch CreateShellWindows() => Create(ShellWindowsClass);
    static ShellDispatch Create(Guid clsid)
    {
        Marshal.ThrowExceptionForHR(CoCreateInstance(in clsid, 0, 0x17, in DispatchInterface, out var instance));
        return new ShellDispatch(instance);
    }

    // An IDispatch, or any IUnknown that answers it, owned by the caller (not consumed).
    internal static ShellDispatch FromUnknown(nint unknown)
    {
        Marshal.ThrowExceptionForHR(Marshal.QueryInterface(unknown, in DispatchInterface, out var instance));
        return new ShellDispatch(instance);
    }

    // The IUnknown identity of the object: two references to the same COM object compare equal.
    internal bool SameObject(ShellDispatch other)
    {
        var mine = Marshal.QueryInterface(pointer, in IUnknownInterface, out var a) >= 0 ? a : 0;
        var theirs = Marshal.QueryInterface(other.pointer, in IUnknownInterface, out var b) >= 0 ? b : 0;
        try { return mine != 0 && mine == theirs; }
        finally { if (mine != 0) Marshal.Release(mine); if (theirs != 0) Marshal.Release(theirs); }
    }
    static readonly Guid IUnknownInterface = new("00000000-0000-0000-C000-000000000046");

    // A property read or a method call by name. Arguments: string, int, bool, null (an omitted optional argument) or
    // a reference (ref int / ref object) through Reference. The result: null, string, int, long, bool, a ShellDispatch
    // (owned by the caller) or another integer type, boxed.
    internal object? Get(string name) => Invoke(name, DispatchPropertyGet | DispatchMethod, []);
    internal object? Call(string name, params object?[] arguments) => Invoke(name, DispatchMethod | DispatchPropertyGet, arguments);
    internal ShellDispatch? GetObject(string name) => Get(name) switch
    {
        null => null,
        ShellDispatch value => value,
        var other => throw new InvalidCastException($"{name} is not an automation object ({other.GetType().Name})"),
    };
    internal ShellDispatch? CallObject(string name, params object?[] arguments) => Call(name, arguments) switch
    {
        null => null,
        ShellDispatch value => value,
        var other => throw new InvalidCastException($"{name} did not return an automation object ({other.GetType().Name})"),
    };

    // A by-reference argument: a VARIANT (VT_BYREF | VT_VARIANT), or a 32-bit integer (VT_BYREF | VT_I4) for an
    // [out] long parameter. Value is read back after the call.
    internal sealed class Reference(object? value, bool integer = false) { public object? Value = value; public readonly bool Integer = integer; }

    // Another interface of the same object, owned by the caller.
    internal nint Query(in Guid iid)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        Marshal.ThrowExceptionForHR(Marshal.QueryInterface(pointer, in iid, out var result));
        return result;
    }

    object? Invoke(string name, ushort flags, object?[] arguments)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        int member;
        fixed (char* text = name)
        {
            var names = stackalloc char*[1]; names[0] = text;
            var guid = Guid.Empty; // IID_NULL
            Marshal.ThrowExceptionForHR(dispatch.GetIDsOfNames(&guid, names, 1, 0x0400 /* LOCALE_USER_DEFAULT */, &member));
        }
        var count = arguments.Length;
        // Arguments in reverse order (DISPPARAMS); a reference argument points at its own variant in `cells`.
        var values = stackalloc Variant[Math.Max(count, 1)];
        var cells = stackalloc Variant[Math.Max(count, 1)];
        new Span<Variant>(values, Math.Max(count, 1)).Clear();
        new Span<Variant>(cells, Math.Max(count, 1)).Clear();
        Variant result = default;
        try
        {
            for (var i = 0; i < count; i++)
            {
                var slot = count - 1 - i;
                if (arguments[i] is Reference { Integer: true } integer)
                {
                    cells[slot] = new Variant { Type = VtI4, Value = integer.Value is int start ? start : 0 };
                    values[slot] = new Variant { Type = VtByRef | VtI4, Value = (nint)(&cells[slot].Value) };
                }
                else if (arguments[i] is Reference reference)
                {
                    cells[slot] = ToVariant(reference.Value);
                    values[slot] = new Variant { Type = VtByRef | 12 /* VT_VARIANT */, Value = (nint)(&cells[slot]) };
                }
                else values[slot] = ToVariant(arguments[i]);
            }
            var parameters = new Parameters { Arguments = values, Count = (uint)count };
            var guid = Guid.Empty; // IID_NULL
            uint argumentError = 0;
            Marshal.ThrowExceptionForHR(dispatch.Invoke(member, &guid, 0x0400, flags, &parameters, &result, 0, &argumentError));
            for (var i = 0; i < count; i++)
                if (arguments[i] is Reference reference)
                    reference.Value = reference.Integer ? (int)cells[count - 1 - i].Value : FromVariant(ref cells[count - 1 - i]);
            return FromVariant(ref result);
        }
        finally
        {
            // VariantClear leaves the target of a VT_BYREF variant alone: each cell is cleared on its own.
            for (var i = 0; i < count; i++) { _ = VariantClear(&values[i]); _ = VariantClear(&cells[i]); }
            _ = VariantClear(&result);
        }
    }

    static Variant ToVariant(object? value) => value switch
    {
        null => new Variant { Type = VtError, Value = ParameterNotFound },
        string text => new Variant { Type = VtBstr, Value = SysAllocString(text) },
        int number => new Variant { Type = VtI4, Value = number },
        bool flag => new Variant { Type = VtBool, Value = flag ? -1 : 0 },
        _ => throw new ArgumentException("Unsupported automation argument: " + value.GetType().Name),
    };

    // Converts a result and leaves the variant empty when its reference was taken over (an automation object).
    static object? FromVariant(ref Variant value)
    {
        switch (value.Type)
        {
            case VtEmpty or VtNull: return null;
            case VtBstr: return value.Value == 0 ? "" : Marshal.PtrToStringBSTR(value.Value);
            case VtI4 or VtInt: return (int)value.Value;
            case VtI2: return (short)value.Value;
            case VtI1: return (sbyte)value.Value;
            case VtUi1: return (byte)value.Value;
            case VtUi2: return (ushort)value.Value;
            case VtUi4 or VtUint: return (uint)value.Value;
            case VtI8: return (long)value.Value;
            case VtUi8: return (ulong)value.Value;
            case VtBool: return (short)value.Value != 0;
            case VtDispatch or VtUnknown:
                if (value.Value == 0) return null;
                if (value.Type == VtDispatch) { var owned = value.Value; value = default; return new ShellDispatch(owned); }
                return FromUnknown(value.Value);
            default: return null; // a type the shell's callers never read (dates, arrays): no value
        }
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        ((ComObject)(object)dispatch).FinalRelease();
        Marshal.Release(pointer);
    }
}
