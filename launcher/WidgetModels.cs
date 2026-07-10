using System.Text.Json.Serialization;

namespace EmailFinderTray;

internal sealed class DiscoveryResultDto
{
    [JsonPropertyName("login")]
    public string Login { get; set; } = "";

    [JsonPropertyName("name")]
    public string? Name { get; set; }

    [JsonPropertyName("location")]
    public string? Location { get; set; }

    [JsonPropertyName("sources")]
    public List<DiscoverySourceDto> Sources { get; set; } = [];
}

internal sealed class DiscoverySourceDto
{
    [JsonPropertyName("label")]
    public string Label { get; set; } = "";

    [JsonPropertyName("url")]
    public string? Url { get; set; }

    [JsonPropertyName("emails")]
    public List<string> Emails { get; set; } = [];

    [JsonPropertyName("telegrams")]
    public List<string> Telegrams { get; set; } = [];

    [JsonPropertyName("phones")]
    public List<string> Phones { get; set; } = [];
}

internal sealed class SendersResponseDto
{
    [JsonPropertyName("smtpConfigured")]
    public bool SmtpConfigured { get; set; }

    [JsonPropertyName("identities")]
    public List<MailIdentityDto> Identities { get; set; } = [];
}

internal sealed class MailIdentityDto
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("email")]
    public string Email { get; set; } = "";
}

internal sealed class TemplatesResponseDto
{
    [JsonPropertyName("ok")]
    public bool Ok { get; set; }

    [JsonPropertyName("templates")]
    public List<TemplateDto> Templates { get; set; } = [];
}

internal sealed class TemplateDto
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = "";

    [JsonPropertyName("label")]
    public string Label { get; set; } = "";

    [JsonPropertyName("subject")]
    public string Subject { get; set; } = "";

    [JsonPropertyName("body")]
    public string Body { get; set; } = "";
}

internal sealed class SendResponseDto
{
    [JsonPropertyName("ok")]
    public bool Ok { get; set; }

    [JsonPropertyName("messageId")]
    public string? MessageId { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }
}
