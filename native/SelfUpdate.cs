using System.Diagnostics;
using System.IO.Compression;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace NexusBrowser.Native;

/// <summary>
/// --self-update, what the task "NexusBrowser Update" runs (the bridge starts it on POST /api/update). NexusSystem owns
/// periodic maintenance: when its maintenance is installed, that runs. Otherwise the latest release package of this
/// PC's architecture is downloaded, checked against the release's SHA256SUMS.txt (and its build provenance when the
/// GitHub CLI is signed in), unpacked, and the NEW package's own engine installs it (--install --switch --update-only):
/// an update is always run by the code being installed, never by the build it replaces.
/// </summary>
internal static partial class SelfUpdate
{
    public const string Repository = "pironjulien/NexusBrowser";
    public const string SignerRepository = "pironjulien/NexusSystem";

    [GeneratedRegex(@"^v\d+\.\d+\.\d+(-dev\.\d+)?$")]
    internal static partial Regex ReleaseTag();

    [GeneratedRegex(@"^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$")]
    private static partial Regex SumLine();

    public static int Run(TextWriter output)
    {
        string central = Path.Join(BridgeSecurity.HomeDir(), ".nexus", "nexussystem", "maintenance", "get-nexus.ps1");
        if (File.Exists(central))
        {
            var info = new ProcessStartInfo(Path.Join(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe"))
            { UseShellExecute = false, CreateNoWindow = true };
            foreach (string arg in new[] { "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", central, "-Maintain" }) info.ArgumentList.Add(arg);
            using var process = Process.Start(info) ?? throw new IOException("powershell.exe not started");
            process.WaitForExit();
            return process.ExitCode;
        }
        return InstallLatestAsync(output).GetAwaiter().GetResult();
    }

    /// <summary>Expected SHA-256 of one file in a SHA256SUMS.txt ("&lt;hash&gt;  &lt;name&gt;" lines); a malformed or
    /// ambiguous manifest is refused.</summary>
    internal static string ExpectedHash(string sums, string name)
    {
        string? expected = null;
        foreach (string line in sums.Split('\n').Select(l => l.TrimEnd('\r')).Where(l => l.Trim().Length > 0))
        {
            var match = SumLine().Match(line);
            if (!match.Success) throw new InvalidDataException("SHA256SUMS.txt has an invalid line: installation refused.");
            if (!string.Equals(match.Groups[2].Value, name, StringComparison.Ordinal)) continue;
            if (expected is not null) throw new InvalidDataException($"SHA256SUMS.txt lists {name} twice: installation refused.");
            expected = match.Groups[1].Value.ToLowerInvariant();
        }
        return expected ?? throw new InvalidDataException($"{name} is absent from SHA256SUMS.txt: installation refused.");
    }

    internal static string Rid() => RuntimeInformation.OSArchitecture switch
    {
        Architecture.Arm64 => "win-arm64",
        Architecture.X64 => "win-x64",
        var other => throw new PlatformNotSupportedException($"Unsupported Windows architecture: {other} (x64 or ARM64 needed)."),
    };

    private static async Task<string> LatestTagAsync(HttpClient http)
    {
        if (Environment.GetEnvironmentVariable("NEXUS_RELEASE_TAG") is { Length: > 0 } pinned)
            return ReleaseTag().IsMatch(pinned) ? pinned : throw new ArgumentException($"NEXUS_RELEASE_TAG is not a release tag: {pinned}");
        // The redirect of releases/latest: no API call, so no rate limit. The API stays as a fallback.
        using (var head = new HttpRequestMessage(HttpMethod.Head, $"https://github.com/{Repository}/releases/latest"))
        using (var response = await http.SendAsync(head))
        {
            if (response.Headers.Location?.ToString() is { } location && Regex.Match(location, "/releases/tag/([^/?#]+)$") is { Success: true } m &&
                ReleaseTag().IsMatch(m.Groups[1].Value)) return m.Groups[1].Value;
        }
        var latest = JsonNode.Parse(await http.GetStringAsync(new Uri($"https://api.github.com/repos/{Repository}/releases/latest")));
        string tag = latest?["tag_name"]?.ToString() ?? "";
        return ReleaseTag().IsMatch(tag) ? tag : throw new InvalidDataException("Latest NexusBrowser release not found.");
    }

    internal static string? Which(string name) =>
        (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
            .Select(dir => Path.Join(dir.Trim('"'), name)).FirstOrDefault(File.Exists);

    private static (int Code, string Output) Run(string file, params string[] args)
    {
        var info = new ProcessStartInfo(file) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (string arg in args) info.ArgumentList.Add(arg);
        using var process = Process.Start(info) ?? throw new IOException($"{file} not started");
        var stdout = process.StandardOutput.ReadToEndAsync();
        string stderr = process.StandardError.ReadToEnd();
        if (!process.WaitForExit(120_000)) { process.Kill(entireProcessTree: true); return (1, "timed out"); }
        return (process.ExitCode, (stdout.Result + stderr).Trim());
    }

    /// <summary>Build provenance of the package (Sigstore, signed by NexusSystem's shared release workflow), checked
    /// when the GitHub CLI is installed and signed in; a failed check refuses the package.</summary>
    internal static void VerifyAttestation(string file, TextWriter output)
    {
        if (Which("gh.exe") is not { } gh) { output.WriteLine("Build provenance not checked (GitHub CLI not installed); SHA-256 checked."); return; }
        if (Run(gh, "auth", "status").Code != 0) { output.WriteLine("Build provenance not checked (GitHub CLI not signed in); SHA-256 checked."); return; }
        var (code, text) = Run(gh, "attestation", "verify", file, "--repo", Repository, "--signer-repo", SignerRepository);
        if (code != 0) throw new InvalidDataException($"Build provenance of {Path.GetFileName(file)} not verified: installation refused. {text}");
        output.WriteLine("Build provenance verified (gh attestation verify).");
    }

    private static async Task<int> InstallLatestAsync(TextWriter output)
    {
        var layout = InstallLayout.ForUser();
        using var http = new HttpClient(new SocketsHttpHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromMinutes(10) };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("NexusBrowser-update");
        string tag = await LatestTagAsync(http);
        string zipName = $"NexusBrowser-{Rid()}.zip";
        string work = Path.Join(layout.NativeRoot, "download", Guid.NewGuid().ToString("N")[..12]);
        Directory.CreateDirectory(work);
        try
        {
            using var follow = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
            follow.DefaultRequestHeaders.UserAgent.ParseAdd("NexusBrowser-update");
            string url = $"https://github.com/{Repository}/releases/download/{tag}";
            output.WriteLine($"Downloading NexusBrowser {tag} ({Rid()})...");
            string zip = Path.Join(work, zipName);
            await using (var stream = await follow.GetStreamAsync(new Uri($"{url}/{zipName}")))
            await using (var file = File.Create(zip)) await stream.CopyToAsync(file);
            string sums = await follow.GetStringAsync(new Uri($"{url}/SHA256SUMS.txt"));
            string actual;
            await using (var file = File.OpenRead(zip)) actual = Convert.ToHexStringLower(await SHA256.HashDataAsync(file));
            if (actual != ExpectedHash(sums, zipName)) throw new InvalidDataException($"SHA-256 mismatch for {zipName}: the download is not the published package.");
            output.WriteLine("Package checked against SHA256SUMS.txt.");
            VerifyAttestation(zip, output);
            string package = Path.Join(work, "package");
            ZipFile.ExtractToDirectory(zip, package);
            string engine = Path.Join(package, "engine", "NexusBrowser.exe");
            if (!File.Exists(engine)) throw new InvalidDataException("Not a NexusBrowser package (engine\\NexusBrowser.exe missing).");
            if (!Version.TryParse(File.ReadAllText(Path.Join(package, "VERSION")).Trim(), out var version) || version < new Version(2, 36, 0))
                throw new InvalidDataException("This release predates the engine's installer: update through NexusSystem or the release's get.ps1.");
            var info = new ProcessStartInfo(engine)
            {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
            };
            foreach (string arg in new[] { "--install", "--switch", "--source", package, "--update-only", "--archive-sha256", actual }) info.ArgumentList.Add(arg);
            info.Environment["NEXUS_PACK"] = "1";
            using var process = Process.Start(info) ?? throw new IOException("The package's engine did not start.");
            process.StandardInput.Close();
            var stderr = process.StandardError.ReadToEndAsync();
            while (await process.StandardOutput.ReadLineAsync() is { } line) output.WriteLine(line);
            await process.WaitForExitAsync();
            if ((await stderr).Trim() is { Length: > 0 } errors) output.WriteLine(errors);
            return process.ExitCode;
        }
        finally { EngineBuilds.TryDelete(work); }
    }
}
