using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace NexusBrowser.Native;

public sealed class PairingStore
{
    public const double OfferTtlSeconds = 300.0;
    public const int MaxAttempts = 5;
    public const string PairingRole = "pairing";

    private readonly string _path;
    private readonly Func<double> _clock;
    private readonly object _lock = new();
    private string? _offer;
    private double _expires;
    private int _attempts;

    public PairingStore(string? path = null, Func<double>? clock = null)
    {
        _path = path ?? PairedPath();
        _clock = clock ?? DefaultClock;
    }

    public string FilePath => _path;

    private static double DefaultClock() =>
        Stopwatch.GetTimestamp() / (double)Stopwatch.Frequency;

    public static string PairedPath(string? tokenFile = null)
    {
        var tp = BridgeSecurity.TokenPath(tokenFile);
        var dir = Path.GetDirectoryName(tp) ?? BridgeSecurity.DefaultDataDir();
        return Path.Combine(dir, "paired-extensions.json");
    }

    public static string PairedKey(string secret, string clientNonce, string serverNonce, string extensionId)
    {
        return BridgeAuth.ToBase64Url(
            BridgeAuth.Digest(Encoding.ASCII.GetBytes(secret), "paired", clientNonce, serverNonce, extensionId));
    }

    public JsonObject Offer()
    {
        lock (_lock)
        {
            _offer = BridgeAuth.ToBase64Url(RandomNumberGenerator.GetBytes(32));
            _expires = _clock() + OfferTtlSeconds;
            _attempts = 0;
            return new JsonObject
            {
                ["secret"] = _offer,
                ["expires_in_s"] = (int)OfferTtlSeconds,
                ["page"] = "pair.html",
                ["protocol"] = BridgeAuth.Protocol,
            };
        }
    }

    public string PendingSecret()
    {
        lock (_lock)
        {
            if (_offer is null)
                throw new AuthError("aucun appairage en attente : en demander un nouveau");
            if (_clock() >= _expires)
            {
                _offer = null;
                throw new AuthError("appairage expiré (5 minutes) : en demander un nouveau");
            }
            return _offer;
        }
    }

    public void Failed()
    {
        lock (_lock)
        {
            _attempts++;
            if (_attempts >= MaxAttempts)
                _offer = null;
        }
    }

    public string Complete(string clientNonce, string serverNonce, string extensionId)
    {
        lock (_lock)
        {
            string secret = PendingSecret();
            string key = PairedKey(secret, clientNonce, serverNonce, extensionId);
            _offer = null;
            var keys = ReadLocked();
            keys[extensionId] = key;
            WriteLocked(keys);
            return key;
        }
    }

    public string KeyFor(string extensionId)
    {
        lock (_lock)
        {
            string checkedId = BridgeAuth.CheckExtensionId(extensionId);
            var keys = ReadLocked();
            if (!keys.TryGetValue(checkedId, out var key) || string.IsNullOrEmpty(key) || key.Length != 43)
                throw new AuthError("extension non appairée à ce pont : l'appairer depuis l'application NexusBrowser");
            return key;
        }
    }

    public int Revoke(string? extensionId = null)
    {
        lock (_lock)
        {
            var keys = ReadLocked();
            if (extensionId is null)
            {
                int count = keys.Count;
                WriteLocked(new Dictionary<string, string>(StringComparer.Ordinal));
                return count;
            }
            bool removed = keys.Remove(extensionId);
            WriteLocked(keys);
            return removed ? 1 : 0;
        }
    }

    private Dictionary<string, string> ReadLocked()
    {
        if (!File.Exists(_path))
            return new Dictionary<string, string>(StringComparer.Ordinal);
        try
        {
            var raw = File.ReadAllText(_path, Encoding.UTF8);
            var node = JsonNode.Parse(raw);
            if (node is not JsonObject obj)
                return new Dictionary<string, string>(StringComparer.Ordinal);
            var dict = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var kv in obj)
            {
                if (kv.Value is JsonValue v && v.TryGetValue<string>(out var s) && s != null)
                    dict[kv.Key] = s;
            }
            return dict;
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            throw new AuthError("fichier des extensions appairées illisible");
        }
    }

    private void WriteLocked(Dictionary<string, string> keys)
    {
        var dir = Path.GetDirectoryName(_path);
        if (!string.IsNullOrEmpty(dir))
            Directory.CreateDirectory(dir);
        var randHex = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8));
        var tmp = Path.Combine(dir ?? ".", $".{Path.GetFileName(_path)}-{randHex}.tmp");
        try
        {
            var obj = new JsonObject();
            foreach (var kv in keys)
                obj[kv.Key] = kv.Value;
            var json = obj.ToJsonString(new JsonSerializerOptions { WriteIndented = true }).Replace("\r\n", "\n");
            File.WriteAllText(tmp, json, new UTF8Encoding(false));
            BridgeSecurity.HardenTokenPermissions(tmp);
            File.Move(tmp, _path, overwrite: true);
        }
        finally
        {
            try
            {
                if (File.Exists(tmp))
                    File.Delete(tmp);
            }
            catch
            {
                // Ignore cleanup failure
            }
        }
    }
}
