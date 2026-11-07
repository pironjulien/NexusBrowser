using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using NexusBrowser.Native;
using Xunit;

namespace NexusBrowser.Tests;

internal static class Shells
{
    public const string WindowsPowerShell = "powershell.exe"; // 5.1: the only shell of a fresh Windows (get.ps1)
    public const string Pwsh = "pwsh.exe";

    public static IEnumerable<string> Both => [WindowsPowerShell, Pwsh];

    /// <summary>Runs a script file (-File) in a fresh shell without profile.</summary>
    public static Task<(int Code, string Stdout, string Stderr)> FileAsync(string shell, string script, IEnumerable<string>? args = null,
        IDictionary<string, string?>? env = null, int timeoutSeconds = 60)
    {
        // A PSModulePath inherited from a pwsh 7 session makes Windows PowerShell 5.1 load pwsh's modules (Get-FileHash
        // then missing): each shell starts from the machine's Windows module folders and adds its own. Without any
        // PSModulePath, pwsh leaves out those folders (ScheduledTasks...) when the user has a PSModulePath variable.
        var environment = new Dictionary<string, string?>(env ?? new Dictionary<string, string?>())
        {
            ["PSModulePath"] = Environment.GetEnvironmentVariable("PSModulePath", EnvironmentVariableTarget.Machine),
        };
        return ChildProcess.RunAsync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, .. args ?? []], environment, timeoutSeconds: timeoutSeconds);
    }

    public static string[] Lines(string text) => text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    public static string Quote(string path) => "'" + path.Replace("'", "''") + "'";
}

/// <summary>PowerShell scripts of the public install and their behaviour on disposable files (ports of
/// test_scripts.py and test_store_package.py). No real configuration, profile or release is read or written.</summary>
public sealed class ScriptTests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    // ---------------------------------------------------------------------------------------------
    // Windows PowerShell 5.1 and pwsh read every install script
    // ---------------------------------------------------------------------------------------------

    private static List<string> ScriptList() =>
        ["install.ps1", "get.ps1", .. Directory.EnumerateFiles(Repo.File("scripts"), "*.ps1").Select(s => "scripts/" + Path.GetFileName(s)).Order(StringComparer.Ordinal)];

    public static TheoryData<string> InstallScripts() => new(ScriptList());

    /// <summary>Windows PowerShell 5.1 reads a .ps1 without BOM in the ANSI code page, where a UTF-8 character can turn
    /// into a quote: the repository has no BOM, so ASCII only.</summary>
    [Theory]
    [MemberData(nameof(InstallScripts))]
    public void InstallScriptIsPureAscii(string script)
    {
        byte[] bytes = File.ReadAllBytes(Repo.File(script.Split('/')));
        var lines = Encoding.UTF8.GetString(bytes).Split('\n');
        var offending = lines.Select((line, i) => (line, i)).Where(x => x.line.Any(c => c > 127)).Select(x => $"line {x.i + 1}: {x.line.Trim()}").Take(5).ToList();
        Assert.True(offending.Count == 0, $"{script} is not ASCII:\n{string.Join('\n', offending)}");
    }

    [Theory]
    [InlineData(Shells.WindowsPowerShell)]
    [InlineData(Shells.Pwsh)]
    public async Task InstallScriptsParseWithoutError(string shell)
    {
        var scripts = ScriptList();
        string probe = _dir["parse.ps1"];
        var text = new StringBuilder("$ErrorActionPreference = 'Stop'\n");
        foreach (string script in scripts)
            text.Append(System.Globalization.CultureInfo.InvariantCulture, $"$t = $null; $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile({Shells.Quote(Repo.File(script.Split('/')))}, [ref]$t, [ref]$e)\n")
                .Append(System.Globalization.CultureInfo.InvariantCulture, $"'{script}|' + $e.Count + '|' + (($e | ForEach-Object {{ $_.Extent.StartLineNumber.ToString() + ': ' + $_.Message }}) -join ' / ')\n");
        File.WriteAllText(probe, text.ToString(), Encoding.ASCII);
        var (code, stdout, stderr) = await Shells.FileAsync(shell, probe);
        Assert.True(code == 0, stderr);
        var results = Shells.Lines(stdout).Select(l => l.Split('|', 3)).ToDictionary(p => p[0], p => (Count: p[1], Errors: p[2]));
        Assert.Equal(scripts.Order(), results.Keys.Order());
        Assert.Empty(results.Where(r => r.Value.Count != "0").Select(r => $"{r.Key}: {r.Value.Errors}"));
    }

    [Theory]
    [InlineData(Shells.WindowsPowerShell)]
    [InlineData(Shells.Pwsh)]
    public async Task ReadinessRefusesAStaleDaemonOrBridgeEvenWhenItsHealthIsOk(string shell)
    {
        string probe = _dir["running-version.ps1"];
        File.WriteAllText(probe,
            "$ErrorActionPreference = 'Stop'\n$t = $null; $e = $null\n" +
            $"$ast = [System.Management.Automation.Language.Parser]::ParseFile({Shells.Quote(Repo.File("verify.ps1"))}, [ref]$t, [ref]$e)\n" +
            "$f = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Assert-RunningVersion' }, $true)[0]\n" +
            "$fn = Join-Path (Split-Path $PSCommandPath) 'assert-running-version.ps1'; [IO.File]::WriteAllText($fn, $f.Extent.Text); . $fn\n" +
            "function Try-Version([string]$Service, $State) { try { Assert-RunningVersion $Service $State '2.33.3'; 'ok' } catch { 'refused ' + $_.Exception.Message } }\n" +
            "Try-Version 'Demon MCP Browser' ([pscustomobject]@{status='ok'; version='2.33.3'; pid=42})\n" +
            "Try-Version 'Demon MCP Browser' ([pscustomobject]@{status='ok'; version='2.33.0'; pid=43})\n" +
            "Try-Version 'Pont Browser' ([pscustomobject]@{status='online'; version='2.33.0'; pid=44})\n" +
            "Try-Version 'Demon MCP Browser' ([pscustomobject]@{status='ok'; pid=45})\n",
            Encoding.ASCII);
        var (code, stdout, stderr) = await Shells.FileAsync(shell, probe);
        Assert.True(code == 0, stderr);
        var lines = Shells.Lines(stdout);
        Assert.Equal(4, lines.Length);
        Assert.Equal("ok", lines[0]);
        Assert.StartsWith("refused Demon MCP Browser actif en version 2.33.0 (PID 43), moteur installe 2.33.3", lines[1]);
        Assert.StartsWith("refused Pont Browser actif en version 2.33.0 (PID 44), moteur installe 2.33.3", lines[2]);
        Assert.StartsWith("refused Demon MCP Browser actif en version inconnue (PID 45), moteur installe 2.33.3", lines[3]);
    }

    [Theory]
    [InlineData(Shells.WindowsPowerShell)]
    [InlineData(Shells.Pwsh)]
    public async Task AConcurrentInstallerDefersBeforeTouchingItsDownload(string shell)
    {
        string root = _dir["locked-install"];
        Directory.CreateDirectory(root);
        using var held = new FileStream(Path.Join(root, "update.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        var (code, stdout, stderr) = await Shells.FileAsync(shell, Repo.File("get.ps1"), ["-UpdateOnly"],
            new Dictionary<string, string?> { ["NEXUS_BROWSER_ROOT"] = root });
        Assert.True(code == 0, stdout + stderr);
        Assert.Contains("\"reason\":\"maintenance-in-progress\"", stdout);
        Assert.False(Directory.Exists(Path.Join(root, "download")));
        Assert.False(Directory.Exists(Path.Join(root, "app.next")));
    }

    // ---------------------------------------------------------------------------------------------
    // get.ps1: latest tag without the API, SHA256SUMS.txt checked before unpacking, architecture
    // ---------------------------------------------------------------------------------------------

    private static readonly string Get = File.ReadAllText(Repo.File("get.ps1"));

    [Fact]
    public void GetReadsTheLatestTagFromTheReleasesRedirect()
    {
        var apiLines = Get.Split('\n').Where(line => Regex.Matches(line, @"https://[^\s'""]+").Any(m => m.Value.StartsWith("https://api.github.com/", StringComparison.Ordinal))).ToList();
        var fallback = Assert.Single(apiLines); // the API is only the fallback
        Assert.Contains("Invoke-RestMethod", fallback);
        Assert.Contains("https://github.com/$repository/releases/latest", Get);
        Assert.Contains("AllowAutoRedirect = $false", Get);
        Assert.Contains("'/releases/tag/([^/?#]+)$'", Get);
        Assert.Contains("Get-LatestTag }", Get); // $tag = ... else { Get-LatestTag }
        Assert.DoesNotContain("release.tag_name", Get);
    }

    [Fact]
    public void GetVerifiesSha256SumsAndProvenanceBeforeUnpacking()
    {
        int compare = Get.IndexOf("if ($sha -ne (Get-ExpectedHash $sums $zipName)) { throw", StringComparison.Ordinal);
        int provenance = Get.IndexOf("attestation verify $zip --repo $repository --signer-repo pironjulien/NexusSystem", StringComparison.Ordinal);
        int extract = Get.IndexOf("[IO.Compression.ZipFile]::ExtractToDirectory($zip", StringComparison.Ordinal);
        int start = Get.IndexOf("$code = Invoke-Engine $engine $arguments", StringComparison.Ordinal);
        Assert.True(compare > 0 && provenance > compare && extract > provenance && start > extract, $"compare={compare} provenance={provenance} extract={extract} start={start}");
        Assert.Contains("SHA256SUMS.txt missing from the release: installation refused.", Get);
        Assert.Contains("Get-FileHash -LiteralPath $zip -Algorithm SHA256", Get);
    }

    /// <summary>get.ps1 only fetches, checks and starts the package's engine: every installation step is the engine's
    /// (native\Installer.cs), so the downloaded script stays small and never changes the PC by itself.</summary>
    [Fact]
    public void GetIsAMinimalStarterOfTheEnginesInstaller()
    {
        Assert.Contains("@('--install', '--switch', '--source', $package, $mode)", Get);
        Assert.Contains("@('--install', '--reuse-installed', '--update-only')", Get);
        foreach (string step in new[] { "ScheduledTask", "HKCU", "robocopy", "install.ps1", "Rename-Item", "SetEnvironmentVariable", "registre-reel" })
            Assert.DoesNotContain(step, Get.Replace("A clone installs with its own install.ps1", "", StringComparison.Ordinal), StringComparison.Ordinal);
        Assert.True(Get.Split('\n').Count(l => l.Trim().Length > 0 && !l.TrimStart().StartsWith('#')) < 160, "get.ps1 grew past a starter");
    }

    [Fact]
    public void GetPicksThePackageOfWindowsOwnArchitecture()
    {
        Assert.Contains("$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }", Get);
        Assert.Matches(@"'ARM64'\s*\{\s*'win-arm64'\s*\}", Get);
        Assert.Matches(@"'AMD64'\s*\{\s*'win-x64'\s*\}", Get);
        Assert.Contains("$zipName = \"NexusBrowser-$rid.zip\"", Get);
    }

    [Theory]
    [InlineData(Shells.WindowsPowerShell)]
    [InlineData(Shells.Pwsh)]
    public async Task GetExpectedHashParsesSha256Sums(string shell)
    {
        string a = new('a', 64), b = new('B', 64);
        string probe = _dir["hash.ps1"];
        File.WriteAllText(probe,
            "$t = $null; $e = $null\n" +
            $"$ast = [System.Management.Automation.Language.Parser]::ParseFile({Shells.Quote(Repo.File("get.ps1"))}, [ref]$t, [ref]$e)\n" +
            "$f = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-ExpectedHash' }, $true)[0]\n" +
            "$fn = Join-Path (Split-Path $PSCommandPath) 'get-expected-hash.ps1'; [IO.File]::WriteAllText($fn, $f.Extent.Text); . $fn\n" +
            "function Try-Hash([string]$Sums, [string]$Name) { try { 'ok ' + (Get-ExpectedHash $Sums $Name) } catch { 'refused ' + $_.Exception.Message } }\n" +
            $"Try-Hash \"{a}  NexusBrowser-win-x64.zip`r`n{b} *NexusBrowser-win-arm64.zip`n\" 'NexusBrowser-win-x64.zip'\n" +
            $"Try-Hash \"{a}  NexusBrowser-win-x64.zip`n{b} *NexusBrowser-win-arm64.zip`n\" 'NexusBrowser-win-arm64.zip'\n" +
            $"Try-Hash \"{a}  NexusBrowser-win-x64.zip`n\" 'nexusbrowser-win-x64.zip'\n" +
            $"Try-Hash \"{a}  NexusBrowser-win-x64.zip`n{b}  NexusBrowser-win-x64.zip`n\" 'NexusBrowser-win-x64.zip'\n" +
            $"Try-Hash \"{a}  NexusBrowser-win-x64.zip`nnot a sum line`n\" 'NexusBrowser-win-x64.zip'\n" +
            $"Try-Hash \"{a[..63]}  NexusBrowser-win-x64.zip`n\" 'NexusBrowser-win-x64.zip'\n",
            Encoding.ASCII);
        var (code, stdout, stderr) = await Shells.FileAsync(shell, probe);
        Assert.True(code == 0, stderr);
        Assert.Equal(
        [
            $"ok {a}",
            $"ok {b.ToLowerInvariant()}",
            "refused nexusbrowser-win-x64.zip is absent from SHA256SUMS.txt: installation refused.",
            "refused SHA256SUMS.txt lists NexusBrowser-win-x64.zip twice: installation refused.",
            "refused SHA256SUMS.txt has an invalid line: installation refused.",
            "refused SHA256SUMS.txt has an invalid line: installation refused.",
        ], Shells.Lines(stdout));
    }

    /// <summary>The engine starts its tasks by the names the installer registers; the former names (with a space)
    /// survive only in the migration table, the history and the CI fixture that recreates an older install.</summary>
    [Fact]
    public void TaskNamesAreTheInstallersAndTheFormerNamesOnlyMigrate()
    {
        string runtime = File.ReadAllText(Repo.File("scripts", "runtime.ps1"));
        Assert.Contains($"Bridge = '{McpServer.BridgeTaskName}'; Daemon = 'NexusBrowser MCP'; Update = '{BridgeServer.UpdateTaskName}'", runtime);
        Assert.Equal((McpServer.BridgeTaskName, BridgeServer.UpdateTaskName), (TaskNames.Bridge, TaskNames.Update));
        string[] allowed = ["CHANGELOG.md", "README.md", "scripts/runtime.ps1", ".github/workflows/install.yml", "tests/NexusBrowser.Tests/ScriptTests.cs",
            "native/InstallSupport.cs", "tests/NexusBrowser.Tests/InstallerTests.cs"];
        var offending = new List<string>();
        foreach (string file in Directory.EnumerateFiles(Repo.Root, "*", SearchOption.AllDirectories))
        {
            string relative = Path.GetRelativePath(Repo.Root, file).Replace('\\', '/');
            if (relative.StartsWith(".git/", StringComparison.Ordinal) || relative.Contains("/bin/") || relative.Contains("/obj/") ||
                relative.StartsWith("extension/", StringComparison.Ordinal) || allowed.Contains(relative) ||
                Path.GetExtension(file) is not (".ps1" or ".cs" or ".md" or ".json" or ".yml" or ".js" or ".cjs")) continue;
            if (File.ReadAllText(file).Contains("Nexus Browser ", StringComparison.Ordinal)) offending.Add(relative);
        }
        Assert.Empty(offending);
        // runtime.ps1: the former names appear once, in the migration table.
        Assert.Single(Regex.Matches(runtime, "Nexus Browser Bridge"));
    }

    /// <summary>A release zip as package-release.ps1 lays it out, with the engine built for these tests.</summary>
    private string FakeRelease(string folder)
    {
        string staging = Path.Join(_dir.Path, folder + "-staging");
        string engine = Path.Join(staging, "engine");
        Directory.CreateDirectory(engine);
        foreach (string name in new[] { "NexusBrowser.exe", "NexusBrowser.dll", "NexusBrowser.runtimeconfig.json", "NexusBrowser.deps.json", "SkiaSharp.dll" })
            File.Copy(Path.Join(AppContext.BaseDirectory, name), Path.Join(engine, name));
        string native = Path.Join(AppContext.BaseDirectory, "runtimes", "win-x64", "native", "libSkiaSharp.dll");
        Directory.CreateDirectory(Path.Join(engine, "runtimes", "win-x64", "native"));
        File.Copy(native, Path.Join(engine, "runtimes", "win-x64", "native", "libSkiaSharp.dll"));
        File.WriteAllText(Path.Join(staging, "VERSION"), BridgeSecurity.Version + "\n", Encoding.ASCII);
        string release = Directory.CreateDirectory(Path.Join(_dir.Path, folder)).FullName;
        string zip = Path.Join(release, "NexusBrowser-win-x64.zip");
        ZipFile.CreateFromDirectory(staging, zip);
        string hash = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(zip)));
        File.WriteAllText(Path.Join(release, "SHA256SUMS.txt"), $"{hash}  NexusBrowser-win-x64.zip\n{new string('0', 64)}  NexusBrowser-win-arm64.zip\n", Encoding.ASCII);
        return zip;
    }

    [Theory]
    [InlineData(Shells.WindowsPowerShell)]
    [InlineData(Shells.Pwsh)]
    public async Task GetChecksUnpacksAndRunsTheEngineInATestFolder(string shell)
    {
        string zip = FakeRelease("release");
        string root = _dir["install"];
        var (code, stdout, stderr) = await Shells.FileAsync(shell, Repo.File("get.ps1"), env: new Dictionary<string, string?>
        {
            ["NEXUS_BROWSER_SOURCE"] = zip,
            ["NEXUS_BROWSER_ROOT"] = root,
        }, timeoutSeconds: 90);
        Assert.True(code == 0, stdout + stderr);
        Assert.Contains("Package checked against SHA256SUMS.txt.", stdout);
        Assert.Contains($"NexusBrowser {BridgeSecurity.Version} unpacked in", stdout);
        Assert.True(File.Exists(Path.Join(root, "app", "engine", "NexusBrowser.exe")));
        Assert.Equal(["app", "update.lock"], Directory.EnumerateFileSystemEntries(root).Select(Path.GetFileName).Order());
    }

    [Theory]
    [InlineData(Shells.WindowsPowerShell)]
    [InlineData(Shells.Pwsh)]
    public async Task RealRegistryReadsBackWhatItWritesAndItsOutOfPackageWorkerAnswersTheSame(string shell)
    {
        // Out of a package (CI, the maintenance, the sync started by WMI) the key is written by the .NET API in the calling
        // process; under a packaged app (a Claude session) by the one-shot task: never reg.exe or cmd.exe (held more than
        // 20 s on 07/11/2026). The worker mode, what that task runs, gives the same answers. Only a throwaway key is touched,
        // removed through the same paths.
        string key = @"HKCU\Software\NexusBrowser.Tests-" + Guid.NewGuid().ToString("N");
        string script = Repo.File("scripts", "registre-reel.ps1");
        string request = _dir["registry-request.json"];
        string answer = _dir["registry-answer.json"];
        File.WriteAllText(request, new JsonArray(
            new JsonObject { ["action"] = "set", ["cle"] = key + @"\worker", ["valeur"] = "w" },
            new JsonObject { ["action"] = "get", ["cle"] = key + @"\worker" },
            new JsonObject { ["action"] = "get", ["cle"] = key + @"\none" }).ToJsonString());
        string probe = _dir["registry-probe.ps1"];
        File.WriteAllText(probe, $"""
            . {Shells.Quote(script)}
            "absent=[$($null -eq (Get-RegistreReel {Shells.Quote(key)}))]"
            "set=[$(Set-RegistreReel {Shells.Quote(key + @"\host")} 'C:\x y\%TEMP%\m.json')]"
            "get=[$(Get-RegistreReel {Shells.Quote(key + @"\host")})]"
            "removed=[$(Remove-RegistreReel {Shells.Quote(key + @"\host")})]"
            "again=[$(Remove-RegistreReel {Shells.Quote(key + @"\host")})]"
            $null = Remove-RegistreReel {Shells.Quote(key)}
            """);
        try
        {
            var (code, stdout, stderr) = await Shells.FileAsync(shell, probe);
            Assert.True(code == 0, stdout + stderr);
            Assert.Equal(["absent=[True]", @"set=[C:\x y\%TEMP%\m.json]", @"get=[C:\x y\%TEMP%\m.json]", "removed=[True]", "again=[False]"], Shells.Lines(stdout));
            var worker = await Shells.FileAsync(shell, script, ["-NexusRegistreRequete", request, "-NexusRegistreReponse", answer]);
            Assert.True(worker.Code == 0, worker.Stdout + worker.Stderr);
            var parsed = JsonNode.Parse(File.ReadAllText(answer))!;
            Assert.True(parsed["ok"]!.GetValue<bool>());
            Assert.Equal(new string?[] { "w", "w", null }, parsed["resultats"]!.AsArray().Select(n => n?.GetValue<string>()).ToArray());
        }
        finally
        {
            Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(key[5..], false);
        }
    }

    [Theory]
    [InlineData(Shells.WindowsPowerShell)]
    [InlineData(Shells.Pwsh)]
    public async Task AnInterruptedRecoveryIsTakenOverInsteadOfBlockingEveryUpdate(string shell)
    {
        // What a restore stopped midway leaves (07/11/2026): the failed controller in app.failed and, when the second
        // rename never happened, the previous version still in app.previous. The next verified package takes over.
        string zip = FakeRelease("after-interrupted-recovery");
        string root = _dir["interrupted-install"];
        Directory.CreateDirectory(Path.Join(root, "app.failed", "scripts"));
        File.WriteAllText(Path.Join(root, "app.failed", "install.ps1"), "throw 'The stale controller must never run'");
        Directory.CreateDirectory(Path.Join(root, "app.previous"));
        File.WriteAllText(Path.Join(root, "app.previous", "install.ps1"), "throw 'The previous installer must never run'");
        var (code, stdout, stderr) = await Shells.FileAsync(shell, Repo.File("get.ps1"), env: new Dictionary<string, string?>
        {
            ["NEXUS_BROWSER_SOURCE"] = zip,
            ["NEXUS_BROWSER_ROOT"] = root,
        }, timeoutSeconds: 90);
        Assert.True(code == 0, stdout + stderr);
        Assert.Contains("Interrupted recovery taken over", stdout);
        Assert.Contains($"NexusBrowser {BridgeSecurity.Version} unpacked in", stdout);
        // app.previous went back to app before the switch (the test folder then replaces app with the new package).
        Assert.Equal(["app", "update.lock"], Directory.EnumerateFileSystemEntries(root).Select(Path.GetFileName).Order());
    }

    [Theory]
    [InlineData(Shells.WindowsPowerShell)]
    [InlineData(Shells.Pwsh)]
    public async Task AScannerBrieflyHoldingTheFreshEngineDoesNotFailTheSwitch(string shell)
    {
        // What an antivirus does to a freshly written executable: opens it for a moment (every sharing mode allowed),
        // which blocks renaming its folder. get.ps1 waits that hold out on app.next -> app instead of failing ("being
        // used by another process", seen with NexusAGYmail in NexusSystem's pack job on a fresh Windows runner).
        string zip = FakeRelease("scanned-release");
        string root = _dir["scanned-install"];
        Directory.CreateDirectory(root);
        // get.ps1 writes the signal file once app.next is complete and waits for its removal before the rename: the hold
        // is taken before the switch for certain (a FileSystemWatcher racing the copy missed app.next once in 90 s).
        string signal = Path.Join(_dir["scanned-signal"], "staged.txt");
        Directory.CreateDirectory(Path.GetDirectoryName(signal)!);
        string path = Path.Join(root, "app.next", "engine", "NexusBrowser.exe");
        string? held = null;
        bool stagedWhileHeld = false;
        Exception? failure = null;
        using var released = new ManualResetEventSlim();
        var scanner = new Thread(() =>
        {
            try
            {
                var deadline = DateTime.UtcNow.AddSeconds(90);
                while (!File.Exists(signal) && DateTime.UtcNow < deadline)
                    Thread.Sleep(10);
                if (!File.Exists(signal))
                    return;
                using var scan = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                held = path;
                // The script may still be closing the signal file it just wrote: removing it is retried briefly.
                for (int i = 0; File.Exists(signal); i++)
                {
                    try { File.Delete(signal); }
                    catch (IOException) when (i < 200) { Thread.Sleep(10); }
                }
                Thread.Sleep(2_000);
                stagedWhileHeld = File.Exists(path);
            }
            catch (Exception ex) { failure = ex; }
            finally { released.Set(); }
        }) { IsBackground = true };
        scanner.Start();

        var (code, stdout, stderr) = await Shells.FileAsync(shell, Repo.File("get.ps1"), env: new Dictionary<string, string?>
        {
            ["NEXUS_BROWSER_SOURCE"] = zip,
            ["NEXUS_BROWSER_ROOT"] = root,
            ["NEXUS_BROWSER_STAGED_SIGNAL"] = signal,
        }, timeoutSeconds: 90);
        Assert.True(released.Wait(90_000, TestContext.Current.CancellationToken));
        Assert.Null(failure);
        Assert.True(code == 0, stdout + stderr);
        Assert.NotNull(held);
        Assert.Contains("app.next", held, StringComparison.OrdinalIgnoreCase);
        Assert.True(stagedWhileHeld, "the hold must have overlapped app.next");
        Assert.Contains($"NexusBrowser {BridgeSecurity.Version} unpacked in", stdout);
        Assert.True(File.Exists(Path.Join(root, "app", "engine", "NexusBrowser.exe")));
        Assert.False(Directory.Exists(Path.Join(root, "app.next")));
    }

    [Fact]
    public async Task WindowsPowerShellInstallerRepairsInheritedCoreModulePrecedence()
    {
        var core = await ChildProcess.RunAsync(Shells.Pwsh, ["-NoProfile", "-Command", "$PSHOME"]);
        var desktop = await ChildProcess.RunAsync(Shells.WindowsPowerShell, ["-NoProfile", "-Command", "$PSHOME"], new Dictionary<string, string?> { ["PSModulePath"] = null });
        string polluted = Path.Join(core.Stdout.Trim(), "Modules") + ";" + Path.Join(desktop.Stdout.Trim(), "Modules");
        string zip = FakeRelease("module-regression");
        var result = await ChildProcess.RunAsync(Shells.WindowsPowerShell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", Repo.File("get.ps1")],
            new Dictionary<string, string?> { ["PSModulePath"] = polluted, ["NEXUS_BROWSER_SOURCE"] = zip, ["NEXUS_BROWSER_ROOT"] = _dir["module-install"] });
        Assert.True(result.Code == 0, result.Stdout + result.Stderr);
        Assert.Contains("Package checked against SHA256SUMS.txt.", result.Stdout);
    }

    [Fact]
    public async Task GetRefusesAPackageThatIsNotThePublishedOne()
    {
        string zip = FakeRelease("tampered");
        using (var archive = ZipFile.Open(zip, ZipArchiveMode.Update))
            using (var writer = new StreamWriter(archive.CreateEntry("extra.txt").Open()))
                writer.Write("not published");
        string root = _dir["install"];
        var (code, stdout, stderr) = await Shells.FileAsync(Shells.WindowsPowerShell, Repo.File("get.ps1"), env: new Dictionary<string, string?>
        {
            ["NEXUS_BROWSER_SOURCE"] = zip,
            ["NEXUS_BROWSER_ROOT"] = root,
        }, timeoutSeconds: 90);
        Assert.NotEqual(0, code);
        Assert.Contains("SHA-256 mismatch for NexusBrowser-win-x64.zip", stdout + stderr);
        Assert.False(Directory.Exists(Path.Join(root, "app")));
        Assert.False(Directory.Exists(Path.Join(root, "download", "package")));
    }

    // ---------------------------------------------------------------------------------------------
    // antigravity-duplicate.ps1 and legacy-extension.ps1 (run on disposable files)
    // ---------------------------------------------------------------------------------------------

    [Fact]
    public async Task AntigravityDuplicateIsRemovedKeepingOtherServers()
    {
        string script = Repo.File("scripts", "antigravity-duplicate.ps1");
        string config = _dir["mcp_config.json"];
        var original = new JsonObject
        {
            ["mcpServers"] = new JsonObject
            {
                ["nexus-computer"] = new JsonObject { ["command"] = "computer.exe", ["args"] = new JsonArray("--mcp") },
                ["nexus-browser"] = new JsonObject { ["command"] = "NexusBrowser.exe", ["args"] = new JsonArray("--mcp") },
            },
            ["autre"] = new JsonObject { ["garde"] = true },
        };
        File.WriteAllText(config, original.ToJsonString());

        var check = await Shells.FileAsync(Shells.Pwsh, script, ["-ConfigPath", config, "-CheckOnly"]);
        Assert.Equal(1, check.Code);
        Assert.Contains("Doublon", check.Stdout);
        Assert.True(JsonNode.DeepEquals(original, JsonNode.Parse(File.ReadAllText(config)))); // -CheckOnly writes nothing

        string backups = _dir["sauvegardes"];
        var done = await Shells.FileAsync(Shells.Pwsh, script, ["-ConfigPath", config, "-BackupDir", backups]);
        Assert.True(done.Code == 0, done.Stderr);
        var expected = (JsonObject)original.DeepClone();
        expected["mcpServers"]!.AsObject().Remove("nexus-browser");
        Assert.True(JsonNode.DeepEquals(expected, JsonNode.Parse(File.ReadAllText(config))), File.ReadAllText(config));
        string saved = Assert.Single(Directory.EnumerateFiles(backups));
        Assert.True(JsonNode.DeepEquals(original, JsonNode.Parse(File.ReadAllText(saved))));
        Assert.Empty(Directory.EnumerateFiles(_dir.Path, "*.tmp")); // atomic write: nothing left behind

        Assert.Equal(0, (await Shells.FileAsync(Shells.Pwsh, script, ["-ConfigPath", config, "-CheckOnly"])).Code);
        Assert.Equal(0, (await Shells.FileAsync(Shells.Pwsh, script, ["-ConfigPath", _dir["absent.json"], "-CheckOnly"])).Code);
    }

    [Fact]
    public async Task OldExtensionIsReportedFromProfilePreferencesReadOnly()
    {
        string userData = _dir["User Data"];
        string unpacked = Directory.CreateDirectory(_dir["ancien-pont"]).FullName;
        File.WriteAllText(Path.Join(unpacked, "manifest.json"), "{\"name\": \"Antigravity Browser Bridge\"}");
        var settings = new JsonObject
        {
            ["aaaapppppppppppppppppppppppppppp"] = new JsonObject { ["path"] = unpacked, ["state"] = 1 },
            ["bbbbpppppppppppppppppppppppppppp"] = new JsonObject { ["manifest"] = new JsonObject { ["name"] = "Antigravity Browser Bridge" }, ["disable_reasons"] = new JsonArray(1) },
            ["ccccpppppppppppppppppppppppppppp"] = new JsonObject { ["manifest"] = new JsonObject { ["name"] = "Antigravity Browser Bridge" }, ["state"] = 0 },
            [FakeExtension.Id] = new JsonObject { ["manifest"] = new JsonObject { ["name"] = "NexusBrowser" } },
        };
        foreach (string profile in new[] { "Default", "Profile 2", "System Profile" })
        {
            Directory.CreateDirectory(Path.Join(userData, profile));
            File.WriteAllText(Path.Join(userData, profile, "Secure Preferences"), new JsonObject { ["extensions"] = new JsonObject { ["settings"] = settings.DeepClone() } }.ToJsonString());
        }
        File.WriteAllText(Path.Join(userData, "Default", "Preferences"), "{not json"); // unreadable: skipped
        var before = Directory.EnumerateFiles(userData, "*", SearchOption.AllDirectories).ToDictionary(f => f, File.ReadAllBytes);

        var (code, stdout, stderr) = await Shells.FileAsync(Shells.Pwsh, Repo.File("scripts", "legacy-extension.ps1"), ["-UserData", userData]);
        Assert.True(code == 0, stderr);
        Assert.Equal(
        [
            "Default : Antigravity Browser Bridge (aaaapppppppppppppppppppppppppppp)",
            "Profile 2 : Antigravity Browser Bridge (aaaapppppppppppppppppppppppppppp)",
        ], Shells.Lines(stdout).Order(StringComparer.Ordinal));
        foreach (var (file, bytes) in before) Assert.Equal(bytes, File.ReadAllBytes(file)); // read only

        var none = await Shells.FileAsync(Shells.Pwsh, Repo.File("scripts", "legacy-extension.ps1"), ["-UserData", _dir["absent"]]);
        Assert.Equal(0, none.Code);
        Assert.Empty(Shells.Lines(none.Stdout));
    }

    // ---------------------------------------------------------------------------------------------
    // store-package.ps1: the Chrome Web Store package
    // ---------------------------------------------------------------------------------------------

    private async Task<string> StorePackageAsync(params string[] extra)
    {
        string outDir = _dir["store"];
        var (code, stdout, stderr) = await Shells.FileAsync(Shells.Pwsh, Repo.File("scripts", "store-package.ps1"), ["-OutDir", outDir, .. extra]);
        Assert.True(code == 0, stdout + stderr);
        string zip = Assert.Single(Shells.Lines(stdout));
        Assert.Equal(outDir, Path.GetDirectoryName(zip));
        Assert.True(File.Exists(zip), zip);
        return zip;
    }

    private static string Entry(ZipArchive archive, string name)
    {
        using var reader = new StreamReader(archive.GetEntry(name)!.Open(), Encoding.UTF8);
        return reader.ReadToEnd();
    }

    private static byte[] Bytes(ZipArchive archive, string name)
    {
        using var stream = archive.GetEntry(name)!.Open();
        using var copy = new MemoryStream();
        stream.CopyTo(copy);
        return copy.ToArray();
    }

    private static string[] RemoteHosts(string policy)
    {
        var connect = Regex.Match(policy, "connect-src ([^;]+)");
        return connect.Success
            ? connect.Groups[1].Value.Split(' ', StringSplitOptions.RemoveEmptyEntries).Where(s => s.StartsWith("https://", StringComparison.Ordinal)).Select(s => new Uri(s).Host).ToArray()
            : [];
    }

    [Fact]
    public async Task StoreZipIsTheExtensionWithoutKey()
    {
        string zip = await StorePackageAsync();
        string extension = Repo.File("extension");
        var manifest = (JsonObject)JsonNode.Parse(File.ReadAllText(Path.Join(extension, "manifest.json")))!;
        var files = Directory.EnumerateFiles(extension, "*", SearchOption.AllDirectories)
            .Select(f => Path.GetRelativePath(extension, f).Replace('\\', '/')).Order(StringComparer.Ordinal).ToList();
        using var archive = ZipFile.OpenRead(zip);
        Assert.Equal(files, archive.Entries.Select(e => e.FullName).Order(StringComparer.Ordinal));
        var packaged = (JsonObject)JsonNode.Parse(Entry(archive, "manifest.json"))!;
        Assert.True(manifest.ContainsKey("key"));
        Assert.False(packaged.ContainsKey("key"));
        manifest.Remove("key");
        Assert.True(JsonNode.DeepEquals(manifest, packaged), packaged.ToJsonString());
        foreach (string file in files.Where(f => f != "manifest.json"))
            Assert.True(File.ReadAllBytes(Path.Join(extension, file)).AsSpan().SequenceEqual(Bytes(archive, file)), file);
        Assert.Equal($"nexus-browser-extension-{manifest["version"]}.zip", Path.GetFileName(zip));
    }

    [Fact]
    public async Task VariantWithoutTheGmailCounterChangesOnlyItsThreeFiles()
    {
        string standard = await StorePackageAsync();
        string variant = await StorePackageAsync("-WithoutGmailCounter");
        Assert.EndsWith("-without-gmail-counter.zip", variant);
        using var a = ZipFile.OpenRead(standard);
        using var b = ZipFile.OpenRead(variant);
        var names = a.Entries.Select(e => e.FullName).ToList();
        Assert.Equal(names, b.Entries.Select(e => e.FullName));
        var changed = names.Where(n => !Bytes(a, n).AsSpan().SequenceEqual(Bytes(b, n))).Order(StringComparer.Ordinal);
        Assert.Equal(["background.js", "manifest.json", "popup.html"], changed);

        string variantCsp = (string)JsonNode.Parse(Entry(b, "manifest.json"))!["content_security_policy"]!["extension_pages"]!;
        Assert.Empty(RemoteHosts(variantCsp));
        Assert.Contains("ws://127.0.0.1:*", variantCsp);
        Assert.Equal(["mail.google.com"], RemoteHosts((string)JsonNode.Parse(Entry(a, "manifest.json"))!["content_security_policy"]!["extension_pages"]!));
        // Apart from the CSP, both manifests are the same.
        var ma = (JsonObject)JsonNode.Parse(Entry(a, "manifest.json"))!;
        var mb = (JsonObject)JsonNode.Parse(Entry(b, "manifest.json"))!;
        ma["content_security_policy"]!["extension_pages"] = variantCsp;
        Assert.True(JsonNode.DeepEquals(ma, mb));

        string popup = Entry(b, "popup.html");
        Assert.DoesNotContain("compteur-gmail", popup);
        Assert.DoesNotContain("<label", popup);
        Assert.Contains("id=\"bridge\"", popup);
        Assert.Contains("const COMPTEUR_GMAIL_DISPONIBLE = false;", Entry(b, "background.js"));
        Assert.Contains("const COMPTEUR_GMAIL_DISPONIBLE = true;", Entry(a, "background.js"));
    }
}
