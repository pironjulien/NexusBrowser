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
        // then missing): each shell computes its own, as on a fresh logon.
        var environment = new Dictionary<string, string?>(env ?? new Dictionary<string, string?>()) { ["PSModulePath"] = null };
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
            text.Append($"$t = $null; $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile({Shells.Quote(Repo.File(script.Split('/')))}, [ref]$t, [ref]$e)\n")
                .Append($"'{script}|' + $e.Count + '|' + (($e | ForEach-Object {{ $_.Extent.StartLineNumber.ToString() + ': ' + $_.Message }}) -join ' / ')\n");
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
    public async Task ActivationReceiptNeedsTheLoadedFingerprintAndVerifiedExtension(string shell)
    {
        string probe = _dir["activation.ps1"];
        File.WriteAllText(probe,
            "$ErrorActionPreference='Stop'\n$t=$null;$e=$null\n" +
            $"$ast=[System.Management.Automation.Language.Parser]::ParseFile({Shells.Quote(Repo.File("scripts", "update-receipt.ps1"))},[ref]$t,[ref]$e)\n" +
            "$f=$ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-ActivationState'},$true)[0]\n" +
            "$fn=Join-Path (Split-Path $PSCommandPath) 'activation-function.ps1';[IO.File]::WriteAllText($fn,$f.Extent.Text);. $fn\n" +
            "$Published='2.33.5';$hash='a'*64;$current=[pscustomobject]@{version='2.33.5';fingerprint=$hash}\n" +
            "$daemon=[pscustomobject]@{status='ok';service='nexus-browser';version='2.33.5';fingerprint=$hash;pid=1}\n" +
            "$bridge=[pscustomobject]@{status='online';version='2.33.5';fingerprint=$hash;pid=2}\n" +
            "$extension=[pscustomobject]@{verified=$true}\n" +
            "(Get-ActivationState $current $daemon $bridge $extension)|ConvertTo-Json -Depth 5 -Compress\n" +
            "$daemon.fingerprint='b'*64;(Get-ActivationState $current $daemon $bridge $extension)|ConvertTo-Json -Depth 5 -Compress\n" +
            "$daemon.fingerprint=$hash;$extension.verified=$false;(Get-ActivationState $current $daemon $bridge $extension)|ConvertTo-Json -Depth 5 -Compress\n",
            Encoding.ASCII);
        var (code, stdout, stderr) = await Shells.FileAsync(shell, probe);
        Assert.True(code == 0, stderr);
        var receipts = Shells.Lines(stdout).Select(l => JsonNode.Parse(l)!).ToList();
        Assert.Equal("done", (string?)receipts[0]["state"]);
        Assert.Equal("2.33.5", (string?)receipts[0]["active"]);
        Assert.Equal("deferred", (string?)receipts[1]["state"]);
        Assert.Null(receipts[1]["active"]);
        Assert.Equal("daemon-activation-pending", (string?)receipts[1]["reason"]);
        Assert.Equal("extension-activation-pending", (string?)receipts[2]["reason"]);
    }

    [Theory]
    [InlineData(Shells.WindowsPowerShell)]
    [InlineData(Shells.Pwsh)]
    public async Task AConcurrentInstallerDefersBeforeTouchingItsDownload(string shell)
    {
        string root = _dir["locked-install"];
        Directory.CreateDirectory(root);
        using var held = new FileStream(Path.Combine(root, "update.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        var (code, stdout, stderr) = await Shells.FileAsync(shell, Repo.File("get.ps1"), ["-UpdateOnly"],
            new Dictionary<string, string?> { ["NEXUS_BROWSER_ROOT"] = root });
        Assert.True(code == 0, stdout + stderr);
        Assert.Contains("\"reason\":\"maintenance-in-progress\"", stdout);
        Assert.False(Directory.Exists(Path.Combine(root, "download")));
        Assert.False(Directory.Exists(Path.Combine(root, "app.next")));
    }

    [Theory]
    [InlineData(Shells.WindowsPowerShell)]
    [InlineData(Shells.Pwsh)]
    public async Task CachedActivationVerifiesTheWholePayloadWithoutExecutingItsScripts(string shell)
    {
        string payload = _dir["cached-payload"], probe = _dir["cache-verifier.ps1"];
        Directory.CreateDirectory(payload);
        File.WriteAllText(Path.Combine(payload, "get.ps1"), "throw 'must never execute cached code'");
        File.WriteAllText(Path.Combine(payload, "engine.txt"), "verified engine");
        File.WriteAllText(probe,
            "$ErrorActionPreference='Stop'\n$t=$null;$e=$null\n" +
            $"$ast=[System.Management.Automation.Language.Parser]::ParseFile({Shells.Quote(Repo.File("get.ps1"))},[ref]$t,[ref]$e)\n" +
            "$f=$ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-CachedPayloadFingerprint'},$true)[0]\n" +
            "$fn=Join-Path (Split-Path $PSCommandPath) 'cache-function.ps1';[IO.File]::WriteAllText($fn,$f.Extent.Text);. $fn\n" +
            $"Get-CachedPayloadFingerprint {Shells.Quote(payload)}\n" +
            $"& {Shells.Quote(Repo.File("scripts", "payload-integrity.ps1"))} -Path {Shells.Quote(payload)}\n" +
            $"[IO.File]::WriteAllText({Shells.Quote(Path.Combine(payload, "get.ps1"))},'changed cached installer')\n" +
            $"Get-CachedPayloadFingerprint {Shells.Quote(payload)}\n", Encoding.ASCII);
        var (code, stdout, stderr) = await Shells.FileAsync(shell, probe);
        Assert.True(code == 0, stderr);
        var hashes = Shells.Lines(stdout);
        Assert.Equal(3, hashes.Length);
        Assert.Equal(hashes[0], hashes[1]);
        Assert.NotEqual(hashes[0], hashes[2]);
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
    public void GetVerifiesSha256SumsBeforeUnpacking()
    {
        int check = Get.IndexOf("Get-ExpectedHash $sums $zipName", StringComparison.Ordinal);
        int compare = Get.IndexOf("if ($actual -ne $expected) { throw", StringComparison.Ordinal);
        int extract = Get.IndexOf("[IO.Compression.ZipFile]::ExtractToDirectory($zip", StringComparison.Ordinal);
        Assert.True(check > 0 && compare > check && extract > compare, $"check={check} compare={compare} extract={extract}");
        Assert.Contains("SHA256SUMS.txt missing from the release: installation refused.", Get);
        Assert.Contains("Get-FileHash -LiteralPath $zip -Algorithm SHA256", Get);
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

    /// <summary>A release zip as package-release.ps1 lays it out, with the engine built for these tests.</summary>
    private string FakeRelease(string folder)
    {
        string staging = Path.Combine(_dir.Path, folder + "-staging");
        string engine = Path.Combine(staging, "engine");
        Directory.CreateDirectory(engine);
        foreach (string name in new[] { "NexusBrowser.exe", "NexusBrowser.dll", "NexusBrowser.runtimeconfig.json", "NexusBrowser.deps.json", "SkiaSharp.dll" })
            File.Copy(Path.Combine(AppContext.BaseDirectory, name), Path.Combine(engine, name));
        string native = Path.Combine(AppContext.BaseDirectory, "runtimes", "win-x64", "native", "libSkiaSharp.dll");
        Directory.CreateDirectory(Path.Combine(engine, "runtimes", "win-x64", "native"));
        File.Copy(native, Path.Combine(engine, "runtimes", "win-x64", "native", "libSkiaSharp.dll"));
        File.WriteAllText(Path.Combine(staging, "VERSION"), BridgeSecurity.Version + "\n", Encoding.ASCII);
        string release = Directory.CreateDirectory(Path.Combine(_dir.Path, folder)).FullName;
        string zip = Path.Combine(release, "NexusBrowser-win-x64.zip");
        ZipFile.CreateFromDirectory(staging, zip);
        string hash = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(zip)));
        File.WriteAllText(Path.Combine(release, "SHA256SUMS.txt"), $"{hash}  NexusBrowser-win-x64.zip\n{new string('0', 64)}  NexusBrowser-win-arm64.zip\n", Encoding.ASCII);
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
        Assert.True(File.Exists(Path.Combine(root, "app", "engine", "NexusBrowser.exe")));
        Assert.Equal(["app", "update.lock"], Directory.EnumerateFileSystemEntries(root).Select(Path.GetFileName).Order());
    }

    [Fact]
    public async Task WindowsPowerShellInstallerRepairsInheritedCoreModulePrecedence()
    {
        var core = await ChildProcess.RunAsync(Shells.Pwsh, ["-NoProfile", "-Command", "$PSHOME"]);
        var desktop = await ChildProcess.RunAsync(Shells.WindowsPowerShell, ["-NoProfile", "-Command", "$PSHOME"], new Dictionary<string, string?> { ["PSModulePath"] = null });
        string polluted = Path.Combine(core.Stdout.Trim(), "Modules") + ";" + Path.Combine(desktop.Stdout.Trim(), "Modules");
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
        Assert.False(Directory.Exists(Path.Combine(root, "app")));
        Assert.False(Directory.Exists(Path.Combine(root, "download", "package")));
    }

    // ---------------------------------------------------------------------------------------------
    // doublon-antigravity.ps1 and ancienne-extension.ps1 (run on disposable files)
    // ---------------------------------------------------------------------------------------------

    [Fact]
    public async Task AntigravityDuplicateIsRemovedKeepingOtherServers()
    {
        string script = Repo.File("scripts", "doublon-antigravity.ps1");
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
        File.WriteAllText(Path.Combine(unpacked, "manifest.json"), "{\"name\": \"Antigravity Browser Bridge\"}");
        var settings = new JsonObject
        {
            ["aaaapppppppppppppppppppppppppppp"] = new JsonObject { ["path"] = unpacked, ["state"] = 1 },
            ["bbbbpppppppppppppppppppppppppppp"] = new JsonObject { ["manifest"] = new JsonObject { ["name"] = "Antigravity Browser Bridge" }, ["disable_reasons"] = new JsonArray(1) },
            ["ccccpppppppppppppppppppppppppppp"] = new JsonObject { ["manifest"] = new JsonObject { ["name"] = "Antigravity Browser Bridge" }, ["state"] = 0 },
            [FakeExtension.Id] = new JsonObject { ["manifest"] = new JsonObject { ["name"] = "NexusBrowser" } },
        };
        foreach (string profile in new[] { "Default", "Profile 2", "System Profile" })
        {
            Directory.CreateDirectory(Path.Combine(userData, profile));
            File.WriteAllText(Path.Combine(userData, profile, "Secure Preferences"), new JsonObject { ["extensions"] = new JsonObject { ["settings"] = settings.DeepClone() } }.ToJsonString());
        }
        File.WriteAllText(Path.Combine(userData, "Default", "Preferences"), "{not json"); // unreadable: skipped
        var before = Directory.EnumerateFiles(userData, "*", SearchOption.AllDirectories).ToDictionary(f => f, File.ReadAllBytes);

        var (code, stdout, stderr) = await Shells.FileAsync(Shells.Pwsh, Repo.File("scripts", "ancienne-extension.ps1"), ["-UserData", userData]);
        Assert.True(code == 0, stderr);
        Assert.Equal(
        [
            "Default : Antigravity Browser Bridge (aaaapppppppppppppppppppppppppppp)",
            "Profile 2 : Antigravity Browser Bridge (aaaapppppppppppppppppppppppppppp)",
        ], Shells.Lines(stdout).Order(StringComparer.Ordinal));
        foreach (var (file, bytes) in before) Assert.Equal(bytes, File.ReadAllBytes(file)); // read only

        var none = await Shells.FileAsync(Shells.Pwsh, Repo.File("scripts", "ancienne-extension.ps1"), ["-UserData", _dir["absent"]]);
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
        var manifest = (JsonObject)JsonNode.Parse(File.ReadAllText(Path.Combine(extension, "manifest.json")))!;
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
            Assert.True(File.ReadAllBytes(Path.Combine(extension, file)).AsSpan().SequenceEqual(Bytes(archive, file)), file);
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
