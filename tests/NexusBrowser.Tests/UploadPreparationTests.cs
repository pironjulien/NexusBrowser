using System.Text.Json.Nodes;
using NexusBrowser.Native;
using Xunit;

namespace NexusBrowser.Tests;

/// <summary>
/// browser_upload hands Chrome the path it can really read and the size on the disk (a 208 MB package reached
/// Partner Center as 0 bytes on 05/11: the path, redirected by Claude's MSIX virtualization, did not exist for Chrome).
/// </summary>
public sealed class UploadPreparationTests : IDisposable
{
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    private string LargeFile(string name, long size)
    {
        string path = _dir[name];
        using (var stream = new FileStream(path, FileMode.Create, FileAccess.Write))
            stream.SetLength(size); // allocated at once, nothing written: a 150 MB file in milliseconds
        return path;
    }

    [Fact]
    public void AFileOfMoreThan100MbIsSentWithItsSizeOnTheDisk()
    {
        const long size = 150L * 1024 * 1024;
        string path = LargeFile("bundle.msixupload", size);
        var (files, sizes) = BridgeSecurity.PrepareUploadFiles(new JsonArray(path));
        Assert.Single(files);
        Assert.Equal(size, (long)sizes[0]!);
        string sent = (string)files[0]!;
        Assert.True(Path.IsPathFullyQualified(sent));
        Assert.Equal(size, new FileInfo(sent).Length);
    }

    [Fact]
    public void ThePathIsTheOneWindowsReallyOpens()
    {
        // A junction stands in for the redirection: what Chrome gets is the real folder, never the detour.
        string real = Directory.CreateDirectory(_dir["real"]).FullName;
        File.WriteAllBytes(Path.Join(real, "a.bin"), new byte[1234]);
        string detour = _dir["detour"];
        using (var mklink = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("cmd.exe", ["/d", "/c", "mklink", "/J", detour, real])
               { CreateNoWindow = true, UseShellExecute = false, RedirectStandardOutput = true })!)
            mklink.WaitForExit();
        var (files, sizes) = BridgeSecurity.PrepareUploadFiles(new JsonArray(Path.Join(detour, "a.bin")));
        Assert.Equal(Path.Join(real, "a.bin"), (string)files[0]!, ignoreCase: true);
        Assert.Equal(1234L, (long)sizes[0]!);
    }

    [Fact]
    public void AMissingFileOrAFolderIsNotSentToThePage()
    {
        var missing = Assert.Throws<ArgumentException>(() => BridgeSecurity.PrepareUploadFiles(new JsonArray(_dir["absent.msixupload"])));
        Assert.Contains("does not exist", missing.Message, StringComparison.Ordinal);
        var folder = Assert.Throws<ArgumentException>(() => BridgeSecurity.PrepareUploadFiles(new JsonArray(_dir.Path)));
        Assert.Contains("is a folder", folder.Message, StringComparison.Ordinal);
        foreach (string message in new[] { missing.Message, folder.Message })
        {
            var outcome = (JsonObject)JsonNode.Parse(McpServer.WithOutcome(new JsonObject { ["status"] = "error", ["error"] = message }.ToJsonString(), idempotent: false))!;
            Assert.Equal("not_done", (string?)outcome["outcome"]);
        }
    }

    [Fact]
    public void ASecretsFolderIsStillRefused()
    {
        string ssh = Directory.CreateDirectory(Path.Join(BridgeSecurity.HomeDir(), ".ssh")).FullName;
        string key = Path.Join(ssh, "id_upload_test");
        File.WriteAllText(key, "x");
        try { Assert.Throws<UnauthorizedAccessException>(() => BridgeSecurity.PrepareUploadFiles(new JsonArray(key))); }
        finally { File.Delete(key); }
    }

    [Fact]
    public void AnEvalCutByItsTimeoutSaysTheScriptMayStillRun()
    {
        string answer = McpServer.EvalTimeoutNote(new JsonObject { ["status"] = "error", ["error"] = "Command 'eval' timed out after 20s." }.ToJsonString());
        Assert.Contains("Still running, do not resend", answer, StringComparison.Ordinal);
        var outcome = (JsonObject)JsonNode.Parse(McpServer.WithOutcome(answer, idempotent: false))!;
        Assert.Equal("unknown", (string?)outcome["outcome"]);
        Assert.Equal(answer, McpServer.EvalTimeoutNote(answer));
        string ok = new JsonObject { ["status"] = "success", ["data"] = 1 }.ToJsonString();
        Assert.Equal(ok, McpServer.EvalTimeoutNote(ok));
    }
}
