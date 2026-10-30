using System.Diagnostics;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace NexusBrowser.Native;

/// <summary>Normal Chrome startup on the installed Default profile, matching the Python bridge client.</summary>
internal sealed class ChromeLauncher
{
    private readonly Func<bool> _running;
    private readonly Func<string?> _locate;
    private readonly Func<ProcessStartInfo, bool> _start;

    internal ChromeLauncher(Func<bool>? running = null, Func<string?>? locate = null, Func<ProcessStartInfo, bool>? start = null)
    {
        _running = running ?? IsRunning;
        _locate = locate ?? LocateExecutable;
        _start = start ?? StartProcess;
    }

    internal bool EnsureStarted(bool allowStart = true)
    {
        if (_running()) return true;
        if (!allowStart) return false;
        string? executable = _locate();
        if (string.IsNullOrEmpty(executable)) return false;
        var info = new ProcessStartInfo(executable) { UseShellExecute = false };
        foreach (string arg in LaunchArguments(Environment.GetEnvironmentVariable("NEXUS_CHROME_EXTRA_ARGS")))
            info.ArgumentList.Add(arg);
        try { return _start(info); }
        catch (Exception error) when (error is IOException or System.ComponentModel.Win32Exception or InvalidOperationException) { return false; }
    }

    private static bool StartProcess(ProcessStartInfo info)
    {
        // The MCP daemon belongs to a KILL_ON_JOB_CLOSE supervisor job. A direct Process.Start,
        // including UseShellExecute=true, would attach the user's Chrome to that lifetime.
        // Ask the interactive Explorer desktop to launch it instead. No inherited-child fallback.
        var launch = new ProcessStartInfo(info.FileName)
        {
            // Every argument came from LaunchArguments' strict, whitespace-free allowlist.
            Arguments = string.Join(" ", info.ArgumentList),
            WorkingDirectory = Path.GetDirectoryName(info.FileName) ?? "",
        };
        bool entered = false;
        try
        {
            UserApplication.Start(launch, () => entered = true);
            return true;
        }
        catch (UserApplicationUnavailableException error) { Console.Error.WriteLine($"Chrome startup unavailable: {error.Message}"); return false; }
        catch (Exception error) when (error is System.Runtime.InteropServices.COMException or InvalidOperationException)
        {
            // Once ShellExecute was entered, wait for the extension; do not submit a second launch.
            Console.Error.WriteLine($"Chrome launch outcome uncertain: {error}");
            return entered;
        }
    }

    internal static bool IsRunning()
    {
        var processes = Process.GetProcessesByName("chrome");
        try
        {
            using var current = Process.GetCurrentProcess();
            int session = current.SessionId;
            foreach (var process in processes)
                try { if (!process.HasExited && process.SessionId == session) return true; }
                catch (Exception error) when (error is System.ComponentModel.Win32Exception or InvalidOperationException) { }
            return false;
        }
        finally { foreach (var process in processes) process.Dispose(); }
    }

    internal static string? LocateExecutable()
    {
        const string keyPath = @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe";
        var candidates = new List<string>();
        foreach (var hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
            foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
                try
                {
                    using var root = RegistryKey.OpenBaseKey(hive, view);
                    using var key = root.OpenSubKey(keyPath);
                    if (key?.GetValue(null) is string path && !string.IsNullOrWhiteSpace(path))
                        candidates.Add(Environment.ExpandEnvironmentVariables(path.Trim().Trim('"')));
                }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.Security.SecurityException) { }
        foreach (string variable in new[] { "ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA" })
            if (Environment.GetEnvironmentVariable(variable) is { Length: > 0 } root)
                candidates.Add(Path.Combine(root, "Google", "Chrome", "Application", "chrome.exe"));
        return candidates.FirstOrDefault(File.Exists);
    }

    internal static IReadOnlyList<string> LaunchArguments(string? extra)
    {
        var arguments = new List<string> { "--profile-directory=Default" };
        foreach (string item in Regex.Split(extra ?? "", @"\s+"))
        {
            int equals = item.IndexOf('=');
            string name = equals < 0 ? item : item[..equals];
            string value = equals < 0 ? "" : item[(equals + 1)..];
            string? pattern = name switch
            {
                "--lang" => @"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$",
                "--accept-lang" => @"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*(,[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*)*$",
                "--variations-override-country" => @"^[A-Za-z]{2}$",
                "--disable-features" => @"^Glic\w*(,Glic\w*)*$",
                _ => null,
            };
            if ((name == "--force-dark-mode" && equals < 0) ||
                (pattern is not null && equals > 0 && Regex.IsMatch(value, pattern, RegexOptions.CultureInvariant)))
                arguments.Add(item);
        }
        return arguments;
    }
}
