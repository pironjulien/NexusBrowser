using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace NexusBrowser.Native;

public sealed class CommandCancelledException : Exception
{
    public CommandCancelledException(string message) : base(message) { }
}

public sealed class BridgeServer : IAsyncDisposable
{
    public const int DefaultPort = 9224;
    public const int MaxHeaderBytes = 64 * 1024;
    public const int MaxRequestBytes = 16 * 1024 * 1024;
    public const int MaxHandshakeBytes = 2048;
    public const double HttpReadTimeoutSeconds = 10.0;
    public const double HandshakeTimeoutSeconds = 10.0;
    public const double StopPollSeconds = 0.2;
    public const int MaxKnownSessions = 256;

    private static readonly string[] DefaultAllowedOrigins =
    [
        "chrome-extension://dbeaibllngdhojonbbnpdebdjfdfngmf",
        "chrome-extension://blcgddmjdkobmgakjffjpgiicjlflgjf",
        "chrome-extension://fjapmaccbgdfneoccclmlpgknbbfkaco",
        "chrome-extension://bfajgfgbnfljjebgdcndkgoacdkmlgpo",
    ];

    private static readonly HashSet<string> ReservedActions = new(StringComparer.Ordinal)
    {
        "emergency_stop",
    };

    private static readonly HashSet<string> AnonymousActions = new(StringComparer.Ordinal)
    {
        "ping",
    };

    private static readonly Regex Uuid36Regex = new(@"^[0-9a-f-]{36}$", RegexOptions.Compiled);
    private static readonly Regex RaisonRegex = new(@"^(?:deconnecte|reseau|http-\d{3})$", RegexOptions.Compiled);
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = false,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private readonly string _tokenFile;
    private readonly string? _logFile;
    private readonly PairingStore _pairing;
    private readonly EmergencyStop _emergencyStop;
    private readonly HashSet<string> _allowedOrigins = new(StringComparer.Ordinal);
    private readonly object _stateLock = new();
    private readonly List<BridgeClientConnection> _activeConnections = new();
    private readonly Dictionary<string, PendingCommand> _pendingRequests = new(StringComparer.Ordinal);
    private readonly List<((string Agent, string Id) Key, long? Pid)> _clientProcesses = new();

    private Socket? _wsListener;
    private Socket? _httpListener;
    private CancellationTokenSource? _cts;
    private Task? _wsAcceptTask;
    private Task? _httpAcceptTask;
    private Task? _stopWatchTask;
    private int _authOrder;
    private double _stopSeenUntil;
    private readonly SemaphoreSlim _updateLock = new(1, 1);
    private readonly string _instanceId = Guid.NewGuid().ToString("N");
    private readonly TaskCompletionSource _shutdown = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private bool _draining;
    private int _httpCommands;

    internal Task ShutdownRequested => _shutdown.Task;

    public int WsPort { get; private set; }
    public int HttpPort { get; private set; }
    public PairingStore Pairing => _pairing;

    public sealed class BridgeClientConnection
    {
        public WebSocket WebSocket { get; }
        public string Role { get; }
        public string ExtensionId { get; }
        public int Order { get; }
        public BridgeAuth.Channel Channel { get; }
        private readonly SemaphoreSlim _sendLock = new(1, 1);

        public BridgeClientConnection(WebSocket webSocket, string role, string extensionId, byte[] sessionKey, int order)
        {
            WebSocket = webSocket;
            Role = role;
            ExtensionId = extensionId;
            Order = order;
            Channel = new BridgeAuth.Channel(sessionKey, "s2c", "c2s");
        }

        public async Task SendAsync(JsonObject payload, CancellationToken ct = default)
        {
            await _sendLock.WaitAsync(ct);
            try
            {
                string inner = payload.ToJsonString(JsonOptions);
                JsonObject frame = Channel.Seal(inner);
                byte[] bytes = Encoding.UTF8.GetBytes(frame.ToJsonString(JsonOptions));
                await WebSocket.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, ct);
            }
            finally
            {
                _sendLock.Release();
            }
        }

        public JsonObject Describe() => new()
        {
            ["role"] = Role,
            ["extension_id"] = ExtensionId,
            ["order"] = Order,
        };
    }

    private sealed record PendingCommand(
        BridgeClientConnection Owner,
        TaskCompletionSource<JsonObject> Future,
        string Action);

    public BridgeServer(
        int port = DefaultPort,
        int? httpPort = null,
        string? tokenFile = null,
        string? logFile = null,
        IEnumerable<string>? allowedOrigins = null)
    {
        WsPort = port;
        HttpPort = httpPort ?? (port == 0 ? 0 : port + 1);
        _tokenFile = BridgeSecurity.TokenPath(tokenFile);
        _logFile = logFile;
        _pairing = new PairingStore(PairingStore.PairedPath(_tokenFile));
        _emergencyStop = new EmergencyStop();

        var origins = allowedOrigins?.ToList() ?? LoadConfiguredOrigins();
        foreach (var origin in origins)
        {
            var trimmed = origin.Trim().TrimEnd('/');
            if (trimmed.StartsWith("chrome-extension://", StringComparison.Ordinal) && !trimmed.Contains('*'))
            {
                _allowedOrigins.Add(trimmed);
                _allowedOrigins.Add(trimmed + "/");
            }
        }
    }

    private static List<string> LoadConfiguredOrigins()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("bridge_config.json")
            ?? throw new InvalidOperationException("Embedded bridge_config.json missing");
        var configuration = JsonNode.Parse(stream) as JsonObject;
        var list = (configuration?["allowed_origins"] as JsonArray ?? [])
            .Select(v => v?.GetValue<string>() ?? "").Where(s => s.Length > 0).ToList();
        if (list.Count == 0) throw new InvalidOperationException("No explicit Chrome extension origin configured");
        var env = Environment.GetEnvironmentVariable("NEXUS_BROWSER_ALLOWED_ORIGINS");
        if (!string.IsNullOrWhiteSpace(env))
        {
            foreach (var part in env.Split([',', ';', ' '], StringSplitOptions.RemoveEmptyEntries))
                list.Add(part.Trim());
        }
        return list;
    }

    private void Log(string level, string message)
    {
        if (string.IsNullOrEmpty(_logFile))
            return;
        try
        {
            var dir = Path.GetDirectoryName(_logFile);
            if (!string.IsNullOrEmpty(dir))
                Directory.CreateDirectory(dir);
            string line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss,fff} {level} {message}\n";
            File.AppendAllText(_logFile, line, new UTF8Encoding(false));
        }
        catch
        {
            // Ignore logging error
        }
    }

    private string ReadBridgeToken()
    {
        if (!File.Exists(_tokenFile))
            BridgeSecurity.LoadOrCreateToken(_tokenFile);
        return BridgeSecurity.ReadToken(_tokenFile);
    }

    private static Socket CreateExclusiveListener(int port)
    {
        var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
        try
        {
            socket.ExclusiveAddressUse = true;
            socket.Bind(new IPEndPoint(IPAddress.Loopback, port));
            socket.Listen(128);
            return socket;
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    public void Start()
    {
        string token = ReadBridgeToken();
        BridgeSecurity.HardenTokenPermissions(_tokenFile);

        _wsListener = CreateExclusiveListener(WsPort);
        WsPort = ((IPEndPoint)_wsListener.LocalEndPoint!).Port;

        _httpListener = CreateExclusiveListener(HttpPort);
        HttpPort = ((IPEndPoint)_httpListener.LocalEndPoint!).Port;

        _cts = new CancellationTokenSource();
        var ct = _cts.Token;

        string fp = Convert.ToHexStringLower(SHA256.HashData(Encoding.ASCII.GetBytes(token)))[..12];
        Log("INFO", $"starting version={BridgeSecurity.Version} pid={Environment.ProcessId} token_path={_tokenFile} token_fingerprint={fp}");

        _wsAcceptTask = Task.Run(() => AcceptLoopAsync(_wsListener, HandleWsSocketAsync, ct), ct);
        _httpAcceptTask = Task.Run(() => AcceptLoopAsync(_httpListener, HandleHttpSocketAsync, ct), ct);
        _stopWatchTask = Task.Run(() => WatchEmergencyStopAsync(ct), ct);
        if (WsPort == DefaultPort && _tokenFile == BridgeSecurity.TokenPath())
            _ = Task.Run(() => CheckUpdateAsync(ct), ct);
    }

    public async Task RunForeverAsync(CancellationToken ct = default)
    {
        Start();
        Console.WriteLine("==================================================");
        Console.WriteLine($"  Nexus Browser Bridge Server (v{BridgeSecurity.Version})");
        Console.WriteLine($"  WebSocket: ws://127.0.0.1:{WsPort}");
        Console.WriteLine($"  HTTP REST: http://127.0.0.1:{HttpPort}/api/command");
        Console.WriteLine("==================================================");
        Console.WriteLine($"  HTTP API available at http://127.0.0.1:{HttpPort}/api/command");

        try
        {
            await Task.WhenAny(Task.Delay(Timeout.Infinite, ct), _shutdown.Task);
        }
        catch (OperationCanceledException)
        {
            // Normal shutdown
        }
        finally
        {
            await DisposeAsync();
        }
    }

    public async ValueTask DisposeAsync()
    {
        try { _cts?.Cancel(); } catch { }
        try { _wsListener?.Dispose(); } catch { }
        try { _httpListener?.Dispose(); } catch { }

        List<BridgeClientConnection> clients;
        lock (_stateLock)
        {
            clients = _activeConnections.ToList();
            _activeConnections.Clear();
        }
        foreach (var c in clients)
        {
            try { c.WebSocket.Dispose(); } catch { }
        }

        if (_wsAcceptTask != null) { try { await _wsAcceptTask; } catch { } }
        if (_httpAcceptTask != null) { try { await _httpAcceptTask; } catch { } }
        if (_stopWatchTask != null) { try { await _stopWatchTask; } catch { } }
        _cts?.Dispose();
    }

    private static async Task AcceptLoopAsync(Socket listener, Func<Socket, CancellationToken, Task> handler, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            Socket client;
            try
            {
                client = await listener.AcceptAsync(ct);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (ObjectDisposedException)
            {
                break;
            }
            catch (SocketException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch
            {
                continue;
            }

            _ = Task.Run(async () =>
            {
                try
                {
                    await handler(client, ct);
                }
                catch
                {
                    try { client.Dispose(); } catch { }
                }
            }, ct);
        }
    }

    private BridgeClientConnection? SelectTarget()
    {
        lock (_stateLock)
        {
            if (_activeConnections.Count == 0)
                return null;
            return _activeConnections
                .OrderBy(c => c.Role == "service_worker" ? 0 : c.Role == "offscreen" ? 1 : 99)
                .ThenByDescending(c => c.Order)
                .FirstOrDefault();
        }
    }

    // -------------------------------------------------------------------------
    // WebSocket Upgrade & Protocol Handler
    // -------------------------------------------------------------------------

    private async Task HandleWsSocketAsync(Socket socket, CancellationToken ct)
    {
        using var ownedSocket = socket;
        using var stream = new NetworkStream(socket, ownsSocket: false);

        var headerResult = await ReadHttpHeadersAsync(stream, ct);
        if (headerResult is null)
            return;

        var (_, _, headers, _) = headerResult.Value;
        if (!headers.TryGetValue("sec-websocket-key", out var wsKey) || string.IsNullOrWhiteSpace(wsKey))
            return;

        string acceptKey = Convert.ToBase64String(
            SHA1.HashData(Encoding.ASCII.GetBytes(wsKey.Trim() + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));

        string upgradeResponse =
            "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            $"Sec-WebSocket-Accept: {acceptKey}\r\n\r\n";
        byte[] upgradeBytes = Encoding.ASCII.GetBytes(upgradeResponse);
        await stream.WriteAsync(upgradeBytes, ct);
        await stream.FlushAsync(ct);

        using var ws = WebSocket.CreateFromStream(stream, new WebSocketCreationOptions
        {
            IsServer = true,
            KeepAliveInterval = TimeSpan.FromSeconds(20),
        });

        headers.TryGetValue("origin", out var origin);
        if (string.IsNullOrEmpty(origin) || !_allowedOrigins.Contains(origin))
        {
            Log("WARNING", $"WebSocket connection rejected: origin '{origin}' not allowed");
            await SafeCloseWebSocketAsync(ws, (WebSocketCloseStatus)1008, "Extension origin not allowed");
            return;
        }

        BridgeClientConnection? client;
        try
        {
            client = await AuthenticateWebSocketAsync(ws, origin, ct);
        }
        catch (Exception ex) when (ex is AuthError or TimeoutException or OperationCanceledException)
        {
            Log("WARNING", $"WebSocket authentication rejected: {ex.Message}");
            await SafeCloseWebSocketAsync(ws, (WebSocketCloseStatus)1008, "Authentication failed");
            return;
        }
        catch (Exception ex)
        {
            Log("INFO", $"WebSocket connection ended during authentication: {ex.Message}");
            return;
        }

        if (client is null)
        {
            await SafeCloseWebSocketAsync(ws, WebSocketCloseStatus.NormalClosure, "");
            return;
        }

        bool draining;
        lock (_stateLock)
        {
            draining = _draining;
            if (!draining) _activeConnections.Add(client);
        }
        if (draining)
        {
            await SafeCloseWebSocketAsync(ws, WebSocketCloseStatus.EndpointUnavailable, "Bridge update in progress; reconnect shortly");
            return;
        }
        Log("INFO", $"Chrome Extension authenticated: role={client.Role} extension={client.ExtensionId}");

        double left = _emergencyStop.RemainingSeconds();
        if (left > 0)
        {
            _ = NotifyExtensionStopAsync(left, client);
        }

        try
        {
            while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                string? rawMessage = await ReceiveWebSocketTextAsync(ws, MaxRequestBytes, ct);
                if (rawMessage is null)
                    break;

                JsonObject? data;
                try
                {
                    var outerNode = JsonNode.Parse(rawMessage);
                    string innerJson = client.Channel.Open(outerNode);
                    data = JsonNode.Parse(innerJson) as JsonObject;
                }
                catch (Exception ex) when (ex is AuthError or JsonException)
                {
                    Log("WARNING", $"Unauthenticated WebSocket message, connection closed: {ex.Message}");
                    await SafeCloseWebSocketAsync(ws, (WebSocketCloseStatus)1008, "Invalid signed message");
                    break;
                }

                if (data is null)
                    continue;

                if (TryGetString(data, "requestId") is { } reqId)
                {
                    PendingCommand? matched = null;
                    lock (_stateLock)
                    {
                        if (_pendingRequests.TryGetValue(reqId, out var pending) && ReferenceEquals(pending.Owner, client))
                        {
                            _pendingRequests.Remove(reqId);
                            matched = pending;
                        }
                    }
                    matched?.Future.TrySetResult(data);
                }
                else if (TryGetString(data, "event") == "compteurs")
                {
                    EcrireCompteurs(data);
                }
            }
        }
        catch (Exception ex)
        {
            Log("INFO", $"WebSocket connection ended: {ex.Message}");
        }
        finally
        {
            List<PendingCommand> orphaned = new();
            lock (_stateLock)
            {
                _activeConnections.Remove(client);
                Log("INFO", $"Chrome Extension disconnected: role={client.Role} extension={client.ExtensionId}. Active clients: {_activeConnections.Count}");
                foreach (var kv in _pendingRequests.Where(kv => ReferenceEquals(kv.Value.Owner, client)).ToList())
                {
                    _pendingRequests.Remove(kv.Key);
                    orphaned.Add(kv.Value);
                }
            }
            foreach (var p in orphaned)
            {
                p.Future.TrySetException(new IOException("Chrome Extension disconnected while processing request"));
            }
        }
    }

    private async Task<BridgeClientConnection?> AuthenticateWebSocketAsync(WebSocket ws, string? origin, CancellationToken ct)
    {
        async Task<JsonObject> ReceiveHandshakeAsync()
        {
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeoutCts.CancelAfter(TimeSpan.FromSeconds(HandshakeTimeoutSeconds));
            string? raw = await ReceiveWebSocketTextAsync(ws, MaxHandshakeBytes, timeoutCts.Token);
            if (string.IsNullOrEmpty(raw) || raw.Length > MaxHandshakeBytes)
                throw new AuthError("message de poignée de main invalide");
            JsonNode? node;
            try
            {
                node = JsonNode.Parse(raw);
            }
            catch
            {
                throw new AuthError("message de poignée de main illisible");
            }
            if (node is not JsonObject obj)
                throw new AuthError("message de poignée de main invalide");
            return obj;
        }

        var hello = await ReceiveHandshakeAsync();
        if (TryGetString(hello, "type") != "auth_hello" || TryGetString(hello, "protocol") != BridgeAuth.Protocol)
            throw new AuthError("poignée de main attendue");

        string clientNonce = BridgeAuth.CheckNonce(TryGetString(hello, "client_nonce"), "client_nonce");
        string extensionId = BridgeAuth.CheckExtensionId(TryGetString(hello, "extension_id"));
        string auth = TryGetString(hello, "auth") ?? "native";
        string role;
        string token;

        if (auth == "native")
        {
            role = BridgeAuth.CheckRole(TryGetString(hello, "role"));
            token = ReadBridgeToken();
        }
        else if (auth is "paired" or "pair")
        {
            if (origin is null || origin.TrimEnd('/') != $"chrome-extension://{extensionId}")
                throw new AuthError("identifiant d'extension différent de l'origine de la connexion");

            if (auth == "paired")
            {
                role = BridgeAuth.CheckRole(TryGetString(hello, "role"));
                token = _pairing.KeyFor(extensionId);
            }
            else
            {
                if (TryGetString(hello, "role") != PairingStore.PairingRole)
                    throw new AuthError("rôle d'appairage attendu");
                role = PairingStore.PairingRole;
                token = _pairing.PendingSecret();
            }
        }
        else
        {
            throw new AuthError("méthode d'authentification inconnue");
        }

        string serverNonce = BridgeAuth.NewNonce();
        var challenge = new JsonObject
        {
            ["type"] = "auth_challenge",
            ["server_nonce"] = serverNonce,
            ["server_proof"] = BridgeAuth.ServerProof(token, clientNonce, serverNonce, role, extensionId),
        };
        byte[] challengeBytes = Encoding.UTF8.GetBytes(challenge.ToJsonString(JsonOptions));
        await ws.SendAsync(challengeBytes, WebSocketMessageType.Text, endOfMessage: true, ct);

        var reply = await ReceiveHandshakeAsync();
        string expectedClientProof = BridgeAuth.ClientProof(token, clientNonce, serverNonce, role, extensionId);
        if (TryGetString(reply, "type") != "auth_proof" ||
            !BridgeAuth.Same(TryGetString(reply, "client_proof"), expectedClientProof))
        {
            if (auth == "pair")
                _pairing.Failed();
            throw new AuthError("preuve du client fausse");
        }

        byte[] sessKey = BridgeAuth.SessionKey(token, clientNonce, serverNonce, role, extensionId);
        if (auth == "pair")
        {
            _pairing.Complete(clientNonce, serverNonce, extensionId);
            var pairChannel = new BridgeAuth.Channel(sessKey, "s2c", "c2s");
            var sealedOk = pairChannel.Seal("{\"type\":\"auth_ok\"}");
            byte[] okBytes = Encoding.UTF8.GetBytes(sealedOk.ToJsonString(JsonOptions));
            await ws.SendAsync(okBytes, WebSocketMessageType.Text, endOfMessage: true, ct);
            return null;
        }

        int order = Interlocked.Increment(ref _authOrder);
        var client = new BridgeClientConnection(ws, role, extensionId, sessKey, order);
        await client.SendAsync(new JsonObject { ["type"] = "auth_ok" }, ct);
        return client;
    }

    private static async Task<string?> ReceiveWebSocketTextAsync(WebSocket ws, int maxBytes, CancellationToken ct)
    {
        byte[] buffer = new byte[8192];
        using var ms = new MemoryStream();
        while (true)
        {
            var result = await ws.ReceiveAsync(buffer, ct);
            if (result.MessageType == WebSocketMessageType.Close)
                return null;
            if (result.MessageType != WebSocketMessageType.Text)
                throw new AuthError("message de poignée de main invalide");

            ms.Write(buffer, 0, result.Count);
            if (ms.Length > maxBytes)
                throw new AuthError("message de poignée de main invalide");

            if (result.EndOfMessage)
                break;
        }
        return Encoding.UTF8.GetString(ms.GetBuffer(), 0, (int)ms.Length);
    }

    private static async Task SafeCloseWebSocketAsync(WebSocket ws, WebSocketCloseStatus status, string description)
    {
        try
        {
            if (ws.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                await ws.CloseAsync(status, description, cts.Token);
            }
        }
        catch
        {
            // Ignore close error
        }
    }

    // -------------------------------------------------------------------------
    // Compteurs & Emergency Stop Watch
    // -------------------------------------------------------------------------

    private static void EcrireCompteurs(JsonObject data)
    {
        string fichier = Path.Combine(BridgeSecurity.DefaultDataDir(), "compteurs.json");
        string? rawSource = TryGetString(data, "source");
        string source = rawSource != null && Uuid36Regex.IsMatch(rawSource) ? rawSource : "defaut";
        var maintenant = DateTimeOffset.UtcNow;

        try
        {
            var sources = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
            if (File.Exists(fichier))
            {
                try
                {
                    if (JsonNode.Parse(File.ReadAllText(fichier, Encoding.UTF8)) is JsonObject lu &&
                        lu["sources"] is JsonObject srcObj)
                    {
                        foreach (var kv in srcObj)
                        {
                            if (kv.Value is JsonObject entry &&
                                TryGetString(entry, "at") is { } atStr &&
                                DateTimeOffset.TryParse(atStr, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var atTime) &&
                                (maintenant - atTime).TotalSeconds < 86_400)
                            {
                                sources[kv.Key] = (JsonObject)entry.DeepClone();
                            }
                        }
                    }
                }
                catch
                {
                    // Start fresh
                }
            }

            if (source != "defaut")
                sources.Remove("defaut");

            if (data["actif"] is JsonValue actifVal && actifVal.GetValueKind() == JsonValueKind.True)
            {
                int? gmail = null;
                if (data["gmail"] is JsonValue gVal && gVal.GetValueKind() == JsonValueKind.Number && gVal.TryGetValue<int>(out int gInt) && gInt is >= 0 and <= 1_000_000)
                    gmail = gInt;

                string? raison = TryGetString(data, "raison");
                if (!(gmail is null && raison != null && RaisonRegex.IsMatch(raison)))
                    raison = null;

                sources[source] = new JsonObject
                {
                    ["gmail"] = gmail.HasValue ? JsonValue.Create(gmail.Value) : null,
                    ["raison"] = raison != null ? JsonValue.Create(raison) : null,
                    ["at"] = maintenant.ToString("o", CultureInfo.InvariantCulture),
                };
            }
            else
            {
                sources.Remove(source);
            }

            if (sources.Count == 0)
            {
                if (File.Exists(fichier))
                    File.Delete(fichier);
                return;
            }

            var dir = Path.GetDirectoryName(fichier);
            if (!string.IsNullOrEmpty(dir))
                Directory.CreateDirectory(dir);
            var outSources = new JsonObject();
            foreach (var kv in sources)
                outSources[kv.Key] = kv.Value;
            var root = new JsonObject { ["sources"] = outSources };
            string tmp = fichier + ".tmp";
            File.WriteAllText(tmp, root.ToJsonString(JsonOptions), new UTF8Encoding(false));
            File.Move(tmp, fichier, overwrite: true);
        }
        catch
        {
            // Ignore counter error
        }
    }

    private async Task NotifyExtensionStopAsync(double left, BridgeClientConnection? target = null)
    {
        try
        {
            var p = new JsonObject { ["hold_s"] = Math.Round(left, 1) };
            await SendCommandToChromeAsync("emergency_stop", p, 5.0, client: null, target: target, gone: null);
        }
        catch
        {
            // Extension absent
        }
    }

    private async Task CancelForStopAsync(double left)
    {
        if (left <= 0)
            return;
        double now = EmergencyStop.NowMonotonic();
        _stopSeenUntil = Math.Max(_stopSeenUntil, now + left);

        var toCancel = new List<PendingCommand>();
        lock (_stateLock)
        {
            foreach (var kv in _pendingRequests.ToList())
            {
                if (kv.Value.Action == "emergency_stop" || kv.Value.Future.Task.IsCompleted)
                    continue;
                _pendingRequests.Remove(kv.Key);
                toCancel.Add(kv.Value);
            }
        }

        string msg = EmergencyStop.Message(left);
        foreach (var item in toCancel)
        {
            item.Future.TrySetException(new CommandCancelledException($"Command '{item.Action}' cancelled while running: {msg}"));
        }

        await NotifyExtensionStopAsync(left);
    }

    private async Task WatchEmergencyStopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                double left = _emergencyStop.RemainingSeconds();
                double now = EmergencyStop.NowMonotonic();
                if (left > 0 && now + left > _stopSeenUntil + 1.0)
                {
                    await CancelForStopAsync(left);
                }
            }
            catch
            {
                // Keep watcher alive
            }

            try
            {
                await Task.Delay(TimeSpan.FromSeconds(StopPollSeconds), ct);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    public List<string> NoteSession((string Agent, string Id) client, long? pid)
    {
        lock (_stateLock)
        {
            _clientProcesses.RemoveAll(x => x.Key == client);
            _clientProcesses.Add((client, pid));
            while (_clientProcesses.Count > MaxKnownSessions)
                _clientProcesses.RemoveAt(0);

            var dead = new List<string>();
            foreach (var (key, knownPid) in _clientProcesses)
            {
                if (key.Agent == client.Agent &&
                    key.Id != client.Id &&
                    knownPid.HasValue &&
                    !BridgeSecurity.ProcessRunning(knownPid.Value))
                {
                    dead.Add(key.Id);
                }
            }
            return dead;
        }
    }

    public static string NormalizeAction(string action) =>
        (action ?? "").ToLowerInvariant().Replace('-', '_');

    public async Task<JsonNode?> SendCommandToChromeAsync(
        string action,
        JsonObject? @params = null,
        double timeout = 15.0,
        (string Agent, string Id)? client = null,
        BridgeClientConnection? target = null,
        List<string>? gone = null,
        bool shutdownProbe = false)
    {
        string normalizedAction = NormalizeAction(action);
        var payload = new JsonObject
        {
            ["action"] = normalizedAction,
            ["params"] = @params != null ? (JsonObject)@params.DeepClone() : new JsonObject(),
        };
        if (client.HasValue)
        {
            payload["client"] = new JsonObject
            {
                ["agent"] = client.Value.Agent,
                ["id"] = client.Value.Id,
            };
        }
        if (gone is { Count: > 0 })
        {
            var goneArr = new JsonArray();
            foreach (var g in gone)
                goneArr.Add(g);
            payload["gone"] = goneArr;
        }

        string reqId;
        TaskCompletionSource<JsonObject> tcs;

        while (true)
        {
            if (normalizedAction != "emergency_stop" && !BridgeSecurity.IsReadOnlyAction(action) && _emergencyStop.Check() is { } stop)
                throw new CommandCancelledException(stop);
            BridgeClientConnection? chosen;
            lock (_stateLock)
            {
                if (shutdownProbe && target is not null && !_activeConnections.Contains(target))
                    throw new InvalidOperationException("An extension disconnected during ownership verification; bridge kept.");
                chosen = target != null && _activeConnections.Contains(target) ? target : SelectTarget();
            }
            if (chosen is null)
            {
                throw new InvalidOperationException(
                    "No Chrome browser extension connected to the NexusBrowser bridge. Make sure the extension is active in Chrome.");
            }

            reqId = Guid.NewGuid().ToString();
            tcs = new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously);
            lock (_stateLock)
            {
                if (_draining && !shutdownProbe) throw new InvalidOperationException("Bridge update in progress: no command was sent; retry after reconnecting.");
                _pendingRequests[reqId] = new PendingCommand(chosen, tcs, normalizedAction);
            }

            try
            {
                var wire = (JsonObject)payload.DeepClone();
                var ordered = new JsonObject { ["requestId"] = reqId };
                foreach (var kv in wire)
                    ordered[kv.Key] = kv.Value?.DeepClone();
                await chosen.SendAsync(ordered);
                break;
            }
            catch
            {
                lock (_stateLock)
                {
                    _pendingRequests.Remove(reqId);
                    _activeConnections.Remove(chosen);
                }
                if (shutdownProbe) throw new InvalidOperationException("An extension could not be verified; bridge kept.");
                target = null;
            }
        }

        try
        {
            var response = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(timeout));
            bool success = response["success"] is JsonValue sv && sv.GetValueKind() == JsonValueKind.True;
            if (!success)
            {
                string err = TryGetString(response, "error") ?? "Unknown error from Chrome extension";
                throw new InvalidOperationException(err);
            }
            return response["data"]?.DeepClone();
        }
        catch (TimeoutException)
        {
            throw new TimeoutException($"Command '{action}' timed out after {timeout}s.");
        }
        finally
        {
            lock (_stateLock)
            {
                _pendingRequests.Remove(reqId);
            }
        }
    }

    // -------------------------------------------------------------------------
    // HTTP REST Server (127.0.0.1:(port + 1))
    // -------------------------------------------------------------------------

    private async Task HandleHttpSocketAsync(Socket socket, CancellationToken ct)
    {
        using var ownedSocket = socket;
        using var stream = new NetworkStream(socket, ownsSocket: false);

        try
        {
            var headerResult = await ReadHttpHeadersAsync(stream, ct, sendErrorResponses: true);
            if (headerResult is null)
                return;

            var (method, path, headers, overRead) = headerResult.Value;

            long contentLength = 0;
            if (headers.TryGetValue("content-length", out var clRaw))
            {
                if (!long.TryParse(clRaw, NumberStyles.None, CultureInfo.InvariantCulture, out contentLength))
                {
                    await SendJsonResponseAsync(stream, 400, new JsonObject { ["success"] = false, ["error"] = "Invalid Content-Length" });
                    return;
                }
            }
            if (contentLength < 0 || contentLength > MaxRequestBytes)
            {
                await SendJsonResponseAsync(stream, 413, new JsonObject { ["success"] = false, ["error"] = "Request body too large" });
                return;
            }

            if (headers.ContainsKey("origin"))
            {
                await SendJsonResponseAsync(stream, 403, new JsonObject { ["success"] = false, ["error"] = "Browser origins are not allowed" });
                return;
            }

            headers.TryGetValue(BridgeSecurity.TokenHeader.ToLowerInvariant(), out var suppliedToken);
            string currentToken = ReadBridgeToken();
            if (!BridgeAuth.Same(suppliedToken ?? "", currentToken))
            {
                await SendJsonResponseAsync(stream, 401, new JsonObject { ["success"] = false, ["error"] = "Authentication required" });
                return;
            }

            byte[] body = [];
            if (contentLength > 0)
            {
                body = new byte[contentLength];
                int copied = Math.Min(overRead.Length, (int)contentLength);
                if (copied > 0)
                    Array.Copy(overRead, 0, body, 0, copied);
                int offset = copied;
                using var readCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                readCts.CancelAfter(TimeSpan.FromSeconds(HttpReadTimeoutSeconds));
                while (offset < (int)contentLength)
                {
                    int n = await stream.ReadAsync(body.AsMemory(offset, (int)contentLength - offset), readCts.Token);
                    if (n == 0)
                    {
                        await SendJsonResponseAsync(stream, 400, new JsonObject { ["success"] = false, ["error"] = "Incomplete HTTP body" });
                        return;
                    }
                    offset += n;
                }
            }

            if (path is "/api/status" or "/status")
            {
                if (method != "GET")
                {
                    await SendJsonResponseAsync(stream, 405, new JsonObject { ["success"] = false, ["error"] = "Method not allowed" }, new Dictionary<string, string> { ["Allow"] = "GET" });
                    return;
                }

                JsonArray clientsArr;
                BridgeClientConnection? target;
                int count;
                lock (_stateLock)
                {
                    count = _activeConnections.Count;
                    clientsArr = new JsonArray(_activeConnections.Select(c => (JsonNode)c.Describe()).ToArray());
                    target = SelectTarget();
                }

                var statusPayload = new JsonObject
                {
                    ["status"] = "online",
                    ["version"] = BridgeSecurity.Version,
                    ["fingerprint"] = RestartRequest.RuntimeFingerprint,
                    ["connected_clients"] = count,
                    ["chrome_running"] = ChromeLauncher.IsRunning(),
                    ["clients"] = clientsArr,
                    ["target"] = target?.Describe(),
                    ["emergency_stop_s"] = Math.Round(_emergencyStop.RemainingSeconds(), 1),
                    ["port"] = WsPort,
                    ["pid"] = Environment.ProcessId,
                    ["instance_id"] = _instanceId,
                    ["cooperative_shutdown"] = true,
                };
                await SendJsonResponseAsync(stream, 200, statusPayload);
                return;
            }

            if (path == "/api/shutdown")
            {
                if (method != "POST")
                {
                    await SendJsonResponseAsync(stream, 405, new JsonObject { ["success"] = false, ["error"] = "POST required" });
                    return;
                }
                JsonObject? request;
                try { request = JsonNode.Parse(body) as JsonObject; }
                catch (JsonException) { request = null; }
                if (request?["instance_id"] is not JsonValue idValue || !idValue.TryGetValue<string>(out string? instanceId) ||
                    request["pid"] is not JsonValue pidValue || !pidValue.TryGetValue<int>(out int requestedPid))
                {
                    await SendJsonResponseAsync(stream, 400, new JsonObject { ["success"] = false, ["error"] = "instance_id string and pid integer required; nothing was stopped." });
                    return;
                }
                if (instanceId != _instanceId || requestedPid != Environment.ProcessId)
                {
                    await SendJsonResponseAsync(stream, 409, new JsonObject { ["success"] = false, ["error"] = "Bridge identity changed; nothing was stopped." });
                    return;
                }
                bool busy;
                lock (_stateLock)
                {
                    busy = _draining || _httpCommands != 0 || _pendingRequests.Count != 0;
                    if (!busy) _draining = true;
                }
                if (busy)
                {
                    await SendJsonResponseAsync(stream, 409, new JsonObject { ["success"] = false, ["deferred"] = true, ["error"] = "A command is running; bridge kept." });
                    return;
                }
                bool accepted = false;
                try
                {
                    List<BridgeClientConnection> targets;
                    lock (_stateLock) targets = [.. _activeConnections];
                    if (targets.Count == 0)
                    {
                        if (ChromeLauncher.IsRunning()) throw new InvalidOperationException("Chrome is running but tab ownership cannot be checked; bridge kept.");
                    }
                    else
                    {
                        var identity = (Agent: "Installer", Id: "installer-shutdown-" + _instanceId);
                        // More than one Chrome profile can connect. Check every authenticated connection within
                        // one bounded probe interval, not just the currently preferred service worker.
                        var reports = await Task.WhenAll(targets.Select(target => SendCommandToChromeAsync("list-tabs", new JsonObject(), 3, identity, target, shutdownProbe: true)));
                        foreach (var tabs in reports)
                        foreach (var tab in tabs as JsonArray ?? throw new InvalidOperationException("Tab ownership unavailable; bridge kept."))
                        {
                            if (tab is not JsonObject value || value["id"] is not JsonValue tabId || !tabId.TryGetValue<int>(out int id) || id <= 0 ||
                                !value.ContainsKey("owner") || value["state"] is not JsonValue state || !state.TryGetValue<string>(out string? tabState))
                                throw new InvalidOperationException("Invalid tab ownership report; bridge kept.");
                            if (value["owner"] is not null || tabState != "user")
                                throw new InvalidOperationException("An agent owns Chrome tabs; bridge kept.");
                        }
                    }
                    await SendJsonResponseAsync(stream, 200, new JsonObject { ["success"] = true, ["shutdown"] = true, ["pid"] = Environment.ProcessId, ["instance_id"] = _instanceId });
                    accepted = true;
                    Log("INFO", $"cooperative shutdown accepted instance={_instanceId}: no command running, no agent-owned tab");
                    _shutdown.TrySetResult();
                }
                catch (Exception ex) when (ex is InvalidOperationException or TimeoutException)
                {
                    await SendJsonResponseAsync(stream, 409, new JsonObject { ["success"] = false, ["deferred"] = true, ["error"] = ex.Message });
                }
                finally { if (!accepted) { lock (_stateLock) _draining = false; } }
                return;
            }

            if (path == "/api/update")
            {
                if (method is not ("GET" or "POST"))
                {
                    await SendJsonResponseAsync(stream, 405, new JsonObject { ["success"] = false, ["error"] = "Method not allowed" }, new Dictionary<string, string> { ["Allow"] = "GET, POST" });
                    return;
                }
                var (code, updateObj) = method == "POST" ? await StartUpdateAsync(ct) : (200, ReadUpdateStatus());
                updateObj["success"] = code is 200 or 202;
                await SendJsonResponseAsync(stream, code, updateObj);
                return;
            }

            if (path is "/api/pair" or "/api/pair/revoke")
            {
                if (method != "POST")
                {
                    await SendJsonResponseAsync(stream, 405, new JsonObject { ["success"] = false, ["error"] = "Method not allowed" }, new Dictionary<string, string> { ["Allow"] = "POST" });
                    return;
                }
                if (path == "/api/pair")
                {
                    var offer = _pairing.Offer();
                    var res = new JsonObject { ["success"] = true };
                    foreach (var kv in offer)
                        res[kv.Key] = kv.Value?.DeepClone();
                    await SendJsonResponseAsync(stream, 200, res);
                    return;
                }

                string? extId = null;
                if (body.Length > 0)
                {
                    try
                    {
                        var reqNode = JsonNode.Parse(Encoding.UTF8.GetString(body));
                        if (reqNode is JsonObject reqObj && reqObj["extension_id"] is not null)
                        {
                            extId = TryGetString(reqObj, "extension_id");
                            BridgeAuth.CheckExtensionId(extId);
                        }
                    }
                    catch
                    {
                        await SendJsonResponseAsync(stream, 400, new JsonObject { ["success"] = false, ["error"] = "extension_id invalide" });
                        return;
                    }
                }
                int revoked = _pairing.Revoke(extId);
                await SendJsonResponseAsync(stream, 200, new JsonObject { ["success"] = true, ["revoked"] = revoked });
                return;
            }

            if (path == "/api/command")
            {
                if (method != "POST")
                {
                    await SendJsonResponseAsync(stream, 405, new JsonObject { ["success"] = false, ["error"] = "Method not allowed" }, new Dictionary<string, string> { ["Allow"] = "POST" });
                    return;
                }

                headers.TryGetValue("content-type", out var ctHeader);
                string mediaType = (ctHeader ?? "").Split(';', 2)[0].Trim().ToLowerInvariant();
                if (mediaType != "application/json")
                {
                    await SendJsonResponseAsync(stream, 415, new JsonObject { ["success"] = false, ["error"] = "application/json required" });
                    return;
                }

                JsonNode? parsedBody;
                try
                {
                    parsedBody = JsonNode.Parse(Encoding.UTF8.GetString(body));
                }
                catch
                {
                    await SendJsonResponseAsync(stream, 400, new JsonObject { ["success"] = false, ["error"] = "Invalid JSON body" });
                    return;
                }

                if (parsedBody is not JsonObject reqJson)
                {
                    await SendJsonResponseAsync(stream, 400, new JsonObject { ["success"] = false, ["error"] = "JSON body must be an object" });
                    return;
                }

                string? action = TryGetString(reqJson, "action");
                if (string.IsNullOrWhiteSpace(action))
                {
                    await SendJsonResponseAsync(stream, 400, new JsonObject { ["success"] = false, ["error"] = "A non-empty action is required" });
                    return;
                }

                JsonObject @params;
                if (!reqJson.ContainsKey("params") || reqJson["params"] is null)
                {
                    @params = new JsonObject();
                }
                else if (reqJson["params"] is JsonObject pObj)
                {
                    @params = (JsonObject)pObj.DeepClone();
                }
                else
                {
                    await SendJsonResponseAsync(stream, 400, new JsonObject { ["success"] = false, ["error"] = "params must be an object" });
                    return;
                }

                double timeout = 15.0;
                if (reqJson.ContainsKey("timeout") && reqJson["timeout"] is not null)
                {
                    if (reqJson["timeout"] is not JsonValue tv ||
                        tv.GetValueKind() != JsonValueKind.Number ||
                        !tv.TryGetValue<double>(out timeout) ||
                        !double.IsFinite(timeout) ||
                        timeout < 0.1 ||
                        timeout > 120.0)
                    {
                        await SendJsonResponseAsync(stream, 400, new JsonObject { ["success"] = false, ["error"] = "timeout must be between 0.1 and 120 seconds" });
                        return;
                    }
                }

                string normalized = NormalizeAction(action.Trim());
                if (ReservedActions.Contains(normalized))
                {
                    await SendJsonResponseAsync(stream, 403, new JsonObject { ["success"] = false, ["error"] = $"Action '{action}' is reserved to the bridge itself." });
                    return;
                }

                headers.TryGetValue(BridgeSecurity.AgentHeader.ToLowerInvariant(), out var agentHdr);
                headers.TryGetValue(BridgeSecurity.ClientHeader.ToLowerInvariant(), out var clientHdr);
                var client = BridgeSecurity.CheckIdentity(agentHdr, clientHdr);
                if (client is null && !AnonymousActions.Contains(normalized))
                {
                    await SendJsonResponseAsync(stream, 400, new JsonObject
                    {
                        ["success"] = false,
                        ["error"] = $"Missing or invalid client identity ({BridgeSecurity.AgentHeader} and {BridgeSecurity.ClientHeader} headers): go through an up-to-date nexus-browser MCP server (or bridge_client), rerun install.ps1.",
                    });
                    return;
                }

                if (!BridgeSecurity.IsReadOnlyAction(action))
                {
                    if (_emergencyStop.Check() is { } stopMsg)
                    {
                        await SendJsonResponseAsync(stream, 423, new JsonObject
                        {
                            ["success"] = false,
                            ["error"] = stopMsg,
                            ["emergency_stop"] = true,
                        });
                        return;
                    }
                }

                if (BridgeSecurity.IsUploadAction(action, @params))
                {
                    var refusal = BridgeSecurity.UploadRefusal(@params["files"]);
                    if (refusal is not null)
                    {
                        await SendJsonResponseAsync(stream, 403, new JsonObject { ["success"] = false, ["error"] = refusal });
                        return;
                    }
                }

                headers.TryGetValue(BridgeSecurity.PidHeader.ToLowerInvariant(), out var pidHdr);
                bool draining;
                lock (_stateLock)
                {
                    draining = _draining;
                    if (!draining) _httpCommands++;
                }
                if (draining)
                {
                    await SendJsonResponseAsync(stream, 503, new JsonObject { ["success"] = false, ["error"] = "Bridge update in progress; no command sent." });
                    return;
                }
                try
                {
                    var gone = client.HasValue ? NoteSession(client.Value, BridgeSecurity.CheckPid(pidHdr)) : null;
                    // Sessions the MCP daemon closed (DELETE by the client, idle expiry): their tabs become orphans at once,
                    // for the same agent only (the extension reads "gone" in the caller's agent).
                    if (client.HasValue && headers.TryGetValue(BridgeSecurity.GoneHeader.ToLowerInvariant(), out var goneHdr))
                    {
                        gone ??= [];
                        foreach (var id in goneHdr.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Take(32))
                            if (id != client.Value.Id && BridgeSecurity.CheckIdentity(client.Value.Agent, id) is not null && !gone.Contains(id)) gone.Add(id);
                    }

                    try
                    {
                        var result = await SendCommandToChromeAsync(action, @params, timeout, client, null, gone);
                        await SendJsonResponseAsync(stream, 200, new JsonObject
                        {
                            ["success"] = true,
                            ["data"] = result,
                        });
                    }
                    catch (CommandCancelledException ex)
                    {
                        await SendJsonResponseAsync(stream, 423, new JsonObject
                        {
                            ["success"] = false,
                            ["error"] = ex.Message,
                            ["emergency_stop"] = true,
                        });
                    }
                    catch (Exception ex)
                    {
                        await SendJsonResponseAsync(stream, 400, new JsonObject
                        {
                            ["success"] = false,
                            ["error"] = ex.Message,
                        });
                    }
                }
                finally { lock (_stateLock) _httpCommands--; }
                return;
            }

            await SendJsonResponseAsync(stream, 404, new JsonObject { ["success"] = false, ["error"] = "Not found" });
        }
        catch (OperationCanceledException)
        {
            await SendJsonResponseAsync(stream, 408, new JsonObject { ["success"] = false, ["error"] = "HTTP request timed out" });
        }
        catch
        {
            // Connection closed or failed
        }
    }

    private static async Task<(string Method, string Path, Dictionary<string, string> Headers, byte[] OverRead)?> ReadHttpHeadersAsync(
        NetworkStream stream,
        CancellationToken ct,
        bool sendErrorResponses = false)
    {
        using var readCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        readCts.CancelAfter(TimeSpan.FromSeconds(HttpReadTimeoutSeconds));

        byte[] buf = new byte[MaxHeaderBytes + 4];
        int total = 0;
        int headerEnd = -1;

        while (total < buf.Length)
        {
            int n = await stream.ReadAsync(buf.AsMemory(total, buf.Length - total), readCts.Token);
            if (n == 0)
            {
                if (sendErrorResponses && total > 0)
                    await SendJsonResponseAsync(stream, 400, new JsonObject { ["success"] = false, ["error"] = "Incomplete HTTP headers" });
                return null;
            }
            total += n;
            headerEnd = FindHeaderEnd(buf.AsSpan(0, total));
            if (headerEnd >= 0)
                break;
        }

        if (headerEnd < 0 || headerEnd + 4 > MaxHeaderBytes)
        {
            if (sendErrorResponses)
                await SendJsonResponseAsync(stream, 431, new JsonObject { ["success"] = false, ["error"] = "Request headers too large" });
            return null;
        }

        string headerText;
        try
        {
            var ascii = Encoding.GetEncoding("us-ascii", EncoderFallback.ExceptionFallback, DecoderFallback.ExceptionFallback);
            headerText = ascii.GetString(buf, 0, headerEnd);
        }
        catch
        {
            if (sendErrorResponses)
                await SendJsonResponseAsync(stream, 400, new JsonObject { ["success"] = false, ["error"] = "Invalid HTTP headers" });
            return null;
        }

        string[] lines = headerText.Split("\r\n");
        string[] reqParts = lines[0].Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (reqParts.Length != 3 || !reqParts[2].StartsWith("HTTP/", StringComparison.Ordinal))
        {
            if (sendErrorResponses)
                await SendJsonResponseAsync(stream, 400, new JsonObject { ["success"] = false, ["error"] = "Invalid HTTP request line" });
            return null;
        }

        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 1; i < lines.Length; i++)
        {
            int colon = lines[i].IndexOf(':');
            if (colon > 0)
            {
                string k = lines[i][..colon].Trim().ToLowerInvariant();
                string v = lines[i][(colon + 1)..].Trim();
                headers[k] = v;
            }
        }

        int bodyStart = headerEnd + 4;
        byte[] overRead = total > bodyStart ? buf[bodyStart..total] : [];
        return (reqParts[0], reqParts[1], headers, overRead);
    }

    private static int FindHeaderEnd(ReadOnlySpan<byte> span)
    {
        for (int i = 0; i <= span.Length - 4; i++)
        {
            if (span[i] == '\r' && span[i + 1] == '\n' && span[i + 2] == '\r' && span[i + 3] == '\n')
                return i;
        }
        return -1;
    }

    private static async Task SendJsonResponseAsync(
        NetworkStream stream,
        int status,
        JsonObject payload,
        Dictionary<string, string>? extraHeaders = null)
    {
        string reason = status switch
        {
            200 => "OK",
            202 => "Accepted",
            400 => "Bad Request",
            401 => "Unauthorized",
            403 => "Forbidden",
            404 => "Not Found",
            405 => "Method Not Allowed",
            408 => "Request Timeout",
            409 => "Conflict",
            413 => "Content Too Large",
            415 => "Unsupported Media Type",
            423 => "Locked",
            431 => "Request Header Fields Too Large",
            500 => "Internal Server Error",
            _ => "Error",
        };

        byte[] body = Encoding.UTF8.GetBytes(payload.ToJsonString(JsonOptions));
        var sb = new StringBuilder();
        sb.Append($"HTTP/1.1 {status} {reason}\r\n");
        sb.Append("Content-Type: application/json; charset=utf-8\r\n");
        sb.Append("Cache-Control: no-store\r\n");
        sb.Append("X-Content-Type-Options: nosniff\r\n");
        sb.Append("Connection: close\r\n");
        sb.Append($"Content-Length: {body.Length}\r\n");
        if (extraHeaders != null)
        {
            foreach (var kv in extraHeaders)
                sb.Append($"{kv.Key}: {kv.Value}\r\n");
        }
        sb.Append("\r\n");

        byte[] headerBytes = Encoding.ASCII.GetBytes(sb.ToString());
        try
        {
            await stream.WriteAsync(headerBytes);
            await stream.WriteAsync(body);
            await stream.FlushAsync();
        }
        catch
        {
            // Client gone
        }
    }

    private static string UpdateStatusPath() => Path.Combine(
        Environment.GetEnvironmentVariable("NEXUS_STATUS_DIR") ?? Path.Combine(BridgeSecurity.HomeDir(), ".nexus", "status"), "browser.json");

    private static JsonObject ReadUpdateStatus()
    {
        JsonObject status;
        try { status = JsonNode.Parse(File.ReadAllText(UpdateStatusPath())) as JsonObject ?? new JsonObject(); }
        catch (Exception ex) when (ex is IOException or JsonException) { status = new JsonObject(); }
        status["product"] = "browser";
        status["version"] = BridgeSecurity.Version;
        status["active"] = BridgeSecurity.Version;
        status["active_fingerprint"] = RestartRequest.RuntimeFingerprint;
        status["state"] ??= "idle";
        return status;
    }

    private static void WriteUpdateStatus(JsonObject status)
    {
        string path = UpdateStatusPath();
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        string temporary = path + $".{Guid.NewGuid():N}.tmp";
        try { File.WriteAllText(temporary, status.ToJsonString(JsonOptions), new UTF8Encoding(false)); File.Move(temporary, path, true); }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    /// <summary>Folder this build was installed from (installation.json written by install.ps1), if any.</summary>
    public static string? InstalledSourceRoot()
    {
        try
        {
            var metadata = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "installation.json"))) as JsonObject;
            string? root = metadata is null ? null : TryGetString(metadata, "repository_root");
            return string.IsNullOrWhiteSpace(root) || !Directory.Exists(root) ? null : root;
        }
        catch (Exception ex) when (ex is IOException or JsonException or ArgumentException or UnauthorizedAccessException) { return null; }
    }

    private static bool PublicInstallation()
    {
        try
        {
            var metadata = JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "installation.json"))) as JsonObject;
            string? root = metadata is null ? null : TryGetString(metadata, "repository_root");
            string expected = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "NexusBrowser", "app");
            return !string.IsNullOrWhiteSpace(root) && string.Equals(Path.GetFullPath(root).TrimEnd('\\', '/'), expected.TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception ex) when (ex is IOException or JsonException or ArgumentException) { return false; }
    }

    private async Task CheckUpdateAsync(CancellationToken ct, bool force = false)
    {
        await _updateLock.WaitAsync(ct);
        try
        {
            var status = ReadUpdateStatus();
            status["version"] = BridgeSecurity.Version;
            if (TryGetString(status, "state") is "checking" or "updating")
            {
                status["state"] = "deferred";
                status["message"] = "Maintenance requested; loaded companion and extension still require activation verification.";
            }
            bool stale = force || !DateTimeOffset.TryParse(TryGetString(status, "checked_at"), out var checkedAt) || DateTimeOffset.UtcNow - checkedAt >= TimeSpan.FromDays(1);
            if (stale)
            {
                try
                {
                    using var handler = new HttpClientHandler { AllowAutoRedirect = false };
                    using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(10) };
                    using var request = new HttpRequestMessage(HttpMethod.Head, "https://github.com/pironjulien/NexusBrowser/releases/latest");
                    request.Headers.UserAgent.ParseAdd("NexusBrowser-update");
                    using var response = await client.SendAsync(request, ct);
                    var match = Regex.Match(response.Headers.Location?.ToString() ?? "", @"/releases/tag/v?(\d+\.\d+\.\d+)$");
                    if (!match.Success) throw new InvalidDataException("latest release not found on github.com");
                    status["latest"] = match.Groups[1].Value;
                    status["checked_at"] = DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);
                }
                catch (Exception ex) when (ex is HttpRequestException or IOException or TaskCanceledException)
                {
                    if (ct.IsCancellationRequested) return;
                    status["message"] = $"Update check failed: {ex.Message}";
                }
            }
            if (Version.TryParse(TryGetString(status, "latest"), out var latest) && latest <= Version.Parse(BridgeSecurity.Version)) status["latest"] = BridgeSecurity.Version;
            else if (latest is not null && TryGetString(status, "state") == "idle")
                status["message"] = PublicInstallation() ? $"Version {latest} is available: POST /api/update installs it." : $"Version {latest} is available: this is a developer checkout, update it with git.";
            WriteUpdateStatus(status);
        }
        catch (Exception ex) when (ex is not OperationCanceledException) { Log("WARNING", $"Update check failed: {ex.Message.Replace('\r', ' ').Replace('\n', ' ')}"); }
        finally { _updateLock.Release(); }
    }

    private async Task<(int Code, JsonObject Status)> StartUpdateAsync(CancellationToken ct)
    {
        if (WsPort == DefaultPort && _tokenFile == BridgeSecurity.TokenPath()) await CheckUpdateAsync(ct, force: true);
        await _updateLock.WaitAsync(ct);
        try
        {
            var status = ReadUpdateStatus();
            if (TryGetString(status, "state") == "updating") return (202, status);
            status["version"] = BridgeSecurity.Version;
            // The ecosystem owns its one maintenance schedule. A product request delegates to that existing task.
            if (File.Exists(Path.Combine(BridgeSecurity.HomeDir(), ".nexus", "nexussystem", "maintenance", "get-nexus.ps1")) &&
                await RunUpdateTaskAsync("NexusSystem Update", queryFirst: true, ct))
            {
                status["state"] = "deferred"; status["message"] = "NexusSystem maintenance requested; activation will be verified separately.";
                WriteUpdateStatus(status);
                return (202, status);
            }
            if (!PublicInstallation())
            {
                status["message"] = "Developer checkout: update it with git (no self-update).";
                WriteUpdateStatus(status);
                return (409, status);
            }
            if (!Version.TryParse(TryGetString(status, "latest"), out var latest) || latest <= Version.Parse(BridgeSecurity.Version))
            {
                status["state"] = "idle"; status["message"] = $"{BridgeSecurity.Version} is the latest version.";
                WriteUpdateStatus(status);
                return (200, status);
            }
            status["state"] = "updating"; status["message"] = $"Updating to {latest}..."; WriteUpdateStatus(status);
            try
            {
                var start = new ProcessStartInfo("schtasks.exe") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
                foreach (var part in new[] { "/Run", "/TN", "Nexus Browser Update" }) start.ArgumentList.Add(part);
                using var process = Process.Start(start) ?? throw new IOException("Update task not started");
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(TimeSpan.FromSeconds(5));
                await process.WaitForExitAsync(timeout.Token);
                if (process.ExitCode != 0) throw new IOException($"Task scheduler refused the update (exit {process.ExitCode})");
                return (202, status);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                status["state"] = "failed"; status["message"] = $"Update task not started: {ex.Message}"; WriteUpdateStatus(status);
                return (500, status);
            }
        }
        finally { _updateLock.Release(); }
    }

    private static async Task<bool> RunUpdateTaskAsync(string name, bool queryFirst, CancellationToken ct)
    {
        async Task<bool> Run(params string[] args)
        {
            var start = new ProcessStartInfo("schtasks.exe") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (var arg in args) start.ArgumentList.Add(arg);
            using var process = Process.Start(start) ?? throw new IOException("Task scheduler unavailable");
            var stdout = process.StandardOutput.ReadToEndAsync(ct); var stderr = process.StandardError.ReadToEndAsync(ct);
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(ct); limit.CancelAfter(TimeSpan.FromSeconds(5));
            await process.WaitForExitAsync(limit.Token); await stdout; await stderr;
            return process.ExitCode == 0;
        }
        if (queryFirst && !await Run("/Query", "/TN", name)) return false;
        if (!await Run("/Run", "/TN", name)) throw new IOException($"Maintenance task {name} refused the request; no product fallback was started.");
        return true;
    }

    private static string? TryGetString(JsonObject obj, string key)
    {
        if (obj[key] is JsonValue val && val.GetValueKind() == JsonValueKind.String && val.TryGetValue<string>(out var s))
            return s;
        return null;
    }
}
