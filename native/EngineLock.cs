using System;
using System.IO;

namespace NexusBrowser.Native;

/// <summary>
/// Marks this engine's build folder as in use for the whole life of the process. The installer writes an empty
/// engine.lock in each build folder (scripts\runtime.ps1, Install-EngineBuild); every engine opens the one beside it
/// without delete sharing and never closes it, so the cleanup of older builds (Remove-UnusedEngineBuilds) sees the
/// folder in use whatever spelling of the path started the process, and Windows refuses to rename it. A single-file
/// engine is otherwise only mapped: Windows renames the folder of such a running program.
/// A folder without the file (development build) or a lock tested by the cleanup at that instant: nothing held.
/// </summary>
internal static class EngineLock
{
    public const string FileName = "engine.lock";
    private static FileStream? _held;

    public static void Hold()
    {
        if (_held is not null) return;
        try { _held = new FileStream(Path.Join(AppContext.BaseDirectory, FileName), FileMode.Open, FileAccess.Read, FileShare.ReadWrite); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { /* no lock file, or the cleanup tests it */ }
    }
}
