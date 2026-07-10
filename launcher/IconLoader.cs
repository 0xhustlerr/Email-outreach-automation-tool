namespace EmailFinderTray;

/// <summary>
/// Loads icons only from the user's original icon.ico (native frames, no conversion).
/// </summary>
internal static class IconLoader
{
    private const string IconFileName = "icon.ico";

    public static Icon LoadTrayIcon() => LoadNativeFrame([32, 48, 24], "tray");

    public static Icon LoadFormIcon() => LoadNativeFrame([128, 64, 48], "form");

    private static Icon LoadNativeFrame(int[] sizes, string role)
    {
        var path = FindIconPath();
        if (path == null)
        {
            LauncherLog.Write($"Icon ({role}) missing {IconFileName}");
            return SystemIcons.Application;
        }

        foreach (var size in sizes)
        {
            try
            {
                var icon = new Icon(path, size, size);
                LauncherLog.Write($"Icon ({role}) {icon.Width}x{icon.Height} from {path}");
                return icon;
            }
            catch (Exception ex)
            {
                LauncherLog.Write($"Icon ({role}) {size}px: {ex.Message}");
            }
        }

        try
        {
            var fallback = new Icon(path);
            LauncherLog.Write($"Icon ({role}) default frame from {path} ({fallback.Width}x{fallback.Height})");
            return fallback;
        }
        catch (Exception ex)
        {
            LauncherLog.Write($"Icon ({role}) failed: {ex.Message}");
            return SystemIcons.Application;
        }
    }

    public static string? FindIconPath()
    {
        foreach (var dir in SearchDirs())
        {
            var path = Path.Combine(dir, IconFileName);
            if (File.Exists(path))
            {
                return path;
            }
        }

        return null;
    }

    private static IEnumerable<string> SearchDirs()
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var list = new List<string>();

        void Add(string? dir)
        {
            if (string.IsNullOrWhiteSpace(dir))
            {
                return;
            }

            var full = Path.GetFullPath(dir).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (seen.Add(full))
            {
                list.Add(full);
            }
        }

        Add(Path.GetDirectoryName(Environment.ProcessPath ?? Application.ExecutablePath));
        Add(AppContext.BaseDirectory);

        foreach (var dir in list)
        {
            yield return dir;
        }
    }
}
