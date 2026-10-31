using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace NexusBrowser.Native;

/// <summary>
/// Smaller answers for the read tools: output_path (the payload written to a file, only its path, size and an excerpt
/// returned, like Chrome DevTools MCP and Playwright MCP), json_path on a response body (blueprint-mcp), console filters
/// and the page changes after an action (include_changes).
/// </summary>
public sealed partial class McpServer
{
    // Excerpt of a payload written to output_path (the golden ratio, in characters).
    private const int OutputExcerptChars = 618;
    // Whole body asked from the extension when json_path or output_path needs it (its own cap).
    private const int WholeBodyBytes = 5 * 1024 * 1024;

    private static readonly Dictionary<string, int> LogSeverity = new(StringComparer.Ordinal)
    {
        ["debug"] = 0, ["log"] = 1, ["info"] = 1, ["warning"] = 2, ["error"] = 3,
    };

    /// <summary>Severity of a console entry: Runtime.consoleAPICalled type or Log.entryAdded level.</summary>
    internal static string LogLevel(JsonObject entry)
    {
        var p = entry["params"] as JsonObject;
        string raw = (GetString(p?["entry"] as JsonObject ?? new JsonObject(), "level") ?? GetString(p ?? new JsonObject(), "type") ?? "log").ToLowerInvariant();
        return raw switch
        {
            "error" or "assert" => "error",
            "warning" or "warn" => "warning",
            "info" => "info",
            "debug" or "verbose" or "trace" => "debug",
            _ => "log",
        };
    }

    /// <summary>
    /// Console entries kept by level (that severity and above), since a timestamp (ms), the last limit ones; every entry
    /// says its level, and the call stacks are dropped unless include_stack.
    /// </summary>
    internal static JsonArray FilterLogs(JsonArray entries, string? level, long? sinceMs, int? limit, bool includeStack)
    {
        if (level is not null && !LogSeverity.ContainsKey(level))
            throw new ArgumentException($"level: one of error, warning, info, debug (not {level})");
        int floor = level is null ? 0 : LogSeverity[level];
        var kept = new List<JsonObject>();
        foreach (var entry in entries.OfType<JsonObject>())
        {
            var copy = (JsonObject)entry.DeepClone();
            string severity = LogLevel(copy);
            if (LogSeverity[severity] < floor) continue;
            if (sinceMs.HasValue && copy["timestamp"] is JsonValue ts && ts.TryGetValue<double>(out double at) && at < sinceMs.Value) continue;
            copy["level"] = severity;
            if (!includeStack && copy["params"] is JsonObject p)
            {
                p.Remove("stackTrace");
                (p["entry"] as JsonObject)?.Remove("stackTrace");
            }
            kept.Add(copy);
        }
        if (limit is > 0 && kept.Count > limit.Value) kept = kept[^limit.Value..];
        return new JsonArray([.. kept]);
    }

    /// <summary>
    /// Part of a JSON document named by a path: $.a.b[0], a['b c'], [*] and .* (every item: an array of matches).
    /// </summary>
    internal static JsonNode? JsonPathSelect(JsonNode? root, string path)
    {
        string p = path.Trim();
        if (p.StartsWith('$')) p = p[1..];
        var current = new List<JsonNode?> { root };
        bool wildcard = false;
        int i = 0;
        while (i < p.Length)
        {
            string? key = null;
            int? index = null;
            bool all = false;
            if (p[i] == '.')
            {
                i++;
                if (i < p.Length && p[i] == '*') { all = true; i++; }
                else
                {
                    int start = i;
                    while (i < p.Length && p[i] != '.' && p[i] != '[') i++;
                    key = p[start..i];
                    if (key.Length == 0) throw new ArgumentException($"json_path: empty name in {path}");
                }
            }
            else if (p[i] == '[')
            {
                int close = p.IndexOf(']', i);
                if (close < 0) throw new ArgumentException($"json_path: missing ] in {path}");
                string inner = p[(i + 1)..close].Trim();
                i = close + 1;
                if (inner == "*") all = true;
                else if (inner.Length >= 2 && (inner[0] is '\'' or '"') && inner[^1] == inner[0]) key = inner[1..^1];
                else if (int.TryParse(inner, NumberStyles.Integer, CultureInfo.InvariantCulture, out int n)) index = n;
                else throw new ArgumentException($"json_path: [{inner}] is neither an index, a quoted name nor * in {path}");
            }
            else if (i == 0)
            {
                // A path without $ nor a leading dot: "data.items[0]".
                p = "." + p;
                continue;
            }
            else throw new ArgumentException($"json_path: unexpected '{p[i]}' at {i} in {path}");

            var next = new List<JsonNode?>();
            foreach (var node in current)
            {
                if (all)
                {
                    if (node is JsonArray arr) next.AddRange(arr);
                    else if (node is JsonObject obj) next.AddRange(obj.Select(kv => kv.Value));
                }
                else if (key is not null && node is JsonObject obj && obj.TryGetPropertyValue(key, out var child)) next.Add(child);
                else if (index is int n && node is JsonArray arr && (n < 0 ? n + arr.Count : n) is int at && at >= 0 && at < arr.Count) next.Add(arr[at]);
            }
            wildcard |= all;
            current = next;
            if (current.Count == 0) throw new ArgumentException($"json_path: nothing at {path}");
        }
        return wildcard ? new JsonArray([.. current.Select(n => n?.DeepClone())]) : current[0]?.DeepClone();
    }

    /// <summary>
    /// json_path on a masked text body: the selected part, as JSON text (an anti-XSSI prefix such as Google's is
    /// skipped). The body was masked by the extension first, so a secret never comes back through a path.
    /// </summary>
    internal static void ApplyJsonPath(JsonObject data, string jsonPath, int maxBytes)
    {
        if (GetBool(data, "binary", false)) throw new ArgumentException("json_path: the body is binary, not JSON");
        if (GetBool(data, "truncated", false)) throw new ArgumentException($"json_path: body larger than {WholeBodyBytes / (1024 * 1024)} MB, it cannot be read whole");
        string body = GetString(data, "body") ?? "";
        var prefix = Regex.Match(body, @"^(\)\]\}'[^\n]*\n?|for\s*\(;;\);|while\s*\(1\);)");
        JsonNode? document;
        try { document = JsonNode.Parse(body[prefix.Length..]); }
        catch (JsonException) { throw new ArgumentException($"json_path: the body is not JSON ({GetString(data, "mimeType") ?? "unknown type"})"); }
        var selected = JsonPathSelect(document, jsonPath);
        string text = selected is null ? "null" : selected.ToJsonString(CompactJson);
        data["json_path"] = jsonPath;
        if (selected is JsonArray matches && Regex.IsMatch(jsonPath, @"\*")) data["matches"] = matches.Count;
        data["size"] = text.Length;
        data["truncated"] = text.Length > maxBytes;
        data["body"] = text.Length > maxBytes ? text[..maxBytes] : text;
    }

    /// <summary>Absolute path of output_path; a relative one is refused (the engine's folder is not the agent's).</summary>
    internal static string OutputFile(string outputPath)
    {
        if (!Path.IsPathFullyQualified(outputPath)) throw new ArgumentException($"output_path must be an absolute path (not {outputPath})");
        return Path.GetFullPath(outputPath);
    }

    private static async Task<long> WriteOutputAsync(string destination, byte[] content, CancellationToken ct)
    {
        if (Path.GetDirectoryName(destination) is { Length: > 0 } dir) Directory.CreateDirectory(dir);
        string temporary = destination + $".{Guid.NewGuid():N}.tmp";
        try { await File.WriteAllBytesAsync(temporary, content, ct); File.Move(temporary, destination, overwrite: true); }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
        return content.Length;
    }

    /// <summary>The field's text written to output_path, replaced in the answer by output_path, size_bytes and excerpt.</summary>
    internal static async Task MoveToOutputAsync(JsonObject data, string field, string text, string outputPath, CancellationToken ct, byte[]? bytes = null)
    {
        string destination = OutputFile(outputPath);
        data["size_bytes"] = await WriteOutputAsync(destination, bytes ?? Encoding.UTF8.GetBytes(text), ct);
        data.Remove(field);
        data["output_path"] = destination;
        if (bytes is null) data["excerpt"] = text.Length > OutputExcerptChars ? text[..OutputExcerptChars] : text;
    }

    /// <summary>
    /// Answer of a read tool reshaped after the call: console filters, json_path, then output_path. A failed answer is
    /// returned as it is.
    /// </summary>
    private static async Task<string> ShapeReadAnswerAsync(string name, JsonObject args, string answer, CancellationToken ct)
    {
        if (name is not ("browser_logs" or "browser_network_response" or "browser_axtree" or "browser_export" or "browser_export_gsuite"))
            return answer;
        if (JsonNode.Parse(answer) is not JsonObject envelope || GetString(envelope, "status") != "success") return answer;
        string? outputPath = GetString(args, "output_path");
        try
        {
            if (outputPath is not null) OutputFile(outputPath);
            switch (name)
            {
                case "browser_logs":
                {
                    if (envelope["data"] is not JsonArray entries) return answer;
                    long? since = args["since_ms"] is JsonValue s && s.TryGetValue<long>(out long ms) ? ms : null;
                    var kept = FilterLogs(entries, GetString(args, "level"), since, TryGetInt(args, "limit"), GetBool(args, "include_stack", false));
                    if (outputPath is null) { envelope["data"] = kept; break; }
                    var data = new JsonObject { ["count"] = kept.Count };
                    await MoveToOutputAsync(data, "entries", kept.ToJsonString(CompactJson), outputPath, ct);
                    envelope["data"] = data;
                    break;
                }
                case "browser_network_response":
                {
                    if (envelope["data"] is not JsonObject data || GetBool(data, "dialogOpened", false)) return answer;
                    int maxBytes = GetInt(args, "max_bytes", 65536);
                    if (GetString(args, "json_path") is { Length: > 0 } jsonPath)
                        ApplyJsonPath(data, jsonPath, outputPath is null ? maxBytes : WholeBodyBytes);
                    if (outputPath is null || GetString(data, "body") is not { } body) break;
                    bool binary = GetBool(data, "binary", false);
                    await MoveToOutputAsync(data, "body", body, outputPath, ct, binary ? Convert.FromBase64String(PadBase64(body)) : null);
                    break;
                }
                case "browser_axtree":
                {
                    if (outputPath is null || envelope["data"] is not JsonObject data || GetBool(data, "dialogOpened", false)) break;
                    if (GetString(data, "snapshot") is { } snapshot) await MoveToOutputAsync(data, "snapshot", snapshot, outputPath, ct);
                    else if (GetString(data, "changes") == "diff")
                    {
                        string diff = "added:\n" + GetString(data, "added") + "\nremoved:\n" + GetString(data, "removed");
                        data.Remove("added");
                        await MoveToOutputAsync(data, "removed", diff, outputPath, ct);
                    }
                    else if (data["nodes"] is JsonArray nodes) await MoveToOutputAsync(data, "nodes", nodes.ToJsonString(CompactJson), outputPath, ct);
                    break;
                }
                case "browser_export":
                {
                    if (outputPath is null || envelope["data"] is not JsonObject data || GetString(data, "content") is not { } content) break;
                    await MoveToOutputAsync(data, "content", content, outputPath, ct);
                    break;
                }
                case "browser_export_gsuite":
                {
                    if (outputPath is null || envelope["data"] is not JsonObject data || GetBool(data, "dialogOpened", false)) break;
                    string destination = OutputFile(outputPath);
                    if (GetString(data, "output_path") is { } written && File.Exists(written))
                    {
                        // Binary, or text longer than max_chars: the whole file already on disk, moved to output_path.
                        if (Path.GetDirectoryName(destination) is { Length: > 0 } dir) Directory.CreateDirectory(dir);
                        File.Move(written, destination, overwrite: true);
                        data["output_path"] = destination;
                        data["size_bytes"] = new FileInfo(destination).Length;
                        data.Remove("note");
                        if (GetString(data, "text") is { } cut) { data.Remove("text"); data["excerpt"] = cut.Length > OutputExcerptChars ? cut[..OutputExcerptChars] : cut; }
                    }
                    else if (GetString(data, "text") is { } text) await MoveToOutputAsync(data, "text", text, outputPath, ct);
                    break;
                }
            }
        }
        catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException or FormatException)
        {
            return ErrorJson(ex.Message);
        }
        return envelope.ToJsonString(CompactJson);
    }

    private static string PadBase64(string text) => text.Length % 4 == 0 ? text : text[..(text.Length - text.Length % 4)];

    /// <summary>
    /// The page changes after an action (include_changes): network settled briefly, then the snapshot diff against
    /// this tab's previous browser_axtree snapshot, as browser_axtree(mode="snapshot", changes_only=True) returns it.
    /// </summary>
    private async Task<string> WithChangesAsync(string answer, int tabId, (string Agent, string Id) identity, int? pid, CancellationToken ct)
    {
        if (JsonNode.Parse(answer) is not JsonObject envelope || GetString(envelope, "status") != "success") return answer;
        try
        {
            await CallBridgeRawAsync("wait-network-idle", new JsonObject { ["tab_id"] = tabId, ["idleMs"] = 200, ["timeoutMs"] = 1618 }, 5.0, identity, pid, ct);
        }
        catch (Exception ex) when (Boundary.Recoverable(ex))
        {
            // Deliberate boundary: a page still busy is diffed as it is
        }
        var p = new JsonObject { ["tab_id"] = tabId, ["mode"] = "snapshot", ["maxLines"] = 400, ["changesOnly"] = true };
        var snap = JsonNode.Parse(await CallBridgeFormattedAsync("axtree", p, 20.0, identity, pid, checkPageNote: true, ct: ct)) as JsonObject;
        if (snap is null || GetString(snap, "status") != "success" || snap["data"] is not JsonObject data)
        {
            envelope["changes_error"] = snap is null ? "unreadable snapshot" : GetString(snap, "error") ?? "snapshot failed";
            return envelope.ToJsonString(CompactJson);
        }
        var changes = new JsonObject();
        foreach (string key in new[] { "changes", "added", "removed", "snapshot" })
            if (data[key] is { } value) changes[key] = value.DeepClone();
        envelope["changes"] = changes;
        if (GetString(snap, "untrusted_note") is { } note && envelope["untrusted_note"] is null) envelope["untrusted_note"] = note;
        return envelope.ToJsonString(CompactJson);
    }
}
