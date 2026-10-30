using System.Buffers.Binary;
using System.Text;
using System.Text.Json.Nodes;
using NexusBrowser.Native;
using Xunit;

namespace NexusBrowser.Tests;

/// <summary>nexus-browser/1 primitives, the signed channel and the pairing store (former --selftest, suite 1).</summary>
public sealed class BridgeAuthTests : IDisposable
{
    private const string ExtensionId = FakeExtension.Id;
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    [Fact]
    public void CreatedTokenIsLongAndStable()
    {
        string tokenFile = _dir["bridge-token"];
        string token = BridgeSecurity.LoadOrCreateToken(tokenFile);
        Assert.True(token.Length >= 43, $"token length {token.Length}");
        Assert.Equal(token, BridgeSecurity.LoadOrCreateToken(tokenFile));
        Assert.Equal(token, BridgeSecurity.ReadToken(tokenFile));
    }

    [Fact]
    public void NonceRoleAndExtensionIdAreValidated()
    {
        string nonce = BridgeAuth.NewNonce();
        Assert.Equal(43, nonce.Length);
        Assert.Equal(nonce, BridgeAuth.CheckNonce(nonce, "c"));
        Assert.Equal(ExtensionId, BridgeAuth.CheckExtensionId(ExtensionId));
        Assert.Equal("service_worker", BridgeAuth.CheckRole("service_worker"));
        Assert.Equal("offscreen", BridgeAuth.CheckRole("offscreen"));
        Assert.Throws<AuthError>(() => BridgeAuth.CheckNonce(nonce[..42], "c"));
        Assert.Throws<AuthError>(() => BridgeAuth.CheckNonce(nonce[..42] + "=", "c"));
        Assert.Throws<AuthError>(() => BridgeAuth.CheckRole("popup"));
        Assert.Throws<AuthError>(() => BridgeAuth.CheckExtensionId("blcgddmjdkobmgakjffjpgiicjlflgjz"));
    }

    [Fact]
    public void ServerAndClientProofsDiffer()
    {
        string token = BridgeAuth.NewNonce();
        string c = BridgeAuth.NewNonce(), s = BridgeAuth.NewNonce();
        Assert.NotEqual(BridgeAuth.ServerProof(token, c, s, "service_worker", ExtensionId), BridgeAuth.ClientProof(token, c, s, "service_worker", ExtensionId));
        // Every input is bound into the proof.
        Assert.NotEqual(BridgeAuth.ServerProof(token, c, s, "service_worker", ExtensionId), BridgeAuth.ServerProof(token, c, s, "offscreen", ExtensionId));
    }

    private static (BridgeAuth.Channel ServerToClient, BridgeAuth.Channel ClientSide) Channels()
    {
        byte[] key = BridgeAuth.SessionKey(BridgeAuth.NewNonce(), BridgeAuth.NewNonce(), BridgeAuth.NewNonce(), "service_worker", ExtensionId);
        return (new BridgeAuth.Channel(key, "s2c", "c2s"), new BridgeAuth.Channel(key, "c2s", "s2c"));
    }

    [Fact]
    public void ChannelOpensWhatWasSealed()
    {
        var (s2c, c2s) = Channels();
        Assert.Equal("{\"type\":\"auth_ok\"}", c2s.Open(s2c.Seal("{\"type\":\"auth_ok\"}")));
        Assert.Equal("second", c2s.Open(s2c.Seal("second")));
    }

    [Fact]
    public void ReplayedSequenceNumberIsRefused()
    {
        var (s2c, c2s) = Channels();
        var frame = s2c.Seal("{\"type\":\"auth_ok\"}");
        c2s.Open(frame);
        Assert.Throws<AuthError>(() => c2s.Open(frame));
    }

    [Fact]
    public void TamperedBodyIsRefused()
    {
        var (s2c, c2s) = Channels();
        var frame = s2c.Seal("{\"action\":\"ping\"}");
        frame["body"] = "{\"action\":\"eval\"}";
        Assert.Throws<AuthError>(() => c2s.Open(frame));
    }

    [Fact]
    public void FrameFromTheWrongDirectionIsRefused()
    {
        // A frame the server sealed (s2c) cannot be reflected back to it as client traffic (c2s).
        var (server, _) = Channels();
        Assert.Throws<AuthError>(() => server.Open(server.Seal("x")));
        Assert.Throws<AuthError>(() => server.Open(new JsonObject { ["seq"] = 1, ["body"] = "x" }));
    }

    [Fact]
    public void PairingStoreLifecycle()
    {
        string c = BridgeAuth.NewNonce(), s = BridgeAuth.NewNonce();
        var store = new PairingStore(_dir["paired-extensions.json"]);
        var offer = store.Offer();
        string secret = (string)offer["secret"]!;
        Assert.Equal(43, secret.Length);
        Assert.Equal(secret, store.PendingSecret());
        string derived = store.Complete(c, s, ExtensionId);
        Assert.Equal(PairingStore.PairedKey(secret, c, s, ExtensionId), derived);
        Assert.Equal(derived, store.KeyFor(ExtensionId));
        // The paired key survives a reload from disk.
        Assert.Equal(derived, new PairingStore(_dir["paired-extensions.json"]).KeyFor(ExtensionId));
        Assert.Equal(1, store.Revoke(ExtensionId));
    }
}

/// <summary>Native messaging auth host (--auth-host), C# against C# over streams (former --selftest suite 2 and the
/// Python interop test, now that bridge_auth.py is gone).</summary>
public sealed class NativeAuthHostTests : IDisposable
{
    private const string ExtensionId = FakeExtension.Id;
    private readonly TempDir _dir = new();
    private readonly string _tokenFile;
    private readonly string _token;

    public NativeAuthHostTests()
    {
        _tokenFile = _dir["bridge-token"];
        _token = BridgeSecurity.LoadOrCreateToken(_tokenFile);
    }

    public void Dispose() => _dir.Dispose();

    private JsonObject Handshake(string clientNonce, string serverNonce, string role = "service_worker", string? serverProof = null) => new()
    {
        ["op"] = "handshake",
        ["client_nonce"] = clientNonce,
        ["server_nonce"] = serverNonce,
        ["role"] = role,
        ["extension_id"] = ExtensionId,
        ["server_proof"] = serverProof ?? BridgeAuth.ServerProof(_token, clientNonce, serverNonce, role, ExtensionId),
    };

    private JsonObject Run(JsonObject request, string caller = $"chrome-extension://{ExtensionId}/")
    {
        using var input = new MemoryStream();
        NativeAuthHost.WriteMessage(input, request);
        input.Position = 0;
        using var output = new MemoryStream();
        Assert.Equal(0, NativeAuthHost.Run([caller], input, output, _tokenFile));
        output.Position = 0;
        var reply = (JsonObject)NativeAuthHost.ReadMessage(output)!;
        Assert.Equal(output.Length, output.Position); // exactly one framed message
        return reply;
    }

    [Theory]
    [InlineData("service_worker")]
    [InlineData("offscreen")]
    public void HandshakeAnswersTheClientProofAndSessionKey(string role)
    {
        string c = BridgeAuth.NewNonce(), s = BridgeAuth.NewNonce();
        var reply = Run(Handshake(c, s, role));
        var expected = new JsonObject
        {
            ["ok"] = true,
            ["client_proof"] = BridgeAuth.ClientProof(_token, c, s, role, ExtensionId),
            ["session_key"] = BridgeAuth.ToBase64Url(BridgeAuth.SessionKey(_token, c, s, role, ExtensionId)),
        };
        Assert.True(JsonNode.DeepEquals(expected, reply), reply.ToJsonString());
    }

    [Fact]
    public void BadServerProofIsRefusedWithoutLeakingTheClientProof()
    {
        var reply = Run(Handshake(BridgeAuth.NewNonce(), BridgeAuth.NewNonce(), serverProof: BridgeAuth.NewNonce()));
        Assert.False((bool)reply["ok"]!);
        Assert.False(reply.ContainsKey("client_proof"));
        Assert.False(reply.ContainsKey("session_key"));
        Assert.Contains("9224", (string)reply["error"]!);
    }

    [Fact]
    public void ExtensionIdMustBeTheCallerAnnouncedByChrome()
    {
        var reply = Run(Handshake(BridgeAuth.NewNonce(), BridgeAuth.NewNonce()), caller: "chrome-extension://fjapmaccbgdfneoccclmlpgknbbfkaco/");
        Assert.False((bool)reply["ok"]!);
        Assert.False(reply.ContainsKey("client_proof"));
    }

    [Fact]
    public void UnknownOperationIsRefused()
    {
        var reply = Run(new JsonObject { ["op"] = "unsupported" });
        Assert.True(JsonNode.DeepEquals(new JsonObject { ["ok"] = false, ["error"] = "opération inconnue" }, reply), reply.ToJsonString());
    }

    [Fact]
    public void OversizedFrameIsRefused()
    {
        using var input = new MemoryStream();
        var length = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(length, NativeAuthHost.MaxMessageBytes + 1);
        input.Write(length);
        input.Position = 0;
        using var output = new MemoryStream();
        Assert.Equal(0, NativeAuthHost.Run([$"chrome-extension://{ExtensionId}/"], input, output, _tokenFile));
        output.Position = 0;
        var reply = (JsonObject)NativeAuthHost.ReadMessage(output)!;
        Assert.False((bool)reply["ok"]!);
    }

    [Fact]
    public async Task AuthHostProcessAnswersOverItsStandardStreams()
    {
        string c = BridgeAuth.NewNonce(), s = BridgeAuth.NewNonce();
        byte[] raw = Encoding.UTF8.GetBytes(Handshake(c, s).ToJsonString());
        var framed = new byte[4 + raw.Length];
        BinaryPrimitives.WriteUInt32LittleEndian(framed, (uint)raw.Length);
        raw.CopyTo(framed, 4);

        var info = new System.Diagnostics.ProcessStartInfo(NativeExe.Path)
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
        };
        foreach (string arg in new[] { "--auth-host", "--token-file", _tokenFile, $"chrome-extension://{ExtensionId}/" })
            info.ArgumentList.Add(arg);
        using var process = System.Diagnostics.Process.Start(info)!;
        try
        {
            await process.StandardInput.BaseStream.WriteAsync(framed, TestContext.Current.CancellationToken);
            process.StandardInput.Close();
            using var output = new MemoryStream();
            await process.StandardOutput.BaseStream.CopyToAsync(output, TestContext.Current.CancellationToken);
            await process.WaitForExitAsync(TestContext.Current.CancellationToken);
            Assert.Equal(0, process.ExitCode);
            byte[] bytes = output.ToArray();
            int length = (int)BinaryPrimitives.ReadUInt32LittleEndian(bytes);
            Assert.Equal(length + 4, bytes.Length);
            var reply = JsonNode.Parse(Encoding.UTF8.GetString(bytes, 4, length));
            var expected = new JsonObject
            {
                ["ok"] = true,
                ["client_proof"] = BridgeAuth.ClientProof(_token, c, s, "service_worker", ExtensionId),
                ["session_key"] = BridgeAuth.ToBase64Url(BridgeAuth.SessionKey(_token, c, s, "service_worker", ExtensionId)),
            };
            Assert.True(JsonNode.DeepEquals(expected, reply), reply?.ToJsonString());
        }
        finally
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
    }
}
