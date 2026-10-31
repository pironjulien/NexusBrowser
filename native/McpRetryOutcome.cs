using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace NexusBrowser.Native;

/// <summary>
/// Whether a failed call is safe to resend: an agent reads retry_safe and outcome instead of guessing from the error
/// text (like agent-browser's outcome_unknown).
/// </summary>
public sealed partial class McpServer
{
    // A failure before anything reached the page: resending once fixed is safe (outcome "not_done").
    internal static readonly Regex NotDoneError = new(
        @"nothing was (sent|done)|no mouse action sent|no command was sent|element not found|no element (matches|registered|with text|has focus)|ambiguous locator|out of range|frame of mark #\d+ is gone|mark #\d+ is stale|is covered by|is not reachable|refused|^(invalid tool arguments|unknown tool)|no chrome browser extension connected|cannot reach the nexusbrowser bridge",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    // A failure after the command left: it may have acted, so it is never resent blindly (outcome "unknown").
    internal static readonly Regex UnknownOutcomeError = new(
        @"timed out after|may have run|disconnected while processing|cancelled while running",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>
    /// Adds to a failed answer retry_safe and, for a tool that changes the page, outcome: "not_done" (nothing reached
    /// the page), "unknown" (it may have acted: check the page before resending) or "partial" (a batch stopped after
    /// earlier steps ran). A tool its descriptor marks idempotent is always safe to resend. An error matching neither
    /// list is left as it is: no guess.
    /// </summary>
    internal static string WithOutcome(string answer, bool idempotent)
    {
        if (JsonNode.Parse(answer) is not JsonObject failure || GetString(failure, "status") != "error") return answer;
        if (failure["steps"] is JsonArray steps && TryGetInt(failure, "stopped_at") is int stoppedAt)
        {
            if (stoppedAt > 0)
            {
                failure["outcome"] = "partial";
                failure["retry_safe"] = false;
                failure["note"] = $"Steps 0 to {stoppedAt - 1} ran: resend only the steps from {stoppedAt} once fixed.";
            }
            else if (steps.Count > 0 && steps[^1]?["result"] is JsonObject last && last["outcome"] is { } stepOutcome)
            {
                failure["outcome"] = stepOutcome.DeepClone();
                failure["retry_safe"] = last["retry_safe"]?.DeepClone();
            }
            return failure.ToJsonString(CompactJson);
        }
        if (idempotent)
        {
            failure["retry_safe"] = true;
            return failure.ToJsonString(CompactJson);
        }
        string error = GetString(failure, "error") ?? "";
        if (UnknownOutcomeError.IsMatch(error))
        {
            failure["outcome"] = "unknown";
            failure["retry_safe"] = false;
        }
        else if (NotDoneError.IsMatch(error) || GetBool(failure, "accord_required", false))
        {
            failure["outcome"] = "not_done";
            failure["retry_safe"] = true;
        }
        else return answer;
        return failure.ToJsonString(CompactJson);
    }

    private static bool IsIdempotentTool(string name) =>
        EmbeddedTools.Value.ToolsArray.OfType<JsonObject>().FirstOrDefault(t => GetString(t, "name") == name)
            ?["annotations"]?["idempotentHint"] is JsonValue v && v.GetValueKind() == JsonValueKind.True;
}
