namespace EmailFinderTray;

/// <summary>
/// Describes a shipped "portable" bundle: a Next.js production server
/// (server.js, launched via start.js) plus a bundled Node runtime
/// (node\node.exe) sitting next to the launcher exe. In that layout the launcher
/// runs the production server directly instead of `npm run dev`, so the target
/// PC needs nothing installed (no Node, no npm, no project checkout).
/// </summary>
internal static class PortableRuntime
{
    // Path.GetDirectoryName of the running exe. Matches how Program.cs resolves
    // the executable so a single-file self-extracting exe still reports the
    // folder it lives in (not its temp extraction dir).
    public static string ExeDir { get; } =
        Path.GetDirectoryName(Environment.ProcessPath ?? Application.ExecutablePath)
        ?? AppContext.BaseDirectory;

    public static string NodeExe => Path.Combine(ExeDir, "node", "node.exe");
    public static string ServerJs => Path.Combine(ExeDir, "server.js");
    public static string StartJs => Path.Combine(ExeDir, "start.js");

    /// <summary>
    /// The script node runs: prefer start.js (loads .env.local via @next/env,
    /// then the standalone server) and fall back to server.js if it is absent.
    /// Returned as a bare filename because the process runs with the bundle root
    /// as its working directory.
    /// </summary>
    public static string EntryScript => File.Exists(StartJs) ? "start.js" : "server.js";

    /// <summary>True when a portable production bundle sits next to the exe.</summary>
    public static bool IsBundle => File.Exists(ServerJs) && File.Exists(NodeExe);
}
