using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using FsCheck;
using FsCheck.Fluent;
using NexusBrowser.Native;
using Xunit;

namespace NexusBrowser.Tests;

/// <summary>
/// Robustness of every reader of outside data (FsCheck property tests): identities and signed frames of the bridge, the
/// pairing file, the paths an agent hands in, response bodies and console entries of web pages, JSON-RPC requests, the
/// journal and the masking of secrets. Each runs on any input and on real inputs damaged at random: never an unhandled
/// exception, an invalid message always refused, a secret never shown, a size limit always kept.
/// </summary>
[Collection(ProcessEnvironmentCollection.Name)]
public sealed partial class RobustnessTests : IDisposable
{
    private static readonly Config Runs = Config.QuickThrowOnFailure.WithQuietOnSuccess(true);
    private readonly TempDir _dir = new();

    public void Dispose() => _dir.Dispose();

    private static void Holds(Property property, int runs = 2000) => Check.One(Runs.WithMaxTest(runs), property);

    // n-th drawn number (0 when missing).
    private static int Nth(NonNegativeInt[]? n, int i) => n is not null && i < n.Length ? n[i].Get : 0;

    // Characters that break a parser or a check: separators, quotes, escapes, line ends, NUL, look-alikes, a lone surrogate.
    private static readonly char[] Breakers = ['\\', '"', '{', '}', '[', ']', ':', ',', '\n', '\r', '\0', ' ', '.', '/', '=', '%', '$', 'é', '\uFF0E', '\uD800'];

    // A real input damaged: a character inserted or replaced, or a piece removed; one time in three at its very end, and
    // two times in three a breaking character.
    private static string Damage(string text, NonNegativeInt[] n, char c)
    {
        int at = Nth(n, 5) % 3 == 0 ? text.Length - Nth(n, 6) % 2 : Nth(n, 0) % (text.Length + 1);
        at = Math.Clamp(at, 0, text.Length);
        string ch = (Nth(n, 3) % 3 == 0 ? c : Breakers[Nth(n, 4) % Breakers.Length]).ToString();
        return (Nth(n, 1) % 3) switch
        {
            0 => text.Insert(at, ch),
            1 when at < text.Length => text.Remove(at, 1).Insert(at, ch),
            _ => text.Remove(at, Math.Min(1 + Nth(n, 2) % 8, text.Length - at)),
        };
    }

    // Text as a connection receives it: decoded from UTF-8, so a lone surrogate is already U+FFFD.
    private static string Received(string text) => Encoding.UTF8.GetString(Encoding.UTF8.GetBytes(text));

    // Any JSON value built from drawn words (and the reader's own key names): objects, arrays, strings, numbers, booleans, null.
    private static JsonNode? AnyJson(Random r, string[] words, int depth = 0)
    {
        string Word() => words.Length == 0 ? "" : words[r.Next(words.Length)] ?? "";
        switch (depth > 4 ? r.Next(4) : r.Next(7))
        {
            case 0: return JsonValue.Create(Word());
            case 1: return r.Next(3) == 0 ? JsonValue.Create(r.NextDouble() * 1e12 - 5e11) : JsonValue.Create(r.Next(int.MinValue, int.MaxValue) / (r.Next(4) == 0 ? 1 : 1 << r.Next(31)));
            case 2: return JsonValue.Create(r.Next(2) == 0);
            case 3: return null;
            case 4 or 5:
            {
                var obj = new JsonObject();
                for (int i = r.Next(6); i > 0; i--) obj[Word()] = AnyJson(r, words, depth + 1);
                return obj;
            }
            default: return new JsonArray(Enumerable.Range(0, r.Next(5)).Select(_ => AnyJson(r, words, depth + 1)).ToArray());
        }
    }

    private static string[] Words(string[]? drawn, params string[] keys) => [.. (drawn ?? []).Select(w => w ?? ""), .. keys, .. keys];

    // -------------------------------------------------------------------------
    // Bridge: identities, nonces, signed frames, pairing file
    // -------------------------------------------------------------------------

    private static bool Only(string value, Func<char, bool> allowed) => value.All(allowed);

    [Fact]
    public void AnIdentityNonceOrExtensionIdIsAcceptedOnlyInItsExactAlphabet()
    {
        string nonce = BridgeAuth.NewNonce(), extension = new('p', 32);
        static bool B64(char c) => char.IsAsciiLetterOrDigit(c) || c is '-' or '_';
        Holds(Prop.ForAll<NonNegativeInt[], char, string>((n, c, any) =>
        {
            foreach (string agent in new[] { any ?? "", Damage("Codex", n, c) })
                if (BridgeSecurity.CheckIdentity(agent, Damage("codex-1a2b3c", n, c)) is var (a, id) &&
                    (a.Length is < 1 or > 32 || !Only(a, ch => char.IsAsciiLetterOrDigit(ch) || ch is ' ' or '_' or '.' or '-') ||
                     id.Length is < 4 or > 64 || !Only(id, ch => char.IsAsciiLetterOrDigit(ch) || ch is '_' or '.' or ':' or '-')))
                    throw new InvalidOperationException($"identity accepted: «{a}» «{id}»");
            foreach (string pid in new[] { any ?? "", Damage("4242", n, c) })
                if (BridgeSecurity.CheckPid(pid) is long p && (p <= 0 || p >= 1L << 32))
                    throw new InvalidOperationException($"pid accepted: {p}");
            foreach (string value in new[] { any ?? "", Damage(nonce, n, c) })
            {
                try
                {
                    string kept = BridgeAuth.CheckNonce(value, "client_nonce");
                    if (kept.Length != 43 || !Only(kept, B64)) throw new InvalidOperationException($"nonce accepted: «{kept}»");
                }
                catch (AuthException) { /* refused: expected */ }
            }
            foreach (string value in new[] { any ?? "", Damage(extension, n, c) })
            {
                try
                {
                    string kept = BridgeAuth.CheckExtensionId(value);
                    if (kept.Length != 32 || !Only(kept, ch => ch is >= 'a' and <= 'p')) throw new InvalidOperationException($"extension id accepted: «{kept}»");
                }
                catch (AuthException) { /* refused: expected */ }
            }
        }));
    }

    // Bug found by this test: the nonce and extension id patterns ended with $, which also matches before a final line
    // feed, so "<42 characters>\n" passed as a nonce and "<32 letters>\n" as an extension id (HMAC input and logs).
    [Fact]
    public void ANonceOrExtensionIdEndingWithALineFeedIsRefused()
    {
        Assert.Throws<AuthException>(() => BridgeAuth.CheckNonce(BridgeAuth.NewNonce()[..42] + "\n", "client_nonce"));
        Assert.Throws<AuthException>(() => BridgeAuth.CheckExtensionId(new string('p', 32) + "\n"));
    }

    [Fact]
    public void ASignedFrameOpensOnlyUntouchedOnceAndInOrder()
    {
        byte[] key = new byte[32];
        Holds(Prop.ForAll<string, NonNegativeInt[], char>((body, n, c) =>
        {
            var sender = new BridgeAuth.Channel(key, "c2s", "s2c");
            var receiver = new BridgeAuth.Channel(key, "s2c", "c2s");
            string original = body ?? "";
            string sealedFrame = sender.Seal(original).ToJsonString();
            string damaged = Received(Damage(sealedFrame, n, c));
            foreach (string frame in new[] { damaged, sealedFrame })
            {
                JsonNode? node;
                try { node = JsonNode.Parse(frame); }
                catch (JsonException) { continue; } // refused by the connection before the channel
                try
                {
                    string opened = receiver.Open(node);
                    if (opened != original) throw new InvalidOperationException($"altered frame accepted: {frame}");
                }
                catch (AuthException) { /* refused: expected */ }
            }
            // Replayed: never accepted twice.
            try
            {
                receiver.Open(JsonNode.Parse(sealedFrame));
                throw new InvalidOperationException("replayed frame accepted");
            }
            catch (AuthException) { /* refused: expected */ }
        }));
        Holds(Prop.ForAll<int, string[]>((seed, drawn) =>
        {
            var receiver = new BridgeAuth.Channel(key, "s2c", "c2s");
            try { receiver.Open(AnyJson(new Random(seed), Words(drawn, "seq", "body", "mac"))); throw new InvalidOperationException("unsigned frame accepted"); }
            catch (AuthException) { /* refused: expected */ }
        }));
    }

    [Fact]
    public void ADamagedPairingFileIsRefusedNeverMisread()
    {
        string extension = new('a', 32), real = $$"""{"{{extension}}": "{{BridgeAuth.NewNonce()}}"}""";
        string path = _dir["paired-extensions.json"];
        Holds(Prop.ForAll<string, NonNegativeInt[], char>((any, n, c) =>
        {
            foreach (string text in new[] { any ?? "", Damage(real, n, c) })
            {
                File.WriteAllText(path, text, new UTF8Encoding(false));
                try
                {
                    if (new PairingStore(path).KeyFor(extension).Length != 43) throw new InvalidOperationException("short key accepted");
                }
                catch (AuthException) { /* refused: expected */ }
            }
        }), 500);
    }

    // -------------------------------------------------------------------------
    // Paths handed in by an agent: upload, output_path
    // -------------------------------------------------------------------------

    [Fact]
    public void AnyPathIsCheckedWithoutFailing()
    {
        Holds(Prop.ForAll<string, NonNegativeInt[], char>((any, n, c) =>
        {
            foreach (string path in new[] { any ?? "", Damage(@"C:\Users\x\.ssh\id_rsa", n, c), Damage(@"\\?\UNC\localhost\c$\x", n, c) })
            {
                BridgeSecurity.UploadRefusal([path]);
                BridgeSecurity.OutputRefusal(path);
            }
        }), 300);
    }

    [LibraryImport("kernel32.dll", EntryPoint = "GetShortPathNameW", StringMarshalling = StringMarshalling.Utf16)]
    private static unsafe partial uint GetShortPathName(string longPath, char* shortPath, uint size);

    private static string ShortName(string path)
    {
        var buffer = new char[1024];
        uint length;
        unsafe
        {
            fixed (char* text = buffer)
                length = GetShortPathName(path, text, (uint)buffer.Length);
        }
        return length is > 0 and < 1024 ? new string(buffer, 0, (int)length) : path;
    }

    private static void Junction(string link, string target)
    {
        using var mklink = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("cmd.exe", ["/d", "/c", "mklink", "/J", link, target])
        { CreateNoWindow = true, UseShellExecute = false, RedirectStandardOutput = true })!;
        mklink.WaitForExit();
        Assert.True(Directory.Exists(link), "junction not created");
    }

    // One spelling of a folder: case, separators, a device or admin-share prefix, a trailing dot or space, a detour
    // through .., the directory stream (::$INDEX_ALLOCATION), quotes.
    private static string Spell(string folder, int b)
    {
        string text = folder;
        if ((b & 32) != 0) text += "::$INDEX_ALLOCATION";
        else if ((b & 4) != 0) text += (b & 8) != 0 ? " " : ".";
        if ((b & 16) != 0) text += @"\detour\..";
        if ((b & 1) != 0) text = text.ToUpperInvariant();
        if ((b & 64) != 0)
        {
            string drive = text[..1], rest = text[3..];
            text = ((b >> 8) % 4) switch
            {
                0 => @"\\?\" + text,
                1 => $@"\\localhost\{drive}$\{rest}",
                2 => $@"\\127.0.0.1\{drive}$\{rest}",
                _ => $@"\\?\UNC\localhost\{drive}$\{rest}",
            };
        }
        if ((b & 2) != 0) text = text.Replace('\\', '/');
        if ((b & 128) != 0) text = $"\"{text}";
        return text;
    }

    [Fact]
    public void ASecretsFolderIsRefusedHoweverItIsSpelled()
    {
        string ssh = Path.Join(TestEnvironment.Home, ".ssh"), detour = Path.Join(TestEnvironment.Home, "j-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(ssh);
        File.WriteAllText(Path.Join(ssh, "id_rsa"), "key");
        Junction(detour, ssh);
        try
        {
            string[] folders = [.. BridgeSecurity.ProtectedUploadRoots(), ssh, detour, ShortName(ssh)];
            Holds(Prop.ForAll<NonNegativeInt[]>(n =>
            {
                string folder = folders[Nth(n, 0) % folders.Length];
                string path = Spell(folder, Nth(n, 1)) + (Nth(n, 2) % 2 == 0 ? @"\id_rsa" : $@"\f{Nth(n, 3)}.txt");
                if (BridgeSecurity.UploadRefusal([path]) is null) throw new InvalidOperationException($"upload accepted: {path}");
                if (BridgeSecurity.OutputRefusal(path) is null) throw new InvalidOperationException($"output accepted: {path}");
            }), 500);
            Assert.Null(BridgeSecurity.UploadRefusal([Path.Join(TestEnvironment.Home, "work", "f.txt")]));
        }
        finally { Directory.Delete(detour); }
    }

    // Bugs found by this test: the protected roots were compared as written, so a junction on the way
    // (C:\x\link\id_rsa with link -> .ssh), the 8.3 short name (SSH~1) and the directory stream
    // (.ssh::$INDEX_ALLOCATION\id_rsa) all reached a secrets folder; Windows opens each of them as .ssh.
    [Fact]
    public void AJunctionShortNameOrDirectoryStreamIntoSecretsIsRefused()
    {
        string ssh = Path.Join(TestEnvironment.Home, ".ssh"), link = Path.Join(TestEnvironment.Home, "j-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(ssh);
        File.WriteAllText(Path.Join(ssh, "id_rsa"), "key");
        Junction(link, ssh);
        try
        {
            Assert.NotNull(BridgeSecurity.UploadRefusal([Path.Join(link, "id_rsa")]));
            Assert.NotNull(BridgeSecurity.UploadRefusal([ssh + @"::$INDEX_ALLOCATION\id_rsa"]));
            Assert.NotNull(BridgeSecurity.UploadRefusal([Path.Join(ShortName(ssh), "id_rsa")]));
        }
        finally { Directory.Delete(link); }
    }

    // ~\.nexus\build is lifted from the ~\.nexus secrets root only once the path is resolved: a junction inside build
    // back to ~\.nexus (where mcp-token.txt lives) or to ~\.ssh still reaches a secrets folder.
    [Fact]
    public void AJunctionInsideTheNexusBuildFolderBackToSecretsIsRefused()
    {
        string nexus = Path.Join(TestEnvironment.Home, ".nexus"), build = Path.Join(nexus, "build");
        string ssh = Path.Join(TestEnvironment.Home, ".ssh");
        Directory.CreateDirectory(build);
        Directory.CreateDirectory(ssh);
        File.WriteAllText(Path.Join(nexus, "mcp-token.txt"), "token");
        File.WriteAllText(Path.Join(ssh, "id_rsa"), "key");
        string toNexus = Path.Join(build, "j-" + Guid.NewGuid().ToString("N")[..8]);
        string toSsh = Path.Join(build, "j-" + Guid.NewGuid().ToString("N")[..8]);
        Junction(toNexus, nexus);
        Junction(toSsh, ssh);
        try
        {
            Assert.NotNull(BridgeSecurity.UploadRefusal([Path.Join(toNexus, "mcp-token.txt")]));
            Assert.NotNull(BridgeSecurity.UploadRefusal([Path.Join(toSsh, "id_rsa")]));
            Assert.NotNull(BridgeSecurity.UploadRefusal([Path.Join(build, "..", "mcp-token.txt")]));
            Assert.Null(BridgeSecurity.UploadRefusal([Path.Join(build, "x", "paquet.msixupload")]));
        }
        finally { Directory.Delete(toNexus); Directory.Delete(toSsh); }
    }

    private static readonly string[] Runnable =[".exe", ".ps1", ".lnk", ".bat", ".cmd", ".js", ".hta", ".url"];

    [Fact]
    public void ARunnableFileOrAProtectedFolderIsNeverWritten()
    {
        string home = TestEnvironment.Home, own = Path.Join(home, ".nexus", "nexus-browser");
        string[] suffixes = ["2", "-old", ".bak", " copy", "x"];
        Holds(Prop.ForAll<NonNegativeInt[]>(n =>
        {
            string ext = Runnable[Nth(n, 0) % Runnable.Length];
            if (Nth(n, 1) % 2 == 0) ext = ext.ToUpperInvariant();
            ext += (Nth(n, 2) % 4) switch { 0 => "", 1 => ".", 2 => " . ", _ => "::$DATA" };
            string runnable = Path.Join(_dir.Path, "out" + ext);
            if (BridgeSecurity.OutputRefusal(runnable) is null) throw new InvalidOperationException($"runnable output accepted: {runnable}");
            string sibling = own + suffixes[Nth(n, 3) % suffixes.Length] + @"\f.md";
            if (BridgeSecurity.OutputRefusal(sibling) is null) throw new InvalidOperationException($"output beside the engine's folder accepted: {sibling}");
            string lookalike = Path.Join(home, ".aws" + "ome" + suffixes[Nth(n, 3) % suffixes.Length].Trim(), "f.md");
            if (BridgeSecurity.OutputRefusal(lookalike) is { } refusal) throw new InvalidOperationException($"ordinary folder refused: {lookalike} ({refusal})");
        }), 500);
        Assert.Null(BridgeSecurity.OutputRefusal(Path.Join(own, "f.md")));
    }

    // Bugs found by this test: "out.exe::$DATA" writes out.exe yet its extension read ".exe::$data"; and the folder
    // checks compared a bare prefix, so ~\.nexus\nexus-browser2 counted as the engine's own folder (written) while
    // ~\.awsome\ counted as ~\.aws (refused).
    [Fact]
    public void AStreamSuffixOrAPrefixLookalikeNoLongerFoolsTheOutputCheck()
    {
        string home = TestEnvironment.Home;
        Assert.NotNull(BridgeSecurity.OutputRefusal(Path.Join(_dir.Path, "out.exe::$DATA")));
        Assert.NotNull(BridgeSecurity.OutputRefusal(Path.Join(home, ".nexus", "nexus-browser2", "f.md")));
        Assert.Null(BridgeSecurity.OutputRefusal(Path.Join(home, ".awsome", "f.md")));
    }

    // -------------------------------------------------------------------------
    // Web page data: response bodies (json_path), console entries
    // -------------------------------------------------------------------------

    private const string Body = """{"data":{"items":[{"name":"a","n":1},{"name":"b"}],"count":2},"next":null}""";

    [Fact]
    public void AJsonPathOnAnyBodyIsAnAnswerOrAClearErrorWithinItsLimit()
    {
        Holds(Prop.ForAll<string, NonNegativeInt[], char>((any, n, c) =>
        {
            string body = Nth(n, 7) % 3 == 0 ? any ?? "" : Damage((Nth(n, 8) % 2 == 0 ? ")]}'\n" : "") + Body, n, c);
            string path = Nth(n, 9) % 2 == 0 ? any ?? "" : Damage(new[] { "$.data.items[*].name", "data['count']", "$.*", "$.data.items[-1]" }[Nth(n, 10) % 4], n, c);
            int maxBytes = (Nth(n, 11) % 4) switch { 0 => -Nth(n, 12), 1 => Nth(n, 12) % 300, 2 => int.MaxValue, _ => Nth(n, 12) };
            var data = new JsonObject { ["body"] = body, ["mimeType"] = "application/json" };
            try { McpServer.ApplyJsonPath(data, path, maxBytes); }
            catch (ArgumentException ex) when (ex.Message.StartsWith("json_path:", StringComparison.Ordinal) || maxBytes < 0 && ex.Message.StartsWith("max_bytes:", StringComparison.Ordinal)) { return; }
            int limit = maxBytes;
            string kept = (string)data["body"]!;
            if (kept.Length > limit || (bool)data["truncated"]! != (int)data["size"]! > limit)
                throw new InvalidOperationException($"limit {limit} not kept: {kept.Length} characters");
        }));
    }

    // Bug found by this test: a negative max_bytes cut the selected part at a negative length and failed with an index
    // error instead of a clear refusal.
    [Fact]
    public void ANegativeMaxBytesIsAClearError()
    {
        var data = new JsonObject { ["body"] = Body };
        Assert.StartsWith("max_bytes:", Assert.Throws<ArgumentException>(() => McpServer.ApplyJsonPath(data, "$", -1)).Message);
    }

    [Fact]
    public void AnyConsoleEntriesAreFilteredWithinTheirLimitWithoutStacks()
    {
        string[] levels = ["error", "warning", "info", "debug"];
        Holds(Prop.ForAll<int, string[], NonNegativeInt[]>((seed, drawn, n) =>
        {
            var r = new Random(seed);
            string[] words = Words(drawn, "params", "entry", "level", "type", "timestamp", "stackTrace", "error", "warn", "assert", "debug");
            var entries = new JsonArray(Enumerable.Range(0, r.Next(12)).Select(_ => AnyJson(r, words)).ToArray());
            string? level = (Nth(n, 0) % 6) switch { 0 => null, 5 => drawn?.FirstOrDefault(), var k => levels[k - 1] };
            int? limit = Nth(n, 1) % 3 == 0 ? null : Nth(n, 2) % 20 - 5;
            bool stacks = Nth(n, 3) % 2 == 0;
            JsonArray kept;
            try { kept = McpServer.FilterLogs(entries, level, Nth(n, 4) % 2 == 0 ? null : r.Next(), limit, stacks); }
            catch (ArgumentException) when (level is not null && !levels.Contains(level) && level != "log") { return; }
            if (limit is > 0 && kept.Count > limit) throw new InvalidOperationException($"{kept.Count} entries over the limit {limit}");
            foreach (var entry in kept.OfType<JsonObject>())
            {
                if (entry["level"]?.GetValue<string>() is not ("error" or "warning" or "info" or "debug" or "log")) throw new InvalidOperationException("entry without its level");
                if (!stacks && entry["params"] is JsonObject p && (p["stackTrace"] is not null || (p["entry"] as JsonObject)?["stackTrace"] is not null))
                    throw new InvalidOperationException("stack kept");
            }
        }));
    }

    // -------------------------------------------------------------------------
    // Secrets: WebMCP confirmation summary, form check, journal domain
    // -------------------------------------------------------------------------

    private static readonly string[] SecretKeys = ["password", "Passcode", "pin", "otp", "cvv", "card", "cards", "iban", "client_secret", "token", "ssn"];

    [Fact]
    public void ASecretValueNeverReachesTheConfirmationSummary()
    {
        Holds(Prop.ForAll<int, string[]>((seed, drawn) =>
        {
            var r = new Random(seed);
            string secret = "S3cr3t" + r.Next(100000, 999999);
            string[] words = Words(drawn?.Where(w => w is not null && !w.Contains("S3cr3t")).ToArray(), "name", "number", "value", "to");
            var input = AnyJson(r, words) as JsonObject ?? new JsonObject();
            // The secret under a secret key, itself anywhere in the input, possibly wrapped in objects and arrays.
            JsonNode? value = JsonValue.Create(secret);
            for (int wrap = r.Next(4); wrap > 0; wrap--)
                value = r.Next(2) == 0 ? new JsonObject { [words[r.Next(words.Length)] ?? "x"] = value } : new JsonArray(value);
            JsonObject holder = input;
            for (int down = r.Next(3); down > 0; down--) { var inner = new JsonObject(); holder[words[r.Next(words.Length)] + down] = inner; holder = inner; }
            holder[SecretKeys[r.Next(SecretKeys.Length)]] = value;
            string shown = McpServer.MaskWebMcpInput(input)!.ToJsonString();
            if (shown.Contains(secret, StringComparison.Ordinal)) throw new InvalidOperationException($"secret shown: {shown}");
        }));
    }

    // Bug found by this test: only the value right under a secret key was masked; an object or an array of objects under it
    // ({"card":{"number":"4111..."}}, {"password":{"value":"..."}}) showed the card number or the password in the summary.
    [Fact]
    public void ACardObjectUnderASecretKeyIsMaskedWhole()
    {
        var input = JsonNode.Parse("""{"card":{"number":"4111111111111111","exp":"12/30"},"cards":[{"cvc":"123","holder":"J"}],"to":"a@b.c"}""");
        string shown = McpServer.MaskWebMcpInput(input)!.ToJsonString();
        Assert.DoesNotContain("4111", shown);
        Assert.DoesNotContain("12/30", shown);
        Assert.DoesNotContain("\"J\"", shown);
        Assert.Contains("a@b.c", shown);
    }

    [Fact]
    public void AnyPageFormIsCheckedWithoutFailing()
    {
        Holds(Prop.ForAll<int, string[]>((seed, drawn) =>
        {
            var r = new Random(seed);
            string[] words = Words(drawn, "fields", "type", "label", "value", "masked", "form", "formUnknown", "recipients", "attachments", "password", "email");
            var data = AnyJson(r, words) as JsonObject ?? new JsonObject();
            if (r.Next(2) == 0) data["form"] = true;
            if (r.Next(2) == 0) data["fields"] = new JsonArray(Enumerable.Range(0, r.Next(4)).Select(_ => AnyJson(r, words)).ToArray());
            string label = new[] { "Send", "Envoyer", "Submit", "Payer" }[r.Next(4)] + " " + (drawn?.FirstOrDefault() ?? "");
            GardeFous.FormSubmission(label, data);
            GardeFous.OutwardWord(label, drawn?.LastOrDefault());
            GardeFous.ConfirmWord(drawn?.FirstOrDefault(), label);
        }));
    }

    // Bug found by this test: a form field whose type, label or value was not a string (a number, an object) threw
    // instead of being read as text, so the check of the gesture failed instead of answering.
    [Fact]
    public void AFormFieldWithANumberTypeIsRead()
    {
        var data = JsonNode.Parse("""{"form":true,"fields":[{"type":7,"label":{"x":1},"value":42}]}""") as JsonObject;
        Assert.Equal("submit (form with entered data)", GardeFous.FormSubmission("Submit", data));
    }

    [Fact]
    public void AJournalNeverKeepsMoreThanTheDomain()
    {
        Holds(Prop.ForAll<string, string, NonNegativeInt[]>((host, any, n) =>
        {
            const string secret = "S3cr3t";
            string clean = new((host ?? "").Where(ch => !"S3cr3t".Contains(ch)).ToArray());
            string scheme = new[] { "https", "http", "HTTPS", "ftp", "chrome-extension", "data" }[Nth(n, 0) % 6];
            string url = $"{scheme}://{(Nth(n, 1) % 2 == 0 ? $"user:{secret}@" : "")}{clean}{(Nth(n, 2) % 3) switch { 0 => "/" + secret, 1 => "?q=" + secret, _ => "#" + secret }}";
            foreach (string text in new[] { url, any ?? "" })
            {
                string? domain = Journal.Domaine(text);
                if (domain is not null && (domain.Contains(secret, StringComparison.Ordinal) || !Only(domain, ch => char.IsAsciiLetterLower(ch) || char.IsAsciiDigit(ch) || ch is '.' or '-' or '+')))
                    throw new InvalidOperationException($"journal domain «{domain}» for {text}");
            }
        }));
        Holds(Prop.ForAll<int, string[]>((seed, drawn) =>
            Journal.Issue(AnyJson(new Random(seed), Words(drawn, "status", "error", "data", "dialogOpened", "changed", "already", "verified", "trusted_click", "accord_required")) as JsonObject, false)));
    }

    // Bug found by this test: an answer whose error or status was not a string threw while its journal line was written,
    // and the line was lost.
    [Fact]
    public void AJournalIssueOfAnAnswerWithANumberErrorIsKept()
    {
        Assert.Equal("✗", Journal.Issue(JsonNode.Parse("""{"status":"error","error":500}""") as JsonObject, false));
    }

    // -------------------------------------------------------------------------
    // JSON-RPC requests of the agents
    // -------------------------------------------------------------------------

    private static readonly string[] Requests =
    [
        """{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"x","version":"1"}}}""",
        """{"jsonrpc":"2.0","id":"a","method":"tools/list"}""",
        """{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":3}}""",
        """{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"browser_list_tabs","arguments":{}}}""",
        """{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"browser_logs","arguments":{"tab_id":7,"level":"error","limit":5}}}""",
        """{"jsonrpc":"2.0","id":4,"method":"ping"}""",
    ];

    // A JSON-RPC 2.0 request or notification: an object, jsonrpc "2.0", a string method, an id that is a string, a number or absent.
    private static bool WellFormed(string line, out bool notification, out JsonNode? id)
    {
        notification = false;
        id = null;
        try
        {
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return false;
            var names = root.EnumerateObject().Select(p => p.Name).ToList();
            if (names.Count != names.Distinct(StringComparer.Ordinal).Count()) return false;
            if (!root.TryGetProperty("jsonrpc", out var version) || version.ValueKind != JsonValueKind.String || version.GetString() != "2.0") return false;
            if (!root.TryGetProperty("method", out var method) || method.ValueKind != JsonValueKind.String) return false;
            if (!root.TryGetProperty("id", out var given) || given.ValueKind == JsonValueKind.Null) { notification = true; return true; }
            id = JsonNode.Parse(given.GetRawText());
            return given.ValueKind is JsonValueKind.String or JsonValueKind.Number;
        }
        catch (JsonException) { return false; }
    }

    [Fact]
    public async Task AnyJsonRpcLineIsAnsweredAndAnInvalidOneIsRefused()
    {
        using var session = new EngineSession((action, _) => action == "list-tabs" ? new JsonArray() : new JsonObject());
        var lines = new List<string>();
        Holds(Prop.ForAll<string, NonNegativeInt[], char>((any, n, c) =>
        {
            lines.Add(Received(any ?? ""));
            lines.Add(Received(Damage(Requests[Nth(n, 7) % Requests.Length], n, c)));
        }), 300);
        Holds(Prop.ForAll<int, string[]>((seed, drawn) =>
            lines.Add(Received(AnyJson(new Random(seed), Words(drawn, "jsonrpc", "2.0", "id", "method", "params", "initialize", "tools/list", "ping", "name", "arguments"))?.ToJsonString() ?? "null"))), 300);
        foreach (string line in lines)
        {
            var response = await session.Server.HandleJsonRpcLineAsync(line, session.Identity, Environment.ProcessId, TestContext.Current.CancellationToken);
            bool valid = WellFormed(line, out bool notification, out var id);
            if (response is null)
            {
                Assert.True(valid && notification, $"no answer to {line}");
                continue;
            }
            Assert.Equal("2.0", response["jsonrpc"]?.GetValue<string>());
            Assert.True(response.ContainsKey("result") ^ response.ContainsKey("error"), $"result or error for {line}: {response.ToJsonString()}");
            if (response.ContainsKey("result"))
            {
                Assert.True(valid && !notification, $"invalid request accepted: {line} -> {response.ToJsonString()}");
                Assert.True(JsonNode.DeepEquals(id, response["id"]), $"id changed for {line}");
            }
        }
    }

    // Bugs found by this test: a request without jsonrpc "2.0", with an object, array or boolean id, or with a method that
    // is not a string was run or left unanswered instead of refused (Invalid Request), a JSON value that is not an object
    // was left unanswered, and a repeated name threw out of the dispatcher (now a parse error).
    [Theory]
    [InlineData("""{"id":1,"method":"tools/list"}""", -32600)]
    [InlineData("""{"jsonrpc":"1.0","id":1,"method":"tools/list"}""", -32600)]
    [InlineData("""{"jsonrpc":"2.0","id":{"a":1},"method":"tools/list"}""", -32600)]
    [InlineData("""{"jsonrpc":"2.0","id":true,"method":"ping"}""", -32600)]
    [InlineData("""{"jsonrpc":"2.0","id":1,"method":7}""", -32600)]
    [InlineData("[1]", -32600)]
    [InlineData("7", -32600)]
    [InlineData("""{"jsonrpc":"2.0","id":1,"id":2,"method":"ping"}""", -32700)]
    public async Task AnInvalidJsonRpcRequestIsRefused(string line, int code)
    {
        using var session = new EngineSession((_, _) => new JsonObject());
        var response = await session.Server.HandleJsonRpcLineAsync(line, session.Identity, Environment.ProcessId, TestContext.Current.CancellationToken);
        Assert.NotNull(response);
        Assert.Equal(code, (int)response["error"]!["code"]!);
        Assert.False(response.ContainsKey("result"));
    }

    // Bug found while reading the HTTP path next to this test: a body that is not JSON, or whose method is not a string,
    // threw before the dispatcher and the connection was dropped without an answer; it now gets the JSON-RPC error.
    [Fact]
    public async Task AnHttpBodyThatIsNotJsonGetsAParseError()
    {
        using var bridge = new FakeBridge((_, _) => new JsonObject());
        using var daemon = await Daemon.StartAsync(bridge, _dir);
        using (var response = await daemon.SendAsync(HttpMethod.Post, "codex", "{not json"))
        {
            Assert.Equal(System.Net.HttpStatusCode.OK, response.StatusCode);
            Assert.Equal(-32700, (int)JsonNode.Parse(await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken))!["error"]!["code"]!);
        }
        using (var response = await daemon.SendAsync(HttpMethod.Post, "codex", """{"jsonrpc":"2.0","id":1,"method":5}"""))
            Assert.Equal(-32600, (int)JsonNode.Parse(await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken))!["error"]!["code"]!);
    }
}
