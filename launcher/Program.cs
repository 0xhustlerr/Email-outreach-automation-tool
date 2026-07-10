using System.Runtime.InteropServices;

namespace EmailFinderTray;

internal static class Program
{
    private const string MutexName = "EmailFinderTray.SingleInstance";
    private const string AppUserModelId = "EmailFinder.Tray.Launcher.1";

    [STAThread]
    private static void Main()
    {
        try
        {
            WebView2Bootstrap.ConfigureLoaderSearchPath();
            NativeMethods.SetCurrentProcessExplicitAppUserModelID(AppUserModelId);
            ApplicationConfiguration.Initialize();
            Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);

            var projectRoot = ResolveProjectRoot();
            using var mutex = new Mutex(true, MutexName, out var createdNew);

            if (!createdNew)
            {
                MessageBox.Show(
                    "Cold Outreach Command Center is already running.\n\n" +
                    "Look for the mail icon in the system tray (click ^ near the clock).",
                    "Cold Outreach Command Center",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
                return;
            }

            Application.Run(new TrayHost(projectRoot));
        }
        catch (Exception ex)
        {
            var logDir = Path.GetDirectoryName(Environment.ProcessPath ?? Application.ExecutablePath) ?? ".";
            var logPath = Path.Combine(logDir, "email-finder-launcher.log");
            try
            {
                File.AppendAllText(logPath, $"[{DateTime.Now:HH:mm:ss}] FATAL: {ex}\r\n");
            }
            catch
            {
                // ignore
            }

            MessageBox.Show(
                "Cold Outreach Command Center could not start.\n\n" + ex.Message +
                "\n\nDetails were written to:\n" + logPath,
                "Cold Outreach Command Center",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }

    private static string ResolveProjectRoot()
    {
        var exePath = Environment.ProcessPath ?? Application.ExecutablePath;
        var exeDir = Path.GetDirectoryName(exePath)!;

        if (File.Exists(Path.Combine(exeDir, "package.json")))
        {
            return exeDir;
        }

        var baseDir = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (File.Exists(Path.Combine(baseDir, "package.json")))
        {
            return baseDir;
        }

        var parent = Directory.GetParent(exeDir)?.FullName;
        if (parent != null && File.Exists(Path.Combine(parent, "package.json")))
        {
            return parent;
        }

        return exeDir;
    }

    private static class NativeMethods
    {
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        public static extern int SetCurrentProcessExplicitAppUserModelID(string appId);
    }
}
