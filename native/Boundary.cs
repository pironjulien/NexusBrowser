namespace NexusBrowser.Native;

/// <summary>Exception filter of the boundaries (host, connection, request, step, best-effort shutdown): every failure is
/// reported or contained there, except the fatal ones the process cannot recover from, which must still end it.</summary>
public static class Boundary
{
    public static bool Recoverable(Exception error) => error is not (OutOfMemoryException or InsufficientExecutionStackException);
}
