using System.Text.Json.Serialization;

namespace EmailFinderTray;

internal sealed class TraySendersResponse
{
    [JsonPropertyName("sheetsConfigured")]
    public bool SheetsConfigured { get; set; }

    [JsonPropertyName("gmailReplySyncConfigured")]
    public bool GmailReplySyncConfigured { get; set; }
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
}
