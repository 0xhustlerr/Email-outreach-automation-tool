using System.Net.Http.Json;
using System.Text;
using System.Text.Json;

namespace EmailFinderTray;

/// <summary>
/// Mirrors the web app search pipeline: resolve SO → repos → discover + scan (all repos) → merge contacts.
/// </summary>
internal sealed class WidgetSearchService
{
    private const int DefaultCommitsPerRepo = 5;
    private static readonly TimeSpan SearchTimeout = TimeSpan.FromMinutes(10);

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private readonly HttpClient _http;
    private readonly string _baseUrl;

    public WidgetSearchService(HttpClient http, string baseUrl)
    {
        _http = http;
        _baseUrl = baseUrl.TrimEnd('/');
    }

    public async Task<WidgetSearchResult> SearchAsync(
        string profileInput,
        IProgress<WidgetLogLine> log,
        IProgress<WidgetEmailFound>? onEmailFound,
        IProgress<WidgetSearchMeta>? onMeta,
        CancellationToken ct)
    {
        using var timeoutCts = new CancellationTokenSource(SearchTimeout);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, timeoutCts.Token);
        var searchCt = linked.Token;

        var trimmed = profileInput.Trim();
        var isGh = ProfileUrlHelper.IsMaybeGitHubUsername(trimmed);
        var isSo = !isGh && ProfileUrlHelper.IsStackOverflowProfileUrl(trimmed);
        if (!isGh && !isSo)
        {
            throw new InvalidOperationException("Enter a GitHub or Stack Overflow profile URL.");
        }

        var userParam = trimmed;
        if (isSo)
        {
            Log(log, WidgetLogKind.Info, "Resolving GitHub profile from Stack Overflow…");
            userParam = await ResolveStackOverflowAsync(trimmed, searchCt);
            Log(log, WidgetLogKind.Match, $"Resolved: github.com/{userParam}");
        }

        Log(log, WidgetLogKind.Info, "Loading repositories…");
        var login = await LoadReposUserAsync(userParam, searchCt);
        Log(log, WidgetLogKind.Info, $"User: {login}");
        ReportMeta(onMeta, login, null, null);

        var accumulator = new WidgetContactAccumulator();
        void ReportNewEmails(IEnumerable<WidgetContact> added)
        {
            if (onEmailFound == null)
            {
                return;
            }

            foreach (var contact in added)
            {
                onEmailFound.Report(new WidgetEmailFound { Contact = contact });
            }
        }

        DiscoveryResultDto? discovery = null;
        var discoverTask = RunDiscoverAndReportAsync(
            login,
            log,
            accumulator,
            ReportNewEmails,
            d =>
            {
                discovery = d;
                ReportMeta(
                    onMeta,
                    login,
                    d?.Name,
                    ProfileUrlHelper.ExtractCountry(d?.Location));
            },
            searchCt);
        var scanTask = RunScanAsync(login, log, accumulator, ReportNewEmails, searchCt);
        await Task.WhenAll(discoverTask, scanTask);

        var contacts = accumulator.AllContacts.ToList();
        var emails = accumulator.EmailsOnly();

        Log(
            log,
            emails.Count > 0 ? WidgetLogKind.Match : WidgetLogKind.Info,
            $"Found {emails.Count} email(s), {contacts.Count} contact(s) total.");

        return new WidgetSearchResult
        {
            Login = login,
            ProfileUrl = ProfileUrlHelper.ProfileUrl(login),
            Country = ProfileUrlHelper.ExtractCountry(discovery?.Location),
            DisplayName = discovery?.Name,
            Contacts = contacts,
            EmailContacts = emails,
        };
    }

    private async Task<string> ResolveStackOverflowAsync(string url, CancellationToken ct)
    {
        var api = $"{_baseUrl}/api/resolve-so?url={Uri.EscapeDataString(url)}";
        using var res = await _http.GetAsync(api, ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        var data = JsonSerializer.Deserialize<ResolveSoResponseDto>(body, JsonOptions);
        if (!res.IsSuccessStatusCode || string.IsNullOrWhiteSpace(data?.Login))
        {
            throw new InvalidOperationException(
                data?.Error ?? "Could not find a GitHub link on that Stack Overflow profile.");
        }

        return data.Login;
    }

    private async Task<string> LoadReposUserAsync(string userParam, CancellationToken ct)
    {
        var api = $"{_baseUrl}/api/repos?user={Uri.EscapeDataString(userParam)}";
        using var res = await _http.GetAsync(api, ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        var data = JsonSerializer.Deserialize<ReposResponseDto>(body, JsonOptions);
        if (!res.IsSuccessStatusCode || data?.Repos == null)
        {
            throw new InvalidOperationException(data?.Error ?? "Failed to load repositories.");
        }

        if (data.Repos.Count == 0)
        {
            throw new InvalidOperationException("No repositories found for this user.");
        }

        return data.User ?? ProfileUrlHelper.ParseGitHubUsername(userParam) ?? userParam;
    }

    private async Task RunDiscoverAndReportAsync(
        string login,
        IProgress<WidgetLogLine> log,
        WidgetContactAccumulator accumulator,
        Action<IEnumerable<WidgetContact>> reportNewEmails,
        Action<DiscoveryResultDto?> onDiscovery,
        CancellationToken ct)
    {
        var discovery = await RunDiscoverAsync(login, log, ct);
        onDiscovery(discovery);
        reportNewEmails(accumulator.MergeDiscovery(discovery));
    }

    private static void ReportMeta(
        IProgress<WidgetSearchMeta>? onMeta,
        string login,
        string? displayName,
        string? country)
    {
        if (string.IsNullOrEmpty(login) || onMeta == null)
        {
            return;
        }

        onMeta.Report(new WidgetSearchMeta
        {
            Login = login,
            ProfileUrl = ProfileUrlHelper.ProfileUrl(login),
            DisplayName = displayName,
            Country = country ?? "",
        });
    }

    private async Task<DiscoveryResultDto?> RunDiscoverAsync(
        string login,
        IProgress<WidgetLogLine> log,
        CancellationToken ct)
    {
        Log(log, WidgetLogKind.Info, $"Discovering emails from profile/README/blog for {login}…");
        try
        {
            var api = $"{_baseUrl}/api/discover?user={Uri.EscapeDataString(login)}";
            using var res = await _http.GetAsync(api, ct);
            var body = await res.Content.ReadAsStringAsync(ct);
            if (!res.IsSuccessStatusCode)
            {
                var err = TryReadError(body);
                Log(log, WidgetLogKind.Error, $"Discovery: {err}");
                return null;
            }

            var data = JsonSerializer.Deserialize<DiscoveryResultDto>(body, JsonOptions);
            var total = data?.Sources.Sum(s => s.Emails.Count) ?? 0;
            Log(
                log,
                total > 0 ? WidgetLogKind.Match : WidgetLogKind.Info,
                $"Discovery complete: {total} email(s) across {data?.Sources.Count ?? 0} source(s).");
            return data;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            Log(log, WidgetLogKind.Error, $"Discovery: {ex.Message}");
            return null;
        }
    }

    private async Task RunScanAsync(
        string login,
        IProgress<WidgetLogLine> log,
        WidgetContactAccumulator accumulator,
        Action<IEnumerable<WidgetContact>> reportNewEmails,
        CancellationToken ct)
    {
        Log(log, WidgetLogKind.Info, $"Scanning all repos for {login} ({DefaultCommitsPerRepo} commits per repo)…");

        var payload = new
        {
            owner = login,
            commitsPerRepo = DefaultCommitsPerRepo,
        };

        using var req = new HttpRequestMessage(HttpMethod.Post, $"{_baseUrl}/api/scan")
        {
            Content = JsonContent.Create(payload),
        };

        using var res = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!res.IsSuccessStatusCode)
        {
            var text = await res.Content.ReadAsStringAsync(ct);
            throw new InvalidOperationException(TryReadError(text) ?? $"Scan failed ({(int)res.StatusCode}).");
        }

        await using var stream = await res.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        var buffer = new StringBuilder();

        while (!reader.EndOfStream)
        {
            ct.ThrowIfCancellationRequested();
            var chunk = await reader.ReadLineAsync(ct);
            if (chunk == null)
            {
                break;
            }

            var line = chunk.Trim();
            if (string.IsNullOrEmpty(line))
            {
                continue;
            }

            HandleScanEvent(line, accumulator, reportNewEmails, log);
        }
    }

    private void HandleScanEvent(
        string json,
        WidgetContactAccumulator accumulator,
        Action<IEnumerable<WidgetContact>> reportNewEmails,
        IProgress<WidgetLogLine> log)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        if (!root.TryGetProperty("type", out var typeEl))
        {
            return;
        }

        var type = typeEl.GetString();
        switch (type)
        {
            case "start":
                var total = root.GetProperty("totalCommits").GetInt32();
                var repoCount = root.GetProperty("repoCount").GetInt32();
                Log(log, WidgetLogKind.Info, $"Plan: {total} commit(s) across {repoCount} repo(s).");
                break;
            case "repo-start":
                Log(
                    log,
                    WidgetLogKind.Info,
                    $"→ {root.GetProperty("repo").GetString()} ({root.GetProperty("commitCount").GetInt32()} commits)");
                break;
            case "progress":
                Log(
                    log,
                    WidgetLogKind.Info,
                    $"  [{root.GetProperty("index").GetInt32()}/{root.GetProperty("total").GetInt32()}] " +
                    $"{root.GetProperty("repo").GetString()}@{ShortSha(root.GetProperty("sha").GetString() ?? "")}…");
                break;
            case "skipped":
                Log(
                    log,
                    WidgetLogKind.Skip,
                    $"  skip {root.GetProperty("repo").GetString()}@{ShortSha(root.GetProperty("sha").GetString() ?? "")}: " +
                    $"{root.GetProperty("reason").GetString()}.");
                break;
            case "match":
                var matchEl = root.GetProperty("match");
                var match = JsonSerializer.Deserialize<ScanMatchDto>(matchEl.GetRawText(), JsonOptions);
                if (match != null)
                {
                    var commitRef = $"{match.Repo}@{ShortSha(match.Sha)}";
                    var parts = new List<string>();
                    if (match.Author != null)
                    {
                        parts.Add(match.Author.Email);
                    }

                    if (match.Telegrams.Count > 0)
                    {
                        parts.Add($"tg: {string.Join(", ", match.Telegrams.Select(t => $"@{t}"))}");
                    }

                    if (match.Phones.Count > 0)
                    {
                        parts.Add($"ph: {string.Join(", ", match.Phones)}");
                    }

                    Log(
                        log,
                        WidgetLogKind.Match,
                        $"  MATCH {commitRef} → {string.Join("; ", parts)}");

                    var newEmails = accumulator.MergeMatch(match);
                    reportNewEmails(newEmails);
                }

                break;
            case "done":
                Log(
                    log,
                    WidgetLogKind.Done,
                    $"Done. Scanned {root.GetProperty("scanned").GetInt32()} commit(s) across " +
                    $"{root.GetProperty("repoCount").GetInt32()} repo(s); " +
                    $"{root.GetProperty("matches").GetInt32()} unique email(s).");
                break;
            case "error":
                Log(log, WidgetLogKind.Error, root.GetProperty("message").GetString() ?? "Scan error.");
                break;
        }
    }

    public async Task<SendersResponseDto> GetSendersAsync(CancellationToken ct = default)
    {
        using var res = await _http.GetAsync($"{_baseUrl}/api/senders", ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(TryReadError(body) ?? "Failed to load senders.");
        }

        return JsonSerializer.Deserialize<SendersResponseDto>(body, JsonOptions) ?? new SendersResponseDto();
    }

    /// <summary>Templates from the app's database - the same set the web UI
    /// manages via Manage Templates.</summary>
    public async Task<List<WidgetEmailTemplate>> GetTemplatesAsync(CancellationToken ct = default)
    {
        using var res = await _http.GetAsync($"{_baseUrl}/api/templates", ct);
        var body = await res.Content.ReadAsStringAsync(ct);
        if (!res.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(TryReadError(body) ?? "Failed to load templates.");
        }

        var data = JsonSerializer.Deserialize<TemplatesResponseDto>(body, JsonOptions);
        return (data?.Templates ?? [])
            .Where(t => !string.IsNullOrWhiteSpace(t.Id) && !string.IsNullOrWhiteSpace(t.Subject))
            .Select(t => new WidgetEmailTemplate(t.Id, t.Label, t.Subject, t.Body))
            .ToList();
    }

    public async Task SendAsync(
        MailIdentityDto from,
        string to,
        string subject,
        string body,
        string name,
        string link,
        string username,
        string country,
        CancellationToken ct = default)
    {
        var payload = new
        {
            from = new { email = from.Email, name = from.Name },
            to,
            subject,
            body,
            name,
            link,
            username,
            country,
        };

        using var res = await _http.PostAsJsonAsync($"{_baseUrl}/api/send", payload, ct);
        var text = await res.Content.ReadAsStringAsync(ct);
        var data = JsonSerializer.Deserialize<SendResponseDto>(text, JsonOptions);
        if (!res.IsSuccessStatusCode || data is not { Ok: true })
        {
            throw new InvalidOperationException(data?.Error ?? TryReadError(text) ?? "Send failed.");
        }
    }

    private static void Log(IProgress<WidgetLogLine> log, WidgetLogKind kind, string text) =>
        log.Report(new WidgetLogLine { Kind = kind, Text = text });

    private static string? TryReadError(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.TryGetProperty("error", out var err))
            {
                return err.GetString();
            }
        }
        catch
        {
            // ignore
        }

        return null;
    }

    private static string ShortSha(string sha) => sha.Length >= 7 ? sha[..7] : sha;
}
