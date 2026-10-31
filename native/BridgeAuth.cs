using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace NexusBrowser.Native;

public sealed class AuthError : Exception
{
    public AuthError(string message) : base(message) { }
}

public static class BridgeAuth
{
    public const string Protocol = "nexus-browser/1";
    public const int NonceBytes = 32;

    private static readonly Regex Base64UrlRegex = new(@"^[A-Za-z0-9_-]+$", RegexOptions.Compiled);
    private static readonly Regex ExtensionIdRegex = new(@"^[a-p]{32}$", RegexOptions.Compiled);

    public static string ToBase64Url(ReadOnlySpan<byte> data)
    {
        return Convert.ToBase64String(data)
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');
    }

    public static string NewNonce()
    {
        Span<byte> bytes = stackalloc byte[NonceBytes];
        RandomNumberGenerator.Fill(bytes);
        return ToBase64Url(bytes);
    }

    public static string CheckNonce(string? value, string name)
    {
        if (string.IsNullOrEmpty(value) || value.Length != 43 || !Base64UrlRegex.IsMatch(value))
            throw new AuthError($"{name} invalide");
        return value;
    }

    public static string CheckRole(string? value)
    {
        if (value is not ("service_worker" or "offscreen"))
            throw new AuthError("rôle inconnu");
        return value;
    }

    public static string CheckExtensionId(string? value)
    {
        if (string.IsNullOrEmpty(value) || !ExtensionIdRegex.IsMatch(value))
            throw new AuthError("identifiant d'extension invalide");
        return value;
    }

    public static byte[] Digest(byte[] key, params string[] parts)
    {
        var all = new string[parts.Length + 1];
        all[0] = Protocol;
        Array.Copy(parts, 0, all, 1, parts.Length);
        byte[] payload = Encoding.UTF8.GetBytes(string.Join("\n", all));
        return HMACSHA256.HashData(key, payload);
    }

    private static byte[] KeyBytes(string token) => Encoding.ASCII.GetBytes(token);

    public static string ServerProof(string token, string clientNonce, string serverNonce, string role, string extensionId)
    {
        return ToBase64Url(Digest(KeyBytes(token), "server", clientNonce, serverNonce, role, extensionId));
    }

    public static string ClientProof(string token, string clientNonce, string serverNonce, string role, string extensionId)
    {
        return ToBase64Url(Digest(KeyBytes(token), "client", clientNonce, serverNonce, role, extensionId));
    }

    public static byte[] SessionKey(string token, string clientNonce, string serverNonce, string role, string extensionId)
    {
        return Digest(KeyBytes(token), "session", clientNonce, serverNonce, role, extensionId);
    }

    public static string FrameMac(byte[] key, string direction, long seq, string body)
    {
        return ToBase64Url(Digest(key, direction, seq.ToString(), body));
    }

    public static bool Same(string? a, string b)
    {
        if (a is null)
            return false;
        byte[] bytesA = Encoding.ASCII.GetBytes(a);
        byte[] bytesB = Encoding.ASCII.GetBytes(b);
        return CryptographicOperations.FixedTimeEquals(bytesA, bytesB);
    }

    public sealed class Channel
    {
        private readonly byte[] _key;
        private readonly string _sendDirection;
        private readonly string _receiveDirection;
        private long _sent;
        private long _received;
        private readonly object _sendLock = new();
        private readonly object _recvLock = new();

        public Channel(byte[] key, string sendDirection, string receiveDirection)
        {
            _key = key ?? throw new ArgumentNullException(nameof(key));
            _sendDirection = sendDirection;
            _receiveDirection = receiveDirection;
        }

        public JsonObject Seal(string body)
        {
            lock (_sendLock)
            {
                _sent++;
                return new JsonObject
                {
                    ["seq"] = _sent,
                    ["body"] = body,
                    ["mac"] = FrameMac(_key, _sendDirection, _sent, body),
                };
            }
        }

        public string Open(JsonNode? frameNode)
        {
            if (frameNode is not JsonObject frame ||
                frame.Count != 3 ||
                !frame.TryGetPropertyValue("seq", out JsonNode? seqNode) ||
                !frame.TryGetPropertyValue("body", out JsonNode? bodyNode) ||
                !frame.TryGetPropertyValue("mac", out JsonNode? macNode))
            {
                throw new AuthError("message non signé");
            }

            if (seqNode is not JsonValue seqVal ||
                seqVal.GetValueKind() != JsonValueKind.Number ||
                !seqVal.TryGetValue<long>(out long seq) ||
                bodyNode is not JsonValue bodyVal ||
                bodyVal.GetValueKind() != JsonValueKind.String ||
                !bodyVal.TryGetValue<string>(out string? body) ||
                body is null)
            {
                throw new AuthError("message signé mal formé");
            }

            string? mac = macNode is JsonValue macVal && macVal.GetValueKind() == JsonValueKind.String
                ? macVal.GetValue<string>()
                : null;

            lock (_recvLock)
            {
                if (seq != _received + 1)
                    throw new AuthError($"numéro d'ordre {seq} inattendu (attendu {_received + 1}) : rejeu ou perte");

                string expectedMac = FrameMac(_key, _receiveDirection, seq, body);
                if (!Same(mac, expectedMac))
                    throw new AuthError("signature du message fausse");

                _received = seq;
                return body;
            }
        }
    }
}
