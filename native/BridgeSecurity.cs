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
    public const string Version = "2.35.20";
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

        string full = Path.GetFullPath(CleanTrailingDotsAndSpaces(WithoutStreams(Path.GetFullPath(text))));
        string resolved = ResolveRealPath(full);
        string cleaned = CleanTrailingDotsAndSpaces(resolved);
        return cleaned.ToLowerInvariant().TrimEnd('\\', '/');
    }

    // Each name without its stream (name:stream:type): Windows opens "dir::$INDEX_ALLOCATION\file" as "dir\file" and
    // writes "out.exe::$DATA" as out.exe, so a secrets folder or a runnable file hid behind a stream (found by RobustnessTests).
    private static string WithoutStreams(string full)
    {
        var root = Path.GetPathRoot(full) ?? "";
        var parts = full[root.Length..].Split('\\').Select(p => p.IndexOf(':') is int at and >= 0 ? p[..at] : p);
        return root + string.Join(@"\", parts);
    }

    [LibraryImport("kernel32.dll", EntryPoint = "CreateFileW", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    private static partial Microsoft.Win32.SafeHandles.SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

    [LibraryImport("kernel32.dll", EntryPoint = "GetFinalPathNameByHandleW", SetLastError = true)]
    private static unsafe partial uint GetFinalPathNameByHandle(Microsoft.Win32.SafeHandles.SafeFileHandle handle, char* path, uint size, uint flags);

    // The path Windows really opens for an existing file or folder: every junction, symbolic link and 8.3 short name on
    // the way resolved. Only the last name's link was resolved before, so "C:\x\link\id_rsa" (link -> .ssh) and
    // "...\SSH~1\id_rsa" reached a secrets folder (found by RobustnessTests). Null when Windows cannot open it.
    private static string? FinalPath(string existing)
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            return null;
        const uint FILE_SHARE_ALL = 7, OPEN_EXISTING = 3, FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        using var handle = CreateFile(existing, 0, FILE_SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
        if (handle.IsInvalid)
            return null;
        var buffer = new char[32768];
        uint length;
        unsafe
        {
            fixed (char* text = buffer)
                length = GetFinalPathNameByHandle(handle, text, (uint)buffer.Length, 0);
        }
        if (length == 0 || length >= buffer.Length)
            return null;
        var path = new string(buffer, 0, (int)length);
        if (path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase))
            return @"\\" + path[8..];
        return path.StartsWith(@"\\?\", StringComparison.Ordinal) ? path[4..] : path;
    }

    private static string ResolveRealPath(string fullPath)
    {
        try
        {
            var current = fullPath;
            var suffixParts = new Stack<string>();
            while (!string.IsNullOrEmpty(current))
            {
                if (File.Exists(current) || Directory.Exists(current))
                {
                    if (FinalPath(current) is { } final)
                        current = final;
                    else if (new FileInfo(current) is { Exists: true } fi && fi.ResolveLinkTarget(returnFinalTarget: true) is { } fileTarget)
                        current = fileTarget.FullName;
                    else if (new DirectoryInfo(current).ResolveLinkTarget(returnFinalTarget: true) is { } dirTarget)
                        current = dirTarget.FullName;
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

    private static readonly HashSet<string> RunnableExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".exe", ".dll", ".com", ".scr", ".msi", ".msix", ".appx", ".bat", ".cmd", ".ps1", ".psm1", ".psd1", ".vbs",
        ".vbe", ".js", ".jse", ".wsf", ".wsh", ".hta", ".lnk", ".url", ".reg", ".cpl", ".sys", ".inf",
    };

    /// <summary>
    /// Refusal for a file the engine would write (output_path, output): never in a secrets or configuration folder of
    /// the agents (their settings run commands), a system folder or a startup folder, and never a runnable file, since
    /// what is written may come from a web page. NexusBrowser's own cache stays writable; anything else is free.
    /// </summary>
    public static string? OutputRefusal(string fullPath)
    {
        string key;
        try { key = CanonicalPath(fullPath); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return $"output_path refused: unreadable path '{fullPath}' ({ex.Message}).";
        }
        if (RunnableExtensions.Contains(Path.GetExtension(key)))
            return $"output_path refused: {fullPath} would be a runnable file ({Path.GetExtension(key)}). Use .md, .txt, .json, .csv, .html, .png, .pdf...";

        var home = HomeDir();
        var appDataEnv = Environment.GetEnvironmentVariable("APPDATA")?.Trim();
        var appData = !string.IsNullOrEmpty(appDataEnv) ? appDataEnv : Path.Join(home, "AppData", "Roaming");
        var roots = new List<string>(ProtectedUploadRoots())
        {
            Path.Join(appData, "Microsoft", "Windows", "Start Menu"),
            Environment.GetFolderPath(Environment.SpecialFolder.CommonStartMenu),
            Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
        };
        string own = CanonicalPath(Path.Join(home, ".nexus", "nexus-browser"));
        // A whole folder name, never a bare prefix: ~\.nexus\nexus-browser2 passed as the engine's own folder and ~\.awsome
        // was refused as ~\.aws (found by RobustnessTests).
        if (key == own || key.StartsWith(own + @"\", StringComparison.Ordinal)) return null;
        foreach (var root in roots)
        {
            if (string.IsNullOrEmpty(root)) continue;
            string rootKey;
            try { rootKey = CanonicalPath(root); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException) { continue; }
            if (key == rootKey || key.StartsWith(rootKey + @"\", StringComparison.Ordinal))
                return $"output_path refused: {fullPath} is in a protected folder ({root}). Write to a project, Documents, Downloads or temporary folder.";
        }
        return null;
    }

    /// <summary>
    /// The files Chrome will really read, with their size, for browser_upload. Each path is checked (secrets folders
    /// refused), must be an existing file (a folder or a missing path gave the page an empty File of 0 bytes, with no
    /// error), and is replaced by the path Windows really opens: an app packaged as MSIX (Claude) sees its writes to
    /// %LOCALAPPDATA% redirected to Packages\&lt;app&gt;\LocalCache, a folder Chrome never sees under the logical path
    /// (a 208 MB package reached Partner Center as 0 bytes on 05/11). The sizes let the extension check, once the files
    /// are in the input, that the page holds what is on the disk.
    /// </summary>
    public static (JsonArray Files, JsonArray Sizes) PrepareUploadFiles(JsonNode? filesNode)
    {
        CheckUploadFiles(filesNode);
        var files = new JsonArray();
        var sizes = new JsonArray();
        foreach (var item in (JsonArray)filesNode!)
        {
            string raw = item!.GetValue<string>();
            string full = Path.GetFullPath(ExpandUserPath(raw));
            if (Directory.Exists(full))
                throw new ArgumentException($"Upload not done: {raw} is a folder, not a file; nothing was sent to the page.");
            if (!File.Exists(full))
                throw new ArgumentException($"Upload not done: {raw} does not exist; nothing was sent to the page.");
            string real = FinalPath(full) ?? full;
            if (UploadRefusal([real]) is { } refusal)
                throw new UnauthorizedAccessException(refusal);
            files.Add(real);
            sizes.Add(new FileInfo(real).Length);
        }
        return (files, sizes);
    }

    private static string ExpandUserPath(string raw)
    {
        var text = Environment.ExpandEnvironmentVariables(raw.Trim().Trim('"'));
        if (text == "~" || text.StartsWith("~/", StringComparison.Ordinal) || text.StartsWith(@"~\", StringComparison.Ordinal))
            text = text.Length == 1 ? HomeDir() : Path.Join(HomeDir(), text[2..]);
        return text;
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
