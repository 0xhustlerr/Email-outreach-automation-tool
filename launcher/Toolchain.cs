using System.Diagnostics;

namespace EmailFinderTray;

internal static class Toolchain
{
    public static string? NodeDirectory { get; private set; }
    public static string? NpmPath { get; private set; }

    /// <summary>True when running from a portable bundle with a bundled Node.</summary>
    public static bool IsPortable { get; private set; }

    public static bool TryInitialize(out string? error)
    {
        // Portable bundle: use the bundled node\node.exe and skip the system
        // Node/npm discovery entirely (npm is not needed to run the standalone
        // production server).
        if (PortableRuntime.IsBundle)
        {
            NodeDirectory = Path.GetDirectoryName(PortableRuntime.NodeExe);
            NpmPath = null;
            IsPortable = true;
            error = null;
            return true;
        }

        IsPortable = false;
        NodeDirectory = FindNodeDirectory();
        if (NodeDirectory == null)
        {
            error = "Node.js was not found.\nInstall from https://nodejs.org/ (default location is fine).";
            return false;
        }

        var npm = Path.Combine(NodeDirectory, "npm.cmd");
        if (!File.Exists(npm))
        {
            error = $"npm.cmd was not found next to node.exe:\n{NodeDirectory}";
            return false;
        }

        NpmPath = npm;
        error = null;
        return true;
    }

    public static void ApplyTo(ProcessStartInfo psi)
    {
        foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            var key = entry.Key?.ToString();
            if (string.IsNullOrEmpty(key))
            {
                continue;
            }

            psi.Environment[key] = entry.Value?.ToString() ?? "";
        }

        if (NodeDirectory == null)
        {
            return;
        }

        psi.Environment["PATH"] = MergePath(NodeDirectory, psi.Environment.TryGetValue("PATH", out var path) ? path : "");
    }

    private static string MergePath(string nodeDir, string existing)
    {
        var parts = new List<string> { nodeDir };
        foreach (var segment in existing.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (!segment.Equals(nodeDir, StringComparison.OrdinalIgnoreCase))
            {
                parts.Add(segment);
            }
        }

        return string.Join(';', parts);
    }

    private static string? FindNodeDirectory()
    {
        var candidates = new List<string>
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs"),
            Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? "", "Programs", "nodejs"),
        };

        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            candidates.Add(dir);
        }

        foreach (var dir in candidates.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (HasNodeToolchain(dir))
            {
                return dir;
            }
        }

        return null;
    }

    private static bool HasNodeToolchain(string dir)
    {
        return File.Exists(Path.Combine(dir, "node.exe"))
            && File.Exists(Path.Combine(dir, "npm.cmd"));
    }
}
