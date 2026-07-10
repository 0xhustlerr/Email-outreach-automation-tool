namespace EmailFinderTray;

/// <summary>
/// Tiny key=value store in %LocalAppData%\EmailFinder\widget.cfg.
/// Used to remember UI choices (e.g. selected email template) across sessions,
/// the desktop equivalent of the web app's localStorage.
/// </summary>
internal static class WidgetSettings
{
    public const string TemplateIdKey = "templateId";

    private static readonly object Gate = new();

    private static string FilePath
    {
        get
        {
            var dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "EmailFinder");
            Directory.CreateDirectory(dir);
            return Path.Combine(dir, "widget.cfg");
        }
    }

    public static string? Get(string key)
    {
        try
        {
            lock (Gate)
            {
                if (!File.Exists(FilePath))
                {
                    return null;
                }

                foreach (var line in File.ReadAllLines(FilePath))
                {
                    var eq = line.IndexOf('=');
                    if (eq > 0 && line[..eq].Trim() == key)
                    {
                        return line[(eq + 1)..].Trim();
                    }
                }
            }
        }
        catch
        {
            // ignore - settings are best-effort
        }

        return null;
    }

    public static void Set(string key, string value)
    {
        try
        {
            lock (Gate)
            {
                var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                if (File.Exists(FilePath))
                {
                    foreach (var line in File.ReadAllLines(FilePath))
                    {
                        var eq = line.IndexOf('=');
                        if (eq > 0)
                        {
                            map[line[..eq].Trim()] = line[(eq + 1)..].Trim();
                        }
                    }
                }

                map[key] = value;
                File.WriteAllLines(FilePath, map.Select(kv => $"{kv.Key}={kv.Value}"));
            }
        }
        catch
        {
            // ignore - settings are best-effort
        }
    }
}
