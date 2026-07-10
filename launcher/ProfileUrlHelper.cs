using System.Text.RegularExpressions;

namespace EmailFinderTray;

internal static class ProfileUrlHelper
{
    private static readonly Regex LoginRegex = new(
        @"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$",
        RegexOptions.Compiled);

    public static bool IsMaybeGitHubUsername(string input)
    {
        var trimmed = input.Trim();
        if (string.IsNullOrEmpty(trimmed))
        {
            return false;
        }

        var withoutProto = Regex.Replace(trimmed, @"^https?://", "", RegexOptions.IgnoreCase);
        var withoutHost = Regex.Replace(withoutProto, @"^(www\.)?github\.com/?", "", RegexOptions.IgnoreCase);
        var firstSegment = withoutHost.Split(['/', '?', '#'], StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
        return !string.IsNullOrEmpty(firstSegment) && LoginRegex.IsMatch(firstSegment);
    }

    public static bool IsStackOverflowProfileUrl(string input) =>
        Regex.IsMatch(input.Trim(), @"^https?://(www\.)?stackoverflow\.com/users/\d+", RegexOptions.IgnoreCase);

    public static bool IsSearchableUrl(string input) =>
        IsMaybeGitHubUsername(input) || IsStackOverflowProfileUrl(input);

    public static string? ParseGitHubUsername(string input)
    {
        var trimmed = input.Trim();
        if (string.IsNullOrEmpty(trimmed))
        {
            return null;
        }

        var withoutProto = Regex.Replace(trimmed, @"^https?://", "", RegexOptions.IgnoreCase);
        var withoutHost = Regex.Replace(withoutProto, @"^(www\.)?github\.com/?", "", RegexOptions.IgnoreCase);
        var firstSegment = withoutHost.Split(['/', '?', '#'], StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
        if (string.IsNullOrEmpty(firstSegment))
        {
            return null;
        }

        return LoginRegex.IsMatch(firstSegment) ? firstSegment : null;
    }

    public static string ProfileUrl(string login) => $"https://github.com/{login}";

    public static string ExtractCountry(string? location)
    {
        if (string.IsNullOrWhiteSpace(location))
        {
            return "";
        }

        var commaParts = location.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        var tail = commaParts.Length > 0 ? commaParts[^1] : location.Trim();
        var periodParts = tail.Split('.', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        var last = periodParts.Length > 0 ? periodParts[^1] : tail;
        return Regex.Replace(last, @"[.,;:\s]+$", "").Trim();
    }
}
