using System;
using System.Buffers.Binary;
using System.IO;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace NexusBrowser.Native;

public static class NativeAuthHost
{
    public const string HostName = "com.nexus.browser_auth";
    public const int MaxMessageBytes = 4096;

    private static readonly Regex OriginRegex = new(@"^chrome-extension://([a-p]{32})/?$", RegexOptions.Compiled);
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = false,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    public static string ReadToken(string path)
    {
        string token;
        try
        {
            token = File.ReadAllText(path, Encoding.ASCII).Trim();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            throw new AuthError($"jeton du pont illisible ({ex.Message}) : lancer install.ps1");
        }
        if (token.Length < 43)
            throw new AuthError("jeton du pont invalide");
        return token;
    }

    public static string? CallerExtensionId(string[] args)
    {
        foreach (var match in args.Select(raw => OriginRegex.Match(raw ?? "")))
        {
            if (match.Success)
                return match.Groups[1].Value;
        }
        return null;
    }

    public static JsonNode? ReadMessage(Stream stream)
    {
        Span<byte> lenBuf = stackalloc byte[4];
        int readTotal = 0;
        while (readTotal < 4)
        {
            int n = stream.Read(lenBuf[readTotal..]);
            if (n == 0)
                throw new AuthError("message natif incomplet");
            readTotal += n;
        }

        uint size = BinaryPrimitives.ReadUInt32LittleEndian(lenBuf);
        if (size > MaxMessageBytes)
            throw new AuthError("message natif trop long");

        byte[] payload = new byte[size];
        int offset = 0;
        while (offset < (int)size)
        {
            int n = stream.Read(payload, offset, (int)size - offset);
            if (n == 0)
                throw new AuthError("message natif incomplet");
            offset += n;
        }

        try
        {
            return JsonNode.Parse(Encoding.UTF8.GetString(payload));
        }
        catch (JsonException)
        {
            throw new AuthError("message natif illisible");
        }
    }

    public static void WriteMessage(Stream stream, JsonObject payload)
    {
        string json = payload.ToJsonString(JsonOptions);
        byte[] raw = Encoding.UTF8.GetBytes(json);
        Span<byte> lenBuf = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(lenBuf, (uint)raw.Length);
        stream.Write(lenBuf);
        stream.Write(raw, 0, raw.Length);
        stream.Flush();
    }

    public static JsonObject Answer(JsonNode? messageNode, string? callerId, string? tokenFile = null)
    {
        try
        {
            if (messageNode is not JsonObject message || TryGetString(message, "op") != "handshake")
                throw new AuthError("opération inconnue");

            string clientNonce = BridgeAuth.CheckNonce(TryGetString(message, "client_nonce"), "client_nonce");
            string serverNonce = BridgeAuth.CheckNonce(TryGetString(message, "server_nonce"), "server_nonce");
            string role = BridgeAuth.CheckRole(TryGetString(message, "role"));
            string extensionId = BridgeAuth.CheckExtensionId(TryGetString(message, "extension_id"));

            if (extensionId != callerId)
                throw new AuthError("identifiant d'extension différent de l'appelant annoncé par Chrome");

            string token = ReadToken(BridgeSecurity.TokenPath(tokenFile));
            string expected = BridgeAuth.ServerProof(token, clientNonce, serverNonce, role, extensionId);
            if (!BridgeAuth.Same(TryGetString(message, "server_proof"), expected))
                throw new AuthError("le serveur du port 9224 ne prouve pas qu'il connaît le jeton NexusBrowser : connexion refusée");

            return new JsonObject
            {
                ["ok"] = true,
                ["client_proof"] = BridgeAuth.ClientProof(token, clientNonce, serverNonce, role, extensionId),
                ["session_key"] = BridgeAuth.ToBase64Url(BridgeAuth.SessionKey(token, clientNonce, serverNonce, role, extensionId)),
            };
        }
        catch (AuthError error)
        {
            return Fail(error.Message);
        }
    }

    public static int Run(string[] args, Stream? stdin = null, Stream? stdout = null, string? tokenFile = null)
    {
        Stream input = stdin ?? Console.OpenStandardInput();
        Stream output = stdout ?? Console.OpenStandardOutput();
        JsonObject reply;
        try
        {
            var message = ReadMessage(input);
            reply = Answer(message, CallerExtensionId(args), tokenFile);
        }
        catch (AuthError error)
        {
            reply = Fail(error.Message);
        }
        catch (Exception ex) when (Boundary.Recoverable(ex))
        {
            // Deliberate boundary: Chrome always gets an answer, never a crashed host
            reply = Fail(ex.Message);
        }

        WriteMessage(output, reply);
        return 0;
    }

    private static string? TryGetString(JsonObject obj, string key)
    {
        if (obj[key] is JsonValue val && val.GetValueKind() == JsonValueKind.String && val.TryGetValue<string>(out var s))
            return s;
        return null;
    }

    private static JsonObject Fail(string error) => new()
    {
        ["ok"] = false,
        ["error"] = error,
    };
}
