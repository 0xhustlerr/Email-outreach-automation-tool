using System.Text.Json.Serialization;

namespace EmailFinderTray;

/// <summary>
/// A sending account Gmail policy-blocked ("Message blocked" bounce). Mirrors
/// SenderBlock in lib/sender-blocks.ts — the property names are the contract,
/// and a rename on the TS side silently deserializes to an empty list here.
/// </summary>
internal sealed class TraySenderBlock
{
    [JsonPropertyName("sender")]
    public string Sender { get; set; } = "";

    [JsonPropertyName("reason")]
    public string Reason { get; set; } = "";

    [JsonPropertyName("detail")]
    public string Detail { get; set; } = "";

    /// <summary>Stable for the life of one block — this is the dedup key.</summary>
    [JsonPropertyName("detectedAt")]
    public string DetectedAt { get; set; } = "";

    /// <summary>ISO of the next local midnight, when the block lifts itself.</summary>
    [JsonPropertyName("until")]
    public string Until { get; set; } = "";
}

internal sealed class TraySendersResponse
{
    [JsonPropertyName("sheetsConfigured")]
    public bool SheetsConfigured { get; set; }

    [JsonPropertyName("gmailReplySyncConfigured")]
    public bool GmailReplySyncConfigured { get; set; }

    /// <summary>Accounts paused for the rest of the local day by a Gmail block.</summary>
    [JsonPropertyName("senderBlocks")]
    public List<TraySenderBlock> SenderBlocks { get; set; } = [];
}

internal sealed class TrayReplyNotification
{
    [JsonPropertyName("_row")]
    public int Row { get; set; }

    [JsonPropertyName("messageId")]
    public string MessageId { get; set; } = "";

    [JsonPropertyName("contact")]
    public string Contact { get; set; } = "";

    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("snippet")]
    public string Snippet { get; set; } = "";

    [JsonPropertyName("subject")]
    public string Subject { get; set; } = "";
}

internal sealed class TraySyncRepliesResponse
{
    [JsonPropertyName("ok")]
    public bool Ok { get; set; }

    [JsonPropertyName("configured")]
    public bool Configured { get; set; }

    [JsonPropertyName("notifications")]
    public List<TrayReplyNotification> Notifications { get; set; } = [];

    /// <summary>
    /// Every row that currently has a reply (full set). Preferred over
    /// <see cref="Notifications"/> so the tray dedups against its own seen-set
    /// and isn't starved by the web page consuming the shared "new" flag.
    /// </summary>
    [JsonPropertyName("replies")]
    public List<TrayReplyNotification> Replies { get; set; } = [];

    [JsonPropertyName("error")]
    public string? Error { get; set; }
}

internal sealed class TrayReplySyncUiState
{
    public bool Seeded { get; set; }

    /// <summary>
    /// Bumped when the dedup source changes (notifications → full reply set) so
    /// existing installs re-seed once instead of toasting every old reply.
    /// </summary>
    public int Version { get; set; }

    public Dictionary<string, string> ToastedMessageIds { get; set; } = new();

    /// <summary>
    /// One-time seed of pre-existing sender blocks so a first run on an install
    /// that is already blocked doesn't toast history. Deliberately separate from
    /// <see cref="Seeded"/>/<see cref="Version"/>: bumping the reply StateVersion
    /// clears ToastedMessageIds and costs every install one cycle of missed reply
    /// popups, which shipping an unrelated feature must not do.
    /// </summary>
    public bool BlocksSeeded { get; set; }

    /// <summary>Lowercased sender → the DetectedAt already toasted for it.</summary>
    public Dictionary<string, string> ToastedBlocks { get; set; } = new();
}
