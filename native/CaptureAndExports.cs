using System.Collections.Concurrent;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using SkiaSharp;

namespace NexusBrowser.Native;

public sealed partial class McpServer
{
    private const int MaxImageSide = 2000, MaxImagePixels = 2_560_000, MaxImageBytes = 500_000;
    private sealed record SentCapture(string Geometry, byte[] Fingerprint, long SentAt);
    private sealed record ViewCapture(double Factor, double Dpr, int Width, int Height);
    private readonly ConcurrentDictionary<(string Session, int Tab, string Target), SentCapture> _sentCaptures = new();
    private readonly ConcurrentDictionary<(string Session, int Tab), ViewCapture> _viewCaptures = new();

    private async Task<string> ExecuteCaptureToolAsync(string name, JsonObject args,
        (string Agent, string Id) identity, int? pid, CancellationToken ct)
    {
        var p = RequireTabParams(args);
        int tab = p["tab_id"]!.GetValue<int>();
        bool vision = name == "browser_vision_inspect", inline = GetBool(args, "inline", false);
        string? selector = GetString(args, "selector");
        int? mark = TryGetInt(args, "mark");
        bool full = GetBool(args, "full_page", false);
        if (!vision)
        {
            if (inline && full && mark is null && string.IsNullOrEmpty(selector))
                return ErrorJson("full_page with inline=True refused (image too large): write it to a file");
            if (args["region"] is { } region)
            {
                if (!string.IsNullOrEmpty(selector) || mark.HasValue || full)
                    return ErrorJson("region cannot be combined with selector, mark or full_page");
                if (region is not JsonArray a || a.Count != 4 || a.Any(n => n is not JsonValue v || !v.TryGetValue<double>(out var d) || !double.IsFinite(d)))
                    return ErrorJson("region: [x1, y1, x2, y2] in pixels of the last whole-view image");
                double x1 = Number(a[0]), y1 = Number(a[1]), x2 = Number(a[2]), y2 = Number(a[3]);
                if (x2 <= x1 || y2 <= y1) return ErrorJson("region: x2 must be greater than x1 and y2 greater than y1");
                if (!_viewCaptures.TryGetValue((identity.Id, tab), out var view))
                    return ErrorJson("region needs a whole-view image of this tab first: browser_screenshot(inline=True)");
                double width = (x2 - x1) * view.Factor, height = (y2 - y1) * view.Factor;
                double fit = Math.Min(MaxImageSide / (Math.Max(width, height) * view.Dpr), Math.Sqrt(MaxImagePixels / (width * height)) / view.Dpr);
                p["region"] = new JsonObject { ["x"] = x1 * view.Factor, ["y"] = y1 * view.Factor, ["width"] = width, ["height"] = height };
                p["scale"] = Math.Round(Math.Clamp(fit, .25, 4), 4);
            }
            else if (mark.HasValue) p["selector"] = $"#{mark}";
            else if (!string.IsNullOrEmpty(selector)) p["selector"] = selector;
            else if (full) p["fullPage"] = true;
        }
        string action = vision ? "vision-inspect" : "screenshot";
        if (!inline)
        {
            p["output"] = GetString(args, "output_path") ?? DefaultCapturePath(vision ? "vision" : "browser");
            return await CallBridgeFormattedAsync(action, p, 20, identity, pid, ct: ct);
        }
        var data = await CallBridgeRawAsync(action, p, 20, identity, pid, ct) as JsonObject;
        if (data is null) return ErrorJson("Unexpected capture answer");
        if (GetBool(data, "dialogOpened", false))
            return new JsonObject { ["status"] = "error", ["error"] = GetString(data, "message") ?? "A dialog interrupted the page.", ["dialogOpened"] = true, ["data"] = data }.ToJsonString(CompactJson);
        string key = vision ? "screenshotDataUrl" : "dataUrl";
        string encoded = GetString(data, key) ?? throw new InvalidDataException("Capture answer has no image");
        byte[] input = Convert.FromBase64String(encoded[(encoded.IndexOf(',') + 1)..]);
        data.Remove(key); data.Remove("mimeType");
        using var header = SKCodec.Create(SKData.CreateCopy(input)) ?? throw new InvalidDataException("Invalid capture image");
        var info = header.Info;
        if ((long)info.Width * info.Height > 40_000_000)
            return ErrorJson($"Capture too large to attach ({info.Width}x{info.Height} px): write it to a file (inline=False).");
        using var source = SKBitmap.Decode(input) ?? throw new InvalidDataException("Invalid capture image");
        double scale = Math.Min(1, Math.Min((double)MaxImageSide / Math.Max(source.Width, source.Height), Math.Sqrt((double)MaxImagePixels / ((double)source.Width * source.Height))));
        byte[] webp; string encoding; int widthOut, heightOut; byte[] fingerprint;
        while (true)
        {
            widthOut = Math.Max(1, (int)Math.Floor(source.Width * scale));
            heightOut = Math.Max(1, (int)Math.Floor(source.Height * scale));
            using var image = source.Resize(new SKImageInfo(widthOut, heightOut), new SKSamplingOptions(SKFilterMode.Linear, SKMipmapMode.Linear)) ?? throw new InvalidDataException("Capture resize failed");
            webp = EncodeWebp(image, null); encoding = "lossless";
            foreach (int quality in new[] { 90, 80, 70, 55, 40 })
            {
                if (webp.Length <= MaxImageBytes) break;
                webp = EncodeWebp(image, quality); encoding = $"quality {quality}";
            }
            if (webp.Length <= MaxImageBytes)
            {
                using var gray = image.Resize(new SKImageInfo(64, 64), new SKSamplingOptions(SKFilterMode.Linear)) ?? throw new InvalidDataException("Capture fingerprint failed");
                fingerprint = new byte[64 * 64];
                for (int y = 0; y < 64; y++) for (int x = 0; x < 64; x++) { var pixel = gray.GetPixel(x, y); fingerprint[y * 64 + x] = (byte)((pixel.Red * 299 + pixel.Green * 587 + pixel.Blue * 114) / 1000); }
                break;
            }
            if (Math.Min(widthOut, heightOut) <= 1) return ErrorJson("Capture cannot fit the 500 KB inline image limit");
            scale *= .8;
        }
        var clip = data["clip"] as JsonObject;
        double dpr = Number(data["devicePixelRatio"]), zoom = Number(data["zoom"]);
        if (zoom <= 0) zoom = 1;
        if (dpr > 0 && clip is not null && Number(clip["scale"]) > 0) dpr *= Number(clip["scale"]);
        double? cssPerSource = dpr > 0 ? 1 / dpr : null;
        var origin = new JsonObject { ["x"] = 0, ["y"] = 0 };
        if (clip is not null && Number(clip["width"]) > 0)
        {
            cssPerSource ??= Number(clip["width"]) / zoom / source.Width;
            origin["x"] = Math.Round(Number(clip["x"]) / zoom, 3); origin["y"] = Math.Round(Number(clip["y"]) / zoom, 3);
        }
        double? factor = cssPerSource / scale;
        var meta = new JsonObject { ["format"] = "webp", ["encoding"] = encoding, ["bytes"] = webp.Length,
            ["width"] = widthOut, ["height"] = heightOut, ["source_width"] = source.Width, ["source_height"] = source.Height, ["scale"] = Math.Round(scale, 6) };
        if (factor.HasValue) { meta["css_origin"] = origin; meta["css_per_image_px"] = Math.Round(factor.Value, 6); }
        data["image"] = meta;
        if (factor is > 0 && data["markers"] is JsonArray markers)
            foreach (var (marker, r) in markers.OfType<JsonObject>().Select(m => (m, m["rect"] as JsonObject)).Where(p => p.Item2 is not null))
                {
                    double x = (Number(r!["x"]) - Number(origin["x"])) / factor.Value, y = (Number(r["y"]) - Number(origin["y"])) / factor.Value;
                    marker["image_box"] = new JsonArray(Math.Round(x), Math.Round(y), Math.Round(x + Number(r["width"]) / factor.Value), Math.Round(y + Number(r["height"]) / factor.Value));
                }
        string target = vision ? "vision" : new JsonArray(p["selector"]?.DeepClone(), p["fullPage"]?.DeepClone(), p["region"]?.DeepClone(), p["scale"]?.DeepClone()).ToJsonString();
        var printKey = (identity.Id, tab, target);
        string geometry = $"{widthOut}:{heightOut}:{factor}:{origin.ToJsonString()}:{dpr}";
        if (!GetBool(args, "force", false) && _sentCaptures.TryGetValue(printKey, out var previous) && previous.Geometry == geometry &&
            previous.Fingerprint.Length == fingerprint.Length && !previous.Fingerprint.Where((b, i) => Math.Abs(b - fingerprint[i]) > 2).Any())
        {
            meta["unchanged"] = true;
            data["note"] = "Image unchanged since the last one sent for this tab and target: not attached again (force=True to resend it).";
        }
        else
        {
            _imageBlocks.Value?.Add(new JsonObject { ["type"] = "image", ["mimeType"] = "image/webp", ["data"] = Convert.ToBase64String(webp) });
            _sentCaptures[printKey] = new SentCapture(geometry, fingerprint, Environment.TickCount64);
            if (factor is > 0 && clip is null) _viewCaptures[(identity.Id, tab)] = new ViewCapture(factor.Value, dpr > 0 ? dpr : 1, widthOut, heightOut);
            while (_sentCaptures.Count > 512) _sentCaptures.TryRemove(_sentCaptures.MinBy(x => x.Value.SentAt).Key, out _);
            while (_viewCaptures.Count > 512) _viewCaptures.TryRemove(_viewCaptures.First().Key, out _);
        }
        return new JsonObject { ["status"] = "success", ["data"] = data }.ToJsonString(CompactJson);
    }

    private static byte[] EncodeWebp(SKBitmap image, int? quality)
    {
        using var pixels = image.PeekPixels();
        using var encoded = pixels.Encode(new SKWebpEncoderOptions(quality.HasValue ? SKWebpEncoderCompression.Lossy : SKWebpEncoderCompression.Lossless, quality ?? 100)) ?? throw new InvalidDataException("WebP encoding failed");
        return encoded.ToArray();
    }

    private static async Task<string> WriteExportAsync(byte[] content, JsonObject data, CancellationToken ct)
    {
        string extension = Regex.Replace(GetString(data, "extension") ?? "bin", "[^a-zA-Z0-9]", "").ToLowerInvariant();
        if (extension.Length > 8) extension = extension[..8];
        if (extension.Length == 0) extension = "bin";
        string filename = (GetString(data, "filename") ?? GetString(data, "title") ?? GetString(data, "document_id") ?? "google").Replace('\\', '/');
        string stem = Regex.Replace(Path.GetFileNameWithoutExtension(filename), "[<>:\"/\\\\|?*\\x00-\\x1f]+", "_").Trim(' ', '.', '_');
        if (stem.Length > 100) stem = stem[..100];
        if (stem.Length == 0) stem = "export";
        string directory = Path.Join(BridgeSecurity.DefaultDataDir(), "exports"); Directory.CreateDirectory(directory);
        string destination = Path.Join(directory, $"{stem}_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}_{Guid.NewGuid():N}.{extension}");
        string temporary = destination + ".tmp";
        try { await File.WriteAllBytesAsync(temporary, content, ct); File.Move(temporary, destination); }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
        return destination;
    }

    private async Task<JsonNode?> FinishGsuiteExportAsync(JsonNode? value, int maxChars, CancellationToken ct)
    {
        if (value is not JsonObject data) return value;
        byte[]? downloaded = null;
        if (GetString(data, "download_path") is { Length: > 0 } source)
        {
            source = Path.GetFullPath(source);
            if (Path.GetFileName(Path.GetDirectoryName(source)) != "nexus-browser-exports" || !File.Exists(source))
                throw new InvalidDataException("Unexpected export download (outside the nexus-browser-exports folder)");
            downloaded = await File.ReadAllBytesAsync(source, ct);
            File.Delete(source); data.Remove("download_path");
        }
        if (GetBool(data, "binary", false))
        {
            byte[] content = downloaded ?? Convert.FromBase64String(GetString(data, "base64") ?? "");
            if (content.Length == 0) throw new InvalidDataException("Empty Google export: no bytes received.");
            data.Remove("base64"); data["output_path"] = await WriteExportAsync(content, data, ct); data["size_bytes"] = content.Length;
        }
        else
        {
            string text = downloaded is null ? GetString(data, "text") ?? "" : Encoding.UTF8.GetString(downloaded).TrimStart('\uFEFF');
            int limit = Math.Max(1, maxChars); data["total_chars"] = text.Length;
            data["text"] = text.Length > limit ? text[..limit] : text; data["truncated"] = text.Length > limit;
            if (text.Length > limit)
            {
                data["output_path"] = await WriteExportAsync(Encoding.UTF8.GetBytes(text), data, ct);
                data["note"] = $"Text truncated to {limit} characters; full document written to output_path.";
            }
        }
        return data;
    }
}
