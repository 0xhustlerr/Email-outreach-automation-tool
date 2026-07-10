namespace EmailFinderTray;

internal enum WidgetContactKind
{
    Email,
    Telegram,
    Phone,
}

internal sealed class WidgetContact
{
    public WidgetContactKind Kind { get; init; }
    public string Value { get; init; } = "";
    public List<string> Names { get; } = [];
    public List<WidgetContactSource> Sources { get; } = [];
}

internal sealed class WidgetContactSource
{
    public string Label { get; init; } = "";
    public string? Url { get; init; }
    public string? Date { get; init; }
}

/// <summary>Incremental merge - reports only newly discovered email contacts.</summary>
internal sealed class WidgetContactAccumulator
{
    private readonly object _gate = new();
    private readonly Dictionary<string, WidgetContact> _map = new(StringComparer.OrdinalIgnoreCase);

    public IReadOnlyList<WidgetContact> AllContacts
    {
        get
        {
            var order = new Dictionary<WidgetContactKind, int>
            {
                [WidgetContactKind.Email] = 0,
                [WidgetContactKind.Telegram] = 1,
                [WidgetContactKind.Phone] = 2,
            };
            return _map.Values
                .OrderBy(c => order[c.Kind])
                .ThenBy(c => c.Value, StringComparer.OrdinalIgnoreCase)
                .ToList();
        }
    }

    public List<WidgetContact> EmailsOnly() =>
        AllContacts.Where(c => c.Kind == WidgetContactKind.Email).ToList();

    public List<WidgetContact> MergeDiscovery(DiscoveryResultDto? discovery)
    {
        lock (_gate)
        {
            return MergeDiscoveryCore(discovery);
        }
    }

    public List<WidgetContact> MergeMatch(ScanMatchDto match)
    {
        lock (_gate)
        {
            return MergeMatchCore(match);
        }
    }

    private List<WidgetContact> MergeDiscoveryCore(DiscoveryResultDto? discovery)
    {
        var added = new List<WidgetContact>();
        if (discovery == null)
        {
            return added;
        }

        foreach (var s in discovery.Sources)
        {
            var src = new WidgetContactSource { Label = s.Label, Url = s.Url };
            foreach (var e in s.Emails)
            {
                if (TryAddEmail(e, null, src, out var contact))
                {
                    added.Add(contact);
                }
            }

            foreach (var t in s.Telegrams)
            {
                UpsertNonEmail(WidgetContactKind.Telegram, t, null, src);
            }

            foreach (var p in s.Phones)
            {
                UpsertNonEmail(WidgetContactKind.Phone, p, null, src);
            }
        }

        return added;
    }

    private List<WidgetContact> MergeMatchCore(ScanMatchDto match)
    {
        var added = new List<WidgetContact>();
        var src = new WidgetContactSource
        {
            Label = $"Commit {match.Repo}@{ShortSha(match.Sha)}",
            Url = match.PatchUrl,
            Date = match.Date,
        };

        if (match.Author != null &&
            TryAddEmail(match.Author.Email, match.Author.Name, src, out var emailContact))
        {
            added.Add(emailContact);
        }

        foreach (var t in match.Telegrams)
        {
            UpsertNonEmail(WidgetContactKind.Telegram, t, null, src);
        }

        foreach (var p in match.Phones)
        {
            UpsertNonEmail(WidgetContactKind.Phone, p, null, src);
        }

        return added;
    }

    private bool TryAddEmail(
        string value,
        string? name,
        WidgetContactSource src,
        out WidgetContact contact)
    {
        contact = null!;
        var normalized = value.Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(normalized) || !normalized.Contains('@'))
        {
            return false;
        }

        var key = $"{WidgetContactKind.Email}:{normalized}";
        var isNew = !_map.ContainsKey(key);
        Upsert(WidgetContactKind.Email, normalized, name, src);
        contact = _map[key];
        return isNew;
    }

    private void UpsertNonEmail(WidgetContactKind kind, string value, string? name, WidgetContactSource src)
    {
        var normalized = kind == WidgetContactKind.Phone ? value : value.ToLowerInvariant();
        Upsert(kind, normalized, name, src);
    }

    private void Upsert(WidgetContactKind kind, string value, string? name, WidgetContactSource src)
    {
        var key = $"{kind}:{value}";
        if (!_map.TryGetValue(key, out var existing))
        {
            existing = new WidgetContact { Kind = kind, Value = value };
            _map[key] = existing;
        }

        if (!string.IsNullOrWhiteSpace(name) &&
            !existing.Names.Any(n => string.Equals(n, name, StringComparison.OrdinalIgnoreCase)))
        {
            existing.Names.Add(name);
        }

        if (!existing.Sources.Any(s => s.Label == src.Label && s.Url == src.Url))
        {
            existing.Sources.Add(src);
        }
    }

    private static string ShortSha(string sha) =>
        sha.Length >= 7 ? sha[..7] : sha;
}

internal static class WidgetContactMerger
{
    public static List<WidgetContact> Merge(DiscoveryResultDto? discovery, List<ScanMatchDto> matches)
    {
        var acc = new WidgetContactAccumulator();
        acc.MergeDiscovery(discovery);
        foreach (var m in matches)
        {
            acc.MergeMatch(m);
        }

        return acc.AllContacts.ToList();
    }

    public static List<WidgetContact> EmailsOnly(IEnumerable<WidgetContact> contacts) =>
        contacts.Where(c => c.Kind == WidgetContactKind.Email).ToList();

    public static string FormatEmailSourceLine(WidgetContact contact)
    {
        var src = contact.Sources.LastOrDefault();
        if (src == null)
        {
            return "Discovered";
        }

        if (src.Label.StartsWith("Commit ", StringComparison.Ordinal))
        {
            return src.Label["Commit ".Length..];
        }

        return src.Label;
    }
}
