using System.Diagnostics;
using System.Management;
using System.Text.Json;

namespace EmailFinderTray;

/// <summary>
/// Ensures we only stop processes that belong to this Email Finder project.
/// Never kills arbitrary node.exe or unrelated apps (avoids PID reuse accidents).
/// </summary>
internal static class ProcessGuard
{
    private static readonly string[] AllowedProcessNames =
    [
        "node",
        "cmd",
        "npm",
    ];

    public static string StatePath(string projectRoot) =>
        Path.Combine(projectRoot, "email-finder-launcher.state.json");

    public static void SaveOwnedProcess(string projectRoot, int pid, int port)
    {
        try
        {
            var json = JsonSerializer.Serialize(new { pid, port, savedAt = DateTime.UtcNow });
            File.WriteAllText(StatePath(projectRoot), json);
        }
        catch (Exception ex)
        {
            LauncherLog.Write($"Could not save launcher state: {ex.Message}");
        }
    }

    public static void ClearOwnedProcess(string projectRoot)
    {
        try
        {
            var path = StatePath(projectRoot);
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch
        {
            // ignore
        }
    }

    public static int? ReadOwnedPid(string projectRoot)
    {
        try
        {
            var path = StatePath(projectRoot);
            if (!File.Exists(path))
            {
                return null;
            }

            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            if (doc.RootElement.TryGetProperty("pid", out var pidEl))
            {
                return pidEl.GetInt32();
            }
        }
        catch
        {
            // ignore
        }

        return null;
    }

    public static bool BelongsToProject(int pid, string projectRoot)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            var name = process.ProcessName;
            if (!AllowedProcessNames.Any(n => name.Equals(n, StringComparison.OrdinalIgnoreCase)))
            {
                LauncherLog.Write($"Skip PID {pid}: process '{name}' is not a dev launcher process.");
                return false;
            }
        }
        catch
        {
            return false;
        }

        var commandLine = GetCommandLine(pid);
        if (string.IsNullOrWhiteSpace(commandLine))
        {
            LauncherLog.Write($"Skip PID {pid}: could not read command line.");
            return false;
        }

        var root = Path.GetFullPath(projectRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var rootNorm = root.ToLowerInvariant();
        var cmdNorm = commandLine.ToLowerInvariant();

        if (!cmdNorm.Contains(rootNorm))
        {
            LauncherLog.Write($"Skip PID {pid}: command line does not reference this project folder.");
            return false;
        }

        var looksLikeDev =
            cmdNorm.Contains("next")
            || cmdNorm.Contains("npm")
            || cmdNorm.Contains("run dev")
            // Portable bundle: the production server runs as `node start.js` /
            // `node server.js` from the bundle folder.
            || cmdNorm.Contains("server.js")
            || cmdNorm.Contains("start.js");

        if (!looksLikeDev)
        {
            LauncherLog.Write($"Skip PID {pid}: not a Next/npm dev command for this project.");
            return false;
        }

        return true;
    }

    public static bool TryStopOwnedProcess(int pid, string projectRoot)
    {
        if (!IsProcessRunning(pid))
        {
            return false;
        }

        if (!BelongsToProject(pid, projectRoot))
        {
            LauncherLog.Write($"Will not stop PID {pid} - it does not belong to Email Finder.");
            return false;
        }

        return KillProcessTree(pid);
    }

    /// <summary>
    /// Stops a PID listed in this project's .next/dev/lock (stricter than random PIDs).
    /// </summary>
    public static bool TryStopLockHolder(int pid, string projectRoot)
    {
        if (!IsProcessRunning(pid))
        {
            return false;
        }

        if (BelongsToProject(pid, projectRoot) || BelongsToProjectRelaxed(pid, projectRoot))
        {
            return KillProcessTree(pid);
        }

        LauncherLog.Write($"Will not stop lock PID {pid} - not recognized as Email Finder.");
        return false;
    }

    private static bool BelongsToProjectRelaxed(int pid, string projectRoot)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            if (!process.ProcessName.Equals("node", StringComparison.OrdinalIgnoreCase)
                && !process.ProcessName.Equals("cmd", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }
        }
        catch
        {
            return false;
        }

        var commandLine = GetCommandLine(pid) ?? "";
        var folderName = new DirectoryInfo(projectRoot).Name;
        var root = Path.GetFullPath(projectRoot);

        return commandLine.Contains(folderName, StringComparison.OrdinalIgnoreCase)
            || commandLine.Contains(root, StringComparison.OrdinalIgnoreCase)
            || commandLine.Contains("email-auto-sending-automation", StringComparison.OrdinalIgnoreCase)
            || commandLine.Contains(".next", StringComparison.OrdinalIgnoreCase);
    }

    private static bool KillProcessTree(int pid)
    {
        try
        {
            LauncherLog.Write($"Stopping Email Finder dev process PID {pid}…");
            using var process = Process.GetProcessById(pid);
            process.Kill(entireProcessTree: true);
            process.WaitForExit(8000);
            return true;
        }
        catch (Exception ex)
        {
            LauncherLog.Write($"Could not stop PID {pid}: {ex.Message}");
            return false;
        }
    }

    public static bool IsProcessRunning(int pid)
    {
        try
        {
            var process = Process.GetProcessById(pid);
            return !process.HasExited;
        }
        catch
        {
            return false;
        }
    }

    private static string? GetCommandLine(int pid)
    {
        try
        {
            using var searcher = new ManagementObjectSearcher(
                $"SELECT CommandLine FROM Win32_Process WHERE ProcessId = {pid}");
            foreach (var obj in searcher.Get())
            {
                return obj["CommandLine"]?.ToString();
            }
        }
        catch (Exception ex)
        {
            LauncherLog.Write($"WMI query failed for PID {pid}: {ex.Message}");
        }

        return null;
    }
}
