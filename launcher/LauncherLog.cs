namespace EmailFinderTray;

internal static class LauncherLog
{
    private static readonly object Gate = new();
    private static string? _path;

    public static void Init(string projectRoot)
    {
        _path = Path.Combine(projectRoot, "email-finder-launcher.log");
        Write($"--- session {DateTime.Now:yyyy-MM-dd HH:mm:ss} ---");
    }

    public static void Write(string message)
    {
        if (_path == null)
        {
            return;
        }

        var line = $"[{DateTime.Now:HH:mm:ss}] {message}";
        lock (Gate)
        {
            File.AppendAllText(_path, line + Environment.NewLine);
        }
    }

    public static string LogPath => _path ?? "(log not initialized)";

    public static string ReadTail(int maxLines = 12)
    {
        if (_path == null || !File.Exists(_path))
        {
            return "(no log file)";
        }

        var lines = File.ReadAllLines(_path);
        return string.Join(Environment.NewLine, lines.TakeLast(maxLines));
    }
}
