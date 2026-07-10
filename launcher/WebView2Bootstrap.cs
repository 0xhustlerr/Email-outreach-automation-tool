using Microsoft.Web.WebView2.Core;

namespace EmailFinderTray;

internal static class WebView2Bootstrap
{
    public static void ConfigureLoaderSearchPath()
    {
        foreach (var folder in FindLoaderFolders())
        {
            try
            {
                CoreWebView2Environment.SetLoaderDllFolderPath(folder);
                return;
            }
            catch (InvalidOperationException)
            {
                return;
            }
            catch
            {
                // try next folder
            }
        }
    }

    public static string? GetBrowserVersion()
    {
        try
        {
            return CoreWebView2Environment.GetAvailableBrowserVersionString();
        }
        catch
        {
            return null;
        }
    }

    private static IEnumerable<string> FindLoaderFolders()
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var bases = new[]
        {
            Path.GetDirectoryName(Environment.ProcessPath ?? Application.ExecutablePath),
            AppContext.BaseDirectory,
        };

        foreach (var baseDir in bases)
        {
            if (string.IsNullOrWhiteSpace(baseDir))
            {
                continue;
            }

            foreach (var sub in new[] { "", "runtimes\\win-x64\\native" })
            {
                var folder = string.IsNullOrEmpty(sub) ? baseDir : Path.Combine(baseDir, sub);
                if (!seen.Add(folder))
                {
                    continue;
                }

                if (File.Exists(Path.Combine(folder, "WebView2Loader.dll")))
                {
                    yield return folder;
                }
            }
        }
    }
}
