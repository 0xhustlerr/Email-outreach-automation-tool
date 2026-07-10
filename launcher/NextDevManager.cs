using System.Diagnostics;
using System.Net.Http;
using System.Net.Sockets;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace EmailFinderTray;

internal sealed record DevLockInfo(int Pid, string AppUrl);

internal static class NextDevManager
{
    private static readonly string[] PageMarkers =
    [
        "Cold Outreach Command Center",
        // Legacy markers kept so older builds still detect readiness.
        "FindOutAll",
        "Find Out All",
        "Email Finder",
    ];

    public static int DevPort => LauncherConfig.DevServerPort;

    public static string DevUrl => LauncherConfig.DevServerUrl;

    public static string LockPath(string projectRoot) =>
        Path.Combine(projectRoot, ".next", "dev", "lock");

    public static DevLockInfo? ReadLock(string projectRoot)
    {
        var path = LockPath(projectRoot);
        if (!File.Exists(path))
        {
            return null;
        }

        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(stream);
            var json = reader.ReadToEnd();
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            if (!root.TryGetProperty("pid", out var pidEl))
            {
                return null;
            }

            var pid = pidEl.GetInt32();
            var appUrl = root.TryGetProperty("appUrl", out var urlEl)
                ? urlEl.GetString()
                : DevUrl;

            if (string.IsNullOrWhiteSpace(appUrl))
            {
                appUrl = DevUrl;
            }

            return new DevLockInfo(pid, appUrl);
        }
        catch (Exception ex)
        {
            LauncherLog.Write($"Could not read dev lock: {ex.Message}");
            return null;
        }
    }

    public static async Task<bool> IsOurAppOnDevPortAsync(HttpClient http) =>
        await IsAppReadyAsync(http, DevUrl);

    public static async Task<bool> IsAppReadyAsync(HttpClient http, string url, int timeoutSeconds = 6)
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(timeoutSeconds));
        try
        {
            using var response = await http.GetAsync(
                url,
                HttpCompletionOption.ResponseHeadersRead,
                cts.Token);
            if (!response.IsSuccessStatusCode)
            {
                return false;
            }

            var html = await response.Content.ReadAsStringAsync(cts.Token);
            return PageMarkers.Any(marker => html.Contains(marker, StringComparison.Ordinal));
        }
        catch (Exception ex)
        {
            LauncherLog.Write($"Health check failed for {url}: {ex.Message}");
            return false;
        }
    }

    public static void ClearWebpackTempCache(string projectRoot)
    {
        var cacheDir = Path.Combine(projectRoot, ".next", "dev", "cache", "webpack");
        if (!Directory.Exists(cacheDir))
        {
            return;
        }

        try
        {
            foreach (var file in Directory.EnumerateFiles(cacheDir, "*.pack.gz_", SearchOption.AllDirectories))
            {
                File.Delete(file);
            }
        }
        catch (Exception ex)
        {
            LauncherLog.Write($"Could not clear webpack temp cache: {ex.Message}");
        }
    }

    public static void ClearWebpackCacheForRecovery(string projectRoot)
    {
        var cacheDir = Path.Combine(projectRoot, ".next", "dev", "cache");
        if (!Directory.Exists(cacheDir))
        {
            return;
        }

        try
        {
            Directory.Delete(cacheDir, recursive: true);
            LauncherLog.Write("Cleared .next/dev/cache for a clean rebuild.");
        }
        catch (Exception ex)
        {
            LauncherLog.Write($"Could not clear webpack cache: {ex.Message}");
            ClearWebpackTempCache(projectRoot);
        }
    }

    /// <summary>
    /// Port is listening but not answering HTTP - typical hung/zombie dev server.
    /// </summary>
    public static async Task RecoverHungDevServerAsync(HttpClient http, string projectRoot)
    {
        if (!IsTcpPortOpen(DevPort))
        {
            return;
        }

        if (await IsOurAppOnDevPortAsync(http))
        {
            return;
        }

        LauncherLog.Write($"Port {DevPort} is open but not responding - stopping hung server and clearing lock…");
        PortCleanup.StopOurListenersOnPort(projectRoot, DevPort);
        ForceClearStaleNextLock(projectRoot);
        ClearWebpackCacheForRecovery(projectRoot);
        await Task.Delay(1200);
    }

    /// <summary>
    /// Removes stale .next/dev/lock left when no server is actually running.
    /// </summary>
    public static void ForceClearStaleNextLock(string projectRoot)
    {
        for (var attempt = 1; attempt <= 8; attempt++)
        {
            var lockInfo = ReadLock(projectRoot);
            if (lockInfo == null && !File.Exists(LockPath(projectRoot)))
            {
                return;
            }

            if (lockInfo != null)
            {
                if (ProcessGuard.IsProcessRunning(lockInfo.Pid))
                {
                    if (ProcessGuard.TryStopLockHolder(lockInfo.Pid, projectRoot))
                    {
                        Thread.Sleep(800);
                    }
                    else
                    {
                        LauncherLog.Write(
                            $"Lock lists PID {lockInfo.Pid} but it could not be stopped safely - removing lock file only.");
                    }
                }
                else
                {
                    LauncherLog.Write($"Stale lock: PID {lockInfo.Pid} is not running (attempt {attempt}).");
                }
            }

            RemoveLock(projectRoot);
            if (!File.Exists(LockPath(projectRoot)))
            {
                LauncherLog.Write("Cleared .next/dev/lock.");
                return;
            }

            Thread.Sleep(400);
        }

        LauncherLog.Write("Could not fully remove .next/dev/lock after several attempts.");
    }

    public static void RemoveLock(string projectRoot)
    {
        var path = LockPath(projectRoot);
        for (var i = 0; i < 5; i++)
        {
            try
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                }

                return;
            }
            catch (Exception ex)
            {
                LauncherLog.Write($"Could not remove lock file (try {i + 1}): {ex.Message}");
                Thread.Sleep(300);
            }
        }
    }

    public static bool IsTcpPortOpen(int port)
    {
        try
        {
            using var client = new TcpClient();
            var connect = client.ConnectAsync("127.0.0.1", port);
            if (!connect.Wait(400))
            {
                return false;
            }

            return client.Connected;
        }
        catch
        {
            return false;
        }
    }

    public static async Task<(bool Attached, int Port, string Url)> TryAttachOrPreparePortAsync(
        HttpClient http,
        string projectRoot)
    {
        ForceClearStaleNextLock(projectRoot);
        ClearWebpackTempCache(projectRoot);
        await PortCleanup.ReleaseLegacyPortIfOursAsync(http, projectRoot);
        await RecoverHungDevServerAsync(http, projectRoot);

        if (await IsOurAppOnDevPortAsync(http))
        {
            LauncherLog.Write($"Email Finder already running on {DevUrl}");
            return (true, DevPort, DevUrl);
        }

        if (IsTcpPortOpen(DevPort))
        {
            throw new InvalidOperationException(
                $"Port {DevPort} is in use but not serving Cold Outreach Command Center.\n\n" +
                "Close the other program on port 3005, then use Restart server from the tray.");
        }

        return (false, DevPort, DevUrl);
    }

    public static void StopOwnedDevProcesses(string projectRoot, int? launchedPid)
    {
        if (launchedPid is > 0)
        {
            ProcessGuard.TryStopOwnedProcess(launchedPid.Value, projectRoot);
        }

        var savedPid = ProcessGuard.ReadOwnedPid(projectRoot);
        if (savedPid is > 0 && savedPid != launchedPid)
        {
            ProcessGuard.TryStopOwnedProcess(savedPid.Value, projectRoot);
        }

        var lockInfo = ReadLock(projectRoot);
        if (lockInfo != null && ProcessGuard.IsProcessRunning(lockInfo.Pid))
        {
            ProcessGuard.TryStopLockHolder(lockInfo.Pid, projectRoot);
        }

        ForceClearStaleNextLock(projectRoot);
        ProcessGuard.ClearOwnedProcess(projectRoot);
    }

    public static bool TryParseConflictPid(string logText, out int pid)
    {
        pid = 0;
        var match = Regex.Match(logText, @"PID:\s*(\d+)", RegexOptions.IgnoreCase);
        return match.Success && int.TryParse(match.Groups[1].Value, out pid);
    }

    private static int ParsePort(string appUrl)
    {
        if (Uri.TryCreate(appUrl, UriKind.Absolute, out var uri) && uri.Port > 0)
        {
            return uri.Port;
        }

        return DevPort;
    }
}
