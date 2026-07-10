using System.Diagnostics;
using System.Net.Http;
using System.Text.RegularExpressions;

namespace EmailFinderTray;

/// <summary>
/// Email Finder on 127.0.0.1:3000 steals localhost:3000 from other projects (e.g. OnTrack on 0.0.0.0:3000).
/// This releases port 3000 only when it is serving this project.
/// </summary>
internal static class PortCleanup
{
    private const int LegacyConflictPort = 3000;

    public static async Task ReleaseLegacyPortIfOursAsync(HttpClient http, string projectRoot)
    {
        var legacyUrl = $"http://127.0.0.1:{LegacyConflictPort}";
        if (!await NextDevManager.IsAppReadyAsync(http, legacyUrl))
        {
            return;
        }

        LauncherLog.Write(
            $"Email Finder is still on port {LegacyConflictPort} - this breaks other projects using localhost:3000. Stopping it…");

        var stoppedAny = false;

        var lockInfo = NextDevManager.ReadLock(projectRoot);
        if (lockInfo != null && ParsePort(lockInfo.AppUrl) == LegacyConflictPort)
        {
            if (ProcessGuard.TryStopOwnedProcess(lockInfo.Pid, projectRoot))
            {
                stoppedAny = true;
            }
        }

        foreach (var pid in GetListenerPidsOn127001(LegacyConflictPort))
        {
            if (ProcessGuard.TryStopOwnedProcess(pid, projectRoot))
            {
                stoppedAny = true;
            }
        }

        if (stoppedAny)
        {
            await Task.Delay(1500);
        }

        NextDevManager.RemoveLock(projectRoot);
    }

    public static IEnumerable<int> GetListenerPidsOnLocalhost(int port) =>
        GetListenerPidsOn127001(port);

    public static void StopOurListenersOnPort(string projectRoot, int port)
    {
        foreach (var pid in GetListenerPidsOn127001(port))
        {
            ProcessGuard.TryStopLockHolder(pid, projectRoot);
        }
    }

    private static IEnumerable<int> GetListenerPidsOn127001(int port)
    {
        var pids = new HashSet<int>();
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "netstat",
                Arguments = "-ano",
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
            };
            using var process = Process.Start(psi);
            if (process == null)
            {
                return pids;
            }

            var output = process.StandardOutput.ReadToEnd();
            process.WaitForExit(5000);

            var pattern = $@"127\.0\.0\.1:{port}\s+\S+\s+LISTENING\s+(\d+)";
            foreach (Match match in Regex.Matches(output, pattern, RegexOptions.IgnoreCase))
            {
                if (int.TryParse(match.Groups[1].Value, out var pid))
                {
                    pids.Add(pid);
                }
            }
        }
        catch (Exception ex)
        {
            LauncherLog.Write($"netstat failed: {ex.Message}");
        }

        return pids;
    }

    private static int ParsePort(string appUrl)
    {
        if (Uri.TryCreate(appUrl, UriKind.Absolute, out var uri) && uri.Port > 0)
        {
            return uri.Port;
        }

        return LegacyConflictPort;
    }
}
