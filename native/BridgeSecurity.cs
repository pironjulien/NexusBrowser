using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace NexusBrowser.Native;

public static partial class BridgeSecurity
{
    public const string Version = "2.33.15";
    public const string TokenFileName = "bridge-token";
    public const string TokenHeader = "X-Nexus-Browser-Token";
    public const string AgentHeader = "X-Nexus-Browser-Agent";
    public const string ClientHeader = "X-Nexus-Browser-Client";
    public const string PidHeader = "X-Nexus-Browser-Pid";
    public const string GoneHeader = "X-Nexus-Browser-Gone";

    private static readonly Regex AgentPattern = new(@"^[A-Za-z0-9][A-Za-z0-9 _.-]{0,31}$", RegexOptions.Compiled);
    private static readonly Regex ClientPattern = new(@"^[A-Za-z0-9][A-Za-z0-9_.:-]{3,63}$", RegexOptions.Compiled);
    private static readonly Regex PidPattern = new(@"^[0-9]{1,10}$", RegexOptions.Compiled);
    private static readonly Regex AdminSharePattern = new(@"^\\\\([^\\]+)\\([A-Za-z])\$(?:\\(.*))?$", RegexOptions.Singleline | RegexOptions.Compiled);

    private static readonly HashSet<string> LocalHosts = new(StringComparer.OrdinalIgnoreCase)
    {
        "localhost",
        "localhost.localdomain",
        "::1",
        "[::1]",
        "0:0:0:0:0:0:0:1",
        ".",
        "?",
    };

    public static readonly HashSet<string> ReadOnlyActions = new(StringComparer.Ordinal)
    {
        "ping",
        "list-tabs",
        "active-tab",
        "content",
        "axtree",
        "logs",
        "screenshot",
        "pdf",
        "check-handoff",
        "download-status",
        "wait-load",
        "wait-network-idle",
        "interactive-map",
        "vision-inspect",
        "find",
        "field-state",
        "network-requests",
        "network-response",
        "wait-download",
        "export-content",
        "export-gsuite",
        "release-tab",
        "network-stop",
        "heartbeat",
    };

    private static readonly string[] ProtectedHomeRelatives =
    [
        ".nexus",
        ".nexusagy",
        ".ssh",
        ".codex",
        ".claude",
        ".gemini",
        ".android",
        ".git-credentials",
        @".config\gcloud",
        ".aws",
        ".azure",
        ".kube",
        ".docker",
        ".gnupg",
        ".netrc",
        "_netrc",
        ".npmrc",
        ".pypirc",
    ];

    public static (string Agent, string Id)? CheckIdentity(string? agent, string? clientId)
    {
        if (agent is null || clientId is null)
            return null;
        var cleanAgent = agent.Trim();
        var cleanClient = clientId.Trim();
        if (!AgentPattern.IsMatch(cleanAgent) || !ClientPattern.IsMatch(cleanClient))
            return null;
        return (cleanAgent, cleanClient);
    }

    public static long? CheckPid(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return null;
        var clean = value.Trim();
        if (!PidPattern.IsMatch(clean))
            return null;
        if (!long.TryParse(clean, out var pid))
            return null;
        if (pid <= 0 || pid >= (1L << 32))
            return null;
        return pid;
    }

    [LibraryImport("kernel32.dll", SetLastError = true)]
    private static partial IntPtr OpenProcess(uint dwDesiredAccess, [MarshalAs(UnmanagedType.Bool)] bool bInheritHandle, uint dwProcessId);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CloseHandle(IntPtr hObject);

    public static bool ProcessRunning(long pid)
    {
        if (pid <= 0 || pid >= (1L << 32))
            return false;

        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            try
            {
                using var proc = Process.GetProcessById((int)pid);
                return !proc.HasExited;
            }
            catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException)
            {
                return false;
            }
        }

        const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        const int ERROR_INVALID_PARAMETER = 87;
        const uint STILL_ACTIVE = 259;

        IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)pid);
        if (handle == IntPtr.Zero)
        {
            int err = Marshal.GetLastWin32Error();
            return err != ERROR_INVALID_PARAMETER;
        }

        try
        {
            if (!GetExitCodeProcess(handle, out uint code))
                return true;
            return code == STILL_ACTIVE;
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    public static string HomeDir()
    {
        return Environment.GetEnvironmentVariable("USERPROFILE")
            ?? Environment.GetEnvironmentVariable("HOME")
            ?? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    }

    public static string DefaultDataDir()
    {
        return Path.Join(HomeDir(), ".nexus", "nexus-browser");
    }

    public static string TokenPath(string? explicitPath = null)
    {
        if (!string.IsNullOrWhiteSpace(explicitPath))
            return Path.GetFullPath(explicitPath);
        var envOverride = Environment.GetEnvironmentVariable("NEXUS_BROWSER_TOKEN_FILE");
        if (!string.IsNullOrWhiteSpace(envOverride))
            return Path.GetFullPath(envOverride);
        return Path.Join(DefaultDataDir(), TokenFileName);
    }

    private static string? CurrentUserSid()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            return null;
        try
        {
            var psi = new ProcessStartInfo("whoami", "/user /fo csv /nh")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using var proc = Process.Start(psi);
            if (proc == null) return null;
            string output = proc.StandardOutput.ReadToEnd().Trim();
            proc.WaitForExit(5000);
            if (proc.ExitCode != 0 || string.IsNullOrEmpty(output))
                return null;
            var parts = output.Split(',');
            var sid = parts[^1].Trim().Trim('"');
            return sid.StartsWith("S-1-", StringComparison.Ordinal) ? sid : null;
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException or IOException)
        {
            // whoami missing, blocked or too slow: no SID
            return null;
        }
    }

    public static void HardenTokenPermissions(string path)
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            return;
        var sid = CurrentUserSid();
        if (string.IsNullOrEmpty(sid))
            return;
        try
        {
            var psi = new ProcessStartInfo("icacls")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            psi.ArgumentList.Add(path);
            psi.ArgumentList.Add("/inheritance:r");
            psi.ArgumentList.Add("/grant:r");
            psi.ArgumentList.Add($"*{sid}:(F)");
            psi.ArgumentList.Add("*S-1-5-18:(F)");
            psi.ArgumentList.Add("*S-1-5-32-544:(F)");
            using var proc = Process.Start(psi);
            proc?.WaitForExit(5000);
        }
        catch (Exception caught) when (Boundary.Recoverable(caught))
        {
            // Deliberate best-effort boundary: ACL hardening must never block token creation
        }
    }

    public static string ReadToken(string? explicitPath = null)
    {
        var target = TokenPath(explicitPath);
        if (!File.Exists(target))
            throw new FileNotFoundException($"Bridge token not found at {target}");
        var token = File.ReadAllText(target, Encoding.ASCII).Trim();
        if (token.Length < 43)
            throw new InvalidOperationException($"Invalid NexusBrowser bridge token in {target}");
        return token;
    }

    public static string LoadOrCreateToken(string? explicitPath = null)
    {
        var target = TokenPath(explicitPath);
        var dir = Path.GetDirectoryName(target);
        if (!string.IsNullOrEmpty(dir))
            Directory.CreateDirectory(dir);

        try
        {
            using var fs = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            var token = BridgeAuth.ToBase64Url(RandomNumberGenerator.GetBytes(48));
            var bytes = Encoding.ASCII.GetBytes(token + "\n");
            fs.Write(bytes, 0, bytes.Length);
            fs.Flush();
        }
        catch (IOException) when (File.Exists(target))
        {
            return ReadToken(target);
        }

        HardenTokenPermissions(target);
        return ReadToken(target);
    }

    public static string RotateToken(string? explicitPath = null)
    {
        var target = TokenPath(explicitPath);
        var dir = Path.GetDirectoryName(target);
        if (!string.IsNullOrEmpty(dir))
            Directory.CreateDirectory(dir);

        var token = BridgeAuth.ToBase64Url(RandomNumberGenerator.GetBytes(48));
        var randHex = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8));
        var tmp = Path.Join(dir ?? ".", $".{Path.GetFileName(target)}-{randHex}.tmp");
        try
        {
            File.WriteAllText(tmp, token + "\n", Encoding.ASCII);
            HardenTokenPermissions(tmp);
            File.Move(tmp, target, overwrite: true);
            HardenTokenPermissions(target);
        }
        finally
        {
            try
            {
                if (File.Exists(tmp))
                    File.Delete(tmp);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // Ignore cleanup failure
            }
        }
        return token;
    }

    public static bool IsReadOnlyAction(string? action)
    {
        if (string.IsNullOrWhiteSpace(action))
            return false;
        return ReadOnlyActions.Contains(action.Trim().ToLowerInvariant().Replace('_', '-'));
    }

    public static bool IsUploadAction(string? action, JsonObject? @params = null)
    {
        if (@params != null && @params.ContainsKey("files"))
            return true;
        if (!string.IsNullOrWhiteSpace(action) &&
            action.Trim().ToLowerInvariant().Replace('_', '-') == "upload")
        {
            return true;
        }
        if (@params != null && @params["steps"] is JsonArray steps)
        {
            foreach (var step in steps.OfType<JsonObject>())
            {
                var stepAction = step["action"] is JsonValue av && av.TryGetValue<string>(out var s) ? s : null;
                var stepParams = step["params"] as JsonObject ?? step;
                if (IsUploadAction(stepAction, stepParams))
                    return true;
            }
        }
        return false;
    }

    private static bool IsLocalHost(string name)
    {
        var host = name.Trim().ToLowerInvariant().TrimEnd('.');
        if (LocalHosts.Contains(host) || host.StartsWith("127.", StringComparison.Ordinal))
            return true;
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try { names.Add(Dns.GetHostName()); } catch (System.Net.Sockets.SocketException) { /* no host name: the names below still apply */ }
        var comp = Environment.GetEnvironmentVariable("COMPUTERNAME")?.Trim();
        if (!string.IsNullOrEmpty(comp)) names.Add(comp);
        if (!string.IsNullOrEmpty(Environment.MachineName)) names.Add(Environment.MachineName);
        return names.Contains(host);
    }

    public static List<string> ProtectedUploadRoots()
    {
        var home = HomeDir();
        var appDataEnv = Environment.GetEnvironmentVariable("APPDATA")?.Trim();
        var appData = !string.IsNullOrEmpty(appDataEnv) ? appDataEnv : Path.Join(home, "AppData", "Roaming");
        var localEnv = Environment.GetEnvironmentVariable("LOCALAPPDATA")?.Trim();
        var local = !string.IsNullOrEmpty(localEnv) ? localEnv : Path.Join(home, "AppData", "Local");

        var roots = new List<string>();
        foreach (var name in ProtectedHomeRelatives)
            roots.Add(Path.Join(home, name));

        roots.Add(Path.Join(appData, "gcloud"));
        roots.Add(Path.Join(appData, "Microsoft", "Credentials"));
        roots.Add(Path.Join(appData, "Microsoft", "Protect"));
        roots.Add(Path.Join(local, "Microsoft", "Credentials"));
        roots.Add(Path.Join(local, "Google", "Chrome", "User Data"));
        roots.Add(Path.Join(home, "Documents", "NexusSecure"));
        roots.Add(Path.Join(home, "OneDrive", "Documents", "NexusSecure"));

        foreach (var variable in new[] { "OneDrive", "OneDriveConsumer", "OneDriveCommercial" })
        {
            var baseDir = Environment.GetEnvironmentVariable(variable)?.Trim();
            if (!string.IsNullOrEmpty(baseDir))
                roots.Add(Path.Join(baseDir, "Documents", "NexusSecure"));
        }

        return roots;
    }

    public static string CanonicalPath(string raw)
    {
        if (raw is null)
            throw new ArgumentException("invalid file path (null)");
        var text = raw.Trim().Trim('"');
        if (text.Contains('\0'))
            throw new ArgumentException("invalid file path (null character)");

        text = Environment.ExpandEnvironmentVariables(text);
        if (text == "~" || text.StartsWith("~/", StringComparison.Ordinal) || text.StartsWith(@"~\", StringComparison.Ordinal))
        {
            var home = HomeDir();
            text = text.Length == 1 ? home : Path.Join(home, text[2..]);
        }

        text = text.Replace('/', '\\');
        var lowered = text.ToLowerInvariant();
        if (lowered.StartsWith(@"\\?\unc\", StringComparison.Ordinal))
            text = @"\\" + text[8..];
        else if (lowered.StartsWith(@"\??\unc\", StringComparison.Ordinal))
            text = @"\\" + text[8..];
        else if (lowered.StartsWith(@"\\?\", StringComparison.Ordinal) ||
                 lowered.StartsWith(@"\\.\", StringComparison.Ordinal) ||
                 lowered.StartsWith(@"\??\", StringComparison.Ordinal))
        {
            text = text[4..];
        }

        var share = AdminSharePattern.Match(text);
        if (share.Success && IsLocalHost(share.Groups[1].Value))
        {
            var drive = share.Groups[2].Value;
            var rest = share.Groups[3].Success ? share.Groups[3].Value : "";
            text = $"{drive}:\\{rest}";
        }

        string full = Path.GetFullPath(text);
        string resolved = ResolveRealPath(full);
        string cleaned = CleanTrailingDotsAndSpaces(resolved);
        return cleaned.ToLowerInvariant().TrimEnd('\\', '/');
    }

    private static string ResolveRealPath(string fullPath)
    {
        try
        {
            var current = fullPath;
            var suffixParts = new Stack<string>();
            while (!string.IsNullOrEmpty(current))
            {
                if (File.Exists(current))
                {
                    var fi = new FileInfo(current);
                    var target = fi.ResolveLinkTarget(returnFinalTarget: true);
                    if (target != null)
                        current = target.FullName;
                    break;
                }
                if (Directory.Exists(current))
                {
                    var di = new DirectoryInfo(current);
                    var target = di.ResolveLinkTarget(returnFinalTarget: true);
                    if (target != null)
                        current = target.FullName;
                    break;
                }
                var parent = Path.GetDirectoryName(current);
                var name = Path.GetFileName(current);
                if (string.IsNullOrEmpty(parent) || parent == current)
                    break;
                if (!string.IsNullOrEmpty(name))
                    suffixParts.Push(name);
                current = parent;
            }
            while (suffixParts.Count > 0)
                current = Path.Join(current, suffixParts.Pop());
            return Path.GetFullPath(current);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return fullPath;
        }
    }

    private static string CleanTrailingDotsAndSpaces(string resolved)
    {
        var root = Path.GetPathRoot(resolved) ?? "";
        var drive = root.TrimEnd('\\', '/');
        var rest = resolved[root.Length..];
        var parts = rest.Split('\\').Select(p =>
        {
            var s = p.TrimEnd(' ', '.');
            return string.IsNullOrEmpty(s) ? p : s;
        });
        return drive + @"\" + string.Join(@"\", parts);
    }

    public static string? UploadRefusal(JsonNode? filesNode)
    {
        if (filesNode is not JsonArray arr || arr.Count == 0)
            return "files must be a non-empty list of file paths";
        var list = new List<string>(arr.Count);
        foreach (var item in arr)
        {
            if (item is not JsonValue val || val.GetValueKind() != JsonValueKind.String || !val.TryGetValue<string>(out var s) || string.IsNullOrWhiteSpace(s))
                return "files must be a non-empty list of file paths";
            list.Add(s);
        }
        return UploadRefusal(list);
    }

    public static string? UploadRefusal(IEnumerable<string>? files)
    {
        if (files is null)
            return "files must be a non-empty list of file paths";
        var list = files.ToList();
        if (list.Count == 0 || list.Any(string.IsNullOrWhiteSpace))
            return "files must be a non-empty list of file paths";

        var roots = new List<(string RawRoot, string Key)>();
        foreach (var root in ProtectedUploadRoots())
        {
            try
            {
                roots.Add((root, CanonicalPath(root)));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
            {
                // Ignore unreadable root
            }
        }

        foreach (var item in list)
        {
            string key;
            try
            {
                key = CanonicalPath(item);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
            {
                return $"Upload refused: unreadable path '{item}' ({ex.Message}).";
            }

            foreach (var (rawRoot, rootKey) in roots)
            {
                if (key == rootKey || key.StartsWith(rootKey + @"\", StringComparison.Ordinal))
                {
                    return $"Upload refused: {item} is in a secrets folder ({rawRoot}). " +
                           "No token, key, Chrome profile or agent configuration is ever sent to a web page.";
                }
            }
        }
        return null;
    }

    public static void CheckUploadFiles(JsonNode? filesNode)
    {
        var refusal = UploadRefusal(filesNode);
        if (refusal is null)
            return;
        if (refusal.StartsWith("files must", StringComparison.Ordinal))
            throw new ArgumentException(refusal);
        throw new UnauthorizedAccessException(refusal);
    }
}
