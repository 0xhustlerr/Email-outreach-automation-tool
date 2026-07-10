using System.Text.Json.Serialization;

namespace EmailFinderTray;

internal sealed class ReposResponseDto
{
    [JsonPropertyName("user")]
    public string? User { get; set; }

    [JsonPropertyName("repos")]
    public List<RepoDto>? Repos { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }
}

internal sealed class RepoDto
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";
}

internal sealed class ResolveSoResponseDto
{
    [JsonPropertyName("login")]
    public string? Login { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }
}

internal sealed class ScanMatchDto
{
    [JsonPropertyName("repo")]
    public string Repo { get; set; } = "";

    [JsonPropertyName("sha")]
    public string Sha { get; set; } = "";

    [JsonPropertyName("patchUrl")]
    public string PatchUrl { get; set; } = "";

    [JsonPropertyName("author")]
    public PatchAuthorDto? Author { get; set; }

    [JsonPropertyName("telegrams")]
    public List<string> Telegrams { get; set; } = [];

    [JsonPropertyName("phones")]
    public List<string> Phones { get; set; } = [];

    [JsonPropertyName("date")]
    public string? Date { get; set; }
}

internal sealed class PatchAuthorDto
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("email")]
    public string Email { get; set; } = "";
}

internal enum WidgetLogKind
{
    Info,
    Skip,
    Match,
    Error,
    Done,
}

internal sealed class WidgetLogLine
{
    public WidgetLogKind Kind { get; init; }
    public string Text { get; init; } = "";
}

/// <summary>Emitted when a new email contact is found during an in-progress search.</summary>
internal sealed class WidgetEmailFound
{
    public WidgetContact Contact { get; init; } = null!;
}

/// <summary>Profile metadata available while a search is still running (for early send).</summary>
internal sealed class WidgetSearchMeta
{
    public string Login { get; init; } = "";
    public string ProfileUrl { get; init; } = "";
    public string? DisplayName { get; init; }
    public string Country { get; init; } = "";
}

internal sealed class WidgetSearchResult
{
    public string Login { get; init; } = "";
    public string ProfileUrl { get; init; } = "";
    public string Country { get; init; } = "";
    public string? DisplayName { get; init; }
    public List<WidgetContact> Contacts { get; init; } = [];
    public List<WidgetContact> EmailContacts { get; init; } = [];
}
