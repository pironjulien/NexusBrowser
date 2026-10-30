using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace NexusBrowser.Native;

/// <summary>
/// Restart request of the shared HTTP daemon (the spec's restart_request, same contract as NexusRelay): the installer
/// writes "code sha256:&lt;fingerprint&gt;" (or "force") into the file once a new immutable build is installed; the
/// running daemon takes it, and when it targets another build, stops as soon as no tool call is running, so that its
/// supervisor starts the new build. "pid:&lt;n&gt;" addresses one process only.
/// </summary>
public static partial class RestartRequest
{
    [GeneratedRegex(@"(?:^|\s)pid:(\d+)(?:\s|$)")]
    private static partial Regex PidTarget();

    public static string DefaultPath() =>
        Environment.GetEnvironmentVariable("NEXUS_BROWSER_RESTART_REQUEST") is { Length: > 0 } configured
            ? configured
            : Path.Combine(BridgeSecurity.DefaultDataDir(), "daemon-restart.request");

    /// <summary>SHA-256 of the code this process runs: the main assembly (framework-dependent build) or the single-file
    /// executable (release build). The installer computes the same value to name the immutable version folder.</summary>
    public static string CodeFingerprint()
    {
        try
        {
            string location = Assembly.GetEntryAssembly()?.Location ?? "";
            string path = location.Length > 0 && File.Exists(location) ? location : Environment.ProcessPath ?? "";
            if (path.Length > 0 && File.Exists(path))
            {
                using var stream = File.OpenRead(path);
                return Convert.ToHexStringLower(SHA256.HashData(stream));
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        return BridgeSecurity.Version;
    }

    private static bool TargetedElsewhere(string text)
    {
        var target = PidTarget().Match(text);
        return target.Success && target.Groups[1].Value != Environment.ProcessId.ToString(CultureInfo.InvariantCulture);
    }

    /// <summary>Takes the request (never left half-read) and says whether this process must restart.</summary>
    public static bool Wanted(string requestPath, string loadedFingerprint)
    {
        try { if (TargetedElsewhere(File.ReadAllText(requestPath, Encoding.UTF8))) return false; }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException) { return false; }
        string taken = requestPath + ".lue";
        try { File.Move(requestPath, taken, overwrite: true); }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException) { return false; }
        string content;
        try { content = File.ReadAllText(taken, Encoding.UTF8).Trim(); }
        catch (IOException) { GiveBack(taken, requestPath); throw; }
        if (TargetedElsewhere(content)) { GiveBack(taken, requestPath); return false; }
        string? target = content.Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .FirstOrDefault(s => s.StartsWith("sha256:", StringComparison.Ordinal))?[7..];
        bool wanted = content.StartsWith("force", StringComparison.Ordinal) ||
            (target is not null && !target.Equals(loadedFingerprint, StringComparison.OrdinalIgnoreCase));
        try { File.Delete(taken); } catch (IOException) { }
        return wanted;
    }

    private static void GiveBack(string taken, string requestPath)
    {
        try
        {
            if (!File.Exists(requestPath)) File.Move(taken, requestPath);
            else File.Delete(taken);
        }
        catch (IOException) { }
    }
}
