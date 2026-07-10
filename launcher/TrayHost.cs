using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace EmailFinderTray;

internal sealed class TrayHost : ApplicationContext
{
    private const string PackageName = "email-auto-sending-automation";
    private const int StartupGraceSeconds = 120;

    private readonly string _projectRoot;
    private readonly SynchronizationContext _ui;
    private readonly NotifyIcon _tray;
    private readonly ToolStripMenuItem _openAppItem;
    private AppWindow? _appWindow;
    private WidgetWindow? _widgetWindow;
    private TrayReplySyncService? _replySync;
    private readonly ToolStripMenuItem _statusItem;

    // Reply-alert state: unseen replies drive a pop-up dialog + a red tray badge.
    private readonly Icon _baseTrayIcon;
    private Icon? _badgedIcon;
    private ReplyAlertDialog? _replyDialog;
    private readonly List<TrayReplyNotification> _unseenReplies = [];

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyIcon(IntPtr handle);
    // Per-request timeouts are set in NextDevManager.IsAppReadyAsync; do not cap the client at 8s.
    private readonly HttpClient _http = new() { Timeout = Timeout.InfiniteTimeSpan };

    private Process? _devServer;
    private DateTime _serverStartedAt;
    private int _port;
    private string? _appUrl;
    private bool _serverReady;
    private bool _exiting;
    private bool _ownsServer;
    private int _healthCheckFailures;
    private int _serverStartAttempts;
    private bool _attachedOnly;

    public TrayHost(string projectRoot)
    {
        _projectRoot = projectRoot;
        _ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        CustomToast.Init(_ui);
        LauncherLog.Init(projectRoot);
        LauncherLog.Write($"Project root: {projectRoot}");

        _openAppItem = new ToolStripMenuItem("Open app window", null, async (_, _) => await OpenAppWindowAsync());
        _statusItem = new ToolStripMenuItem("Starting…") { Enabled = false };

        var menu = new ContextMenuStrip();
        menu.Items.Add(_openAppItem);
        menu.Items.Add(new ToolStripMenuItem("Widget", null, async (_, _) => await OpenWidgetAsync()));
        menu.Items.Add(new ToolStripMenuItem("Open in Chrome", null, async (_, _) => await OpenInChromeAsync()));
        menu.Items.Add(new ToolStripMenuItem("Sync replies now", null, async (_, _) => await SyncRepliesNowAsync()));
        menu.Items.Add(_statusItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Open log file", null, (_, _) => OpenLogFile()));
        menu.Items.Add(new ToolStripMenuItem("Restart server", null, async (_, _) => await RestartAsync()));
        menu.Items.Add(new ToolStripMenuItem("Quit", null, (_, _) => Exit()));

        Icon trayIcon;
        try
        {
            trayIcon = IconLoader.LoadTrayIcon();
        }
        catch (Exception ex)
        {
            LauncherLog.Write($"Tray icon load failed: {ex.Message}");
            trayIcon = SystemIcons.Application;
        }

        _baseTrayIcon = trayIcon;
        _tray = new NotifyIcon
        {
            Icon = trayIcon,
            Text = "Cold Outreach Command Center - starting…",
            Visible = true,
            ContextMenuStrip = menu,
        };
        // Clicking the tray icon opens the reply dialog when there are unseen
        // replies; otherwise it opens the app window as before.
        _tray.DoubleClick += async (_, _) =>
        {
            if (_unseenReplies.Count > 0)
            {
                ShowReplyDialog();
            }
            else
            {
                await OpenAppWindowAsync();
            }
        };

        ShowBalloon(
            "Cold Outreach Command Center",
            "Running in the system tray. Reply sync starts when the server is ready.",
            ToolTipIcon.Info);

        _ = StartAsync();
    }

    private async Task StartAsync()
    {
        try
        {
            if (!File.Exists(Path.Combine(_projectRoot, "package.json")))
            {
                Fail("package.json not found.\nKeep Email Finder.exe in the project folder.");
                return;
            }

            // A portable production bundle carries its own server + Node, so the
            // strict project-folder check (which asserts the dev package.json name)
            // does not apply.
            if (!PortableRuntime.IsBundle && !ValidatePackage())
            {
                Fail("Wrong folder: this launcher must stay in email-auto-sending-automation.");
                return;
            }

            if (!Toolchain.TryInitialize(out var toolchainError))
            {
                Fail(toolchainError!);
                return;
            }

            LauncherLog.Write(Toolchain.IsPortable
                ? $"Portable bundle: using bundled node {PortableRuntime.NodeExe}"
                : $"Using npm: {Toolchain.NpmPath}");

            await EnsureDependenciesAsync();
            await StartServerWithRetryAsync();
            _ = WaitForReadyAndNotifyAsync();
        }
        catch (Exception ex)
        {
            LauncherLog.Write($"StartAsync error: {ex}");
            Fail(ex.Message);
        }
    }

    private bool ValidatePackage()
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(_projectRoot, "package.json")));
            return doc.RootElement.TryGetProperty("name", out var name)
                && name.GetString() == PackageName;
        }
        catch
        {
            return false;
        }
    }

    private async Task EnsureDependenciesAsync()
    {
        if (Directory.Exists(Path.Combine(_projectRoot, "node_modules")))
        {
            return;
        }

        SetStatus("Installing npm packages…");
        ShowBalloon("Cold Outreach Command Center", "Installing dependencies (first run)…", ToolTipIcon.Info);
        LauncherLog.Write("Running npm install…");

        var exit = await RunNpmAsync("install", _projectRoot);
        if (exit != 0)
        {
            throw new InvalidOperationException($"npm install failed (exit {exit}). See {LauncherLog.LogPath}");
        }
    }

    private async Task StartServerWithRetryAsync()
    {
        for (_serverStartAttempts = 1; _serverStartAttempts <= 2; _serverStartAttempts++)
        {
            NextDevManager.ForceClearStaleNextLock(_projectRoot);
            await StartServerAsync();

            await Task.Delay(3000);
            if (_devServer is not { HasExited: true })
            {
                return;
            }

            var log = LauncherLog.ReadTail(40);
            if (!log.Contains("Another next dev server is already running", StringComparison.Ordinal))
            {
                return;
            }

            LauncherLog.Write("Next.js reported a stale dev lock - clearing and retrying…");
            if (NextDevManager.TryParseConflictPid(log, out var conflictPid))
            {
                ProcessGuard.TryStopLockHolder(conflictPid, _projectRoot);
            }

            NextDevManager.ForceClearStaleNextLock(_projectRoot);
            StopServer();
        }
    }

    private async Task StartServerAsync()
    {
        StopServer();
        _healthCheckFailures = 0;
        _serverReady = false;
        _openAppItem.Enabled = false;
        _serverStartedAt = DateTime.UtcNow;
        _ownsServer = false;

        // Portable bundle: run the standalone production server instead of the
        // dev toolchain (no npm, no .next/dev locks, no webpack recovery).
        if (PortableRuntime.IsBundle)
        {
            await StartProductionServerAsync();
            return;
        }

        var attach = await NextDevManager.TryAttachOrPreparePortAsync(_http, _projectRoot);
        if (attach.Attached)
        {
            _port = attach.Port;
            _appUrl = attach.Url;
            _attachedOnly = true;
            SetStatus($"Using server on port {_port}…");
            LauncherLog.Write($"Attached to existing server at {_appUrl}");
            return;
        }

        _attachedOnly = false;

        _port = NextDevManager.DevPort;
        _appUrl = NextDevManager.DevUrl;
        _ownsServer = true;

        SetStatus($"Starting on port {_port}…");
        ShowBalloon("Cold Outreach Command Center", $"Starting server on port {_port}…", ToolTipIcon.Info);
        LauncherLog.Write($"Starting dev server on port {_port}");

        var psi = new ProcessStartInfo
        {
            FileName = Toolchain.NpmPath!,
            Arguments = "run dev",
            WorkingDirectory = _projectRoot,
            CreateNoWindow = true,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        Toolchain.ApplyTo(psi);

        _devServer = Process.Start(psi)
            ?? throw new InvalidOperationException("Could not start npm run dev.");

        ProcessGuard.SaveOwnedProcess(_projectRoot, _devServer.Id, _port);

        _devServer.EnableRaisingEvents = true;
        _devServer.OutputDataReceived += (_, e) =>
        {
            if (!string.IsNullOrWhiteSpace(e.Data))
            {
                LauncherLog.Write($"[npm] {e.Data}");
            }
        };
        _devServer.ErrorDataReceived += (_, e) =>
        {
            if (!string.IsNullOrWhiteSpace(e.Data))
            {
                LauncherLog.Write($"[npm err] {e.Data}");
            }
        };
        _devServer.BeginOutputReadLine();
        _devServer.BeginErrorReadLine();
        _devServer.Exited += OnDevServerExited;

        await Task.Delay(200);
    }

    // Portable bundle path: launch `node start.js` (which loads .env.local via
    // @next/env then boots the standalone server) on the same port the dev flow
    // uses, so health checks, reply sync and the WebView all work unchanged.
    private async Task StartProductionServerAsync()
    {
        _port = NextDevManager.DevPort;
        _appUrl = NextDevManager.DevUrl;

        // If a server from a previous session is still serving, attach to it.
        if (await NextDevManager.IsOurAppOnDevPortAsync(_http))
        {
            _attachedOnly = true;
            _ownsServer = false;
            SetStatus($"Using server on port {_port}…");
            LauncherLog.Write($"Attached to existing server at {_appUrl}");
            return;
        }

        _attachedOnly = false;
        _ownsServer = true;

        SetStatus($"Starting on port {_port}…");
        ShowBalloon("Cold Outreach Command Center", $"Starting server on port {_port}…", ToolTipIcon.Info);
        LauncherLog.Write($"Starting production server on port {_port} (portable bundle)");

        var psi = new ProcessStartInfo
        {
            FileName = PortableRuntime.NodeExe,
            Arguments = $"\"{PortableRuntime.EntryScript}\"",
            WorkingDirectory = _projectRoot,
            CreateNoWindow = true,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        Toolchain.ApplyTo(psi);
        psi.Environment["NODE_ENV"] = "production";
        psi.Environment["PORT"] = _port.ToString();
        psi.Environment["HOSTNAME"] = "127.0.0.1";

        _devServer = Process.Start(psi)
            ?? throw new InvalidOperationException("Could not start the production server.");

        ProcessGuard.SaveOwnedProcess(_projectRoot, _devServer.Id, _port);

        _devServer.EnableRaisingEvents = true;
        _devServer.OutputDataReceived += (_, e) =>
        {
            if (!string.IsNullOrWhiteSpace(e.Data))
            {
                LauncherLog.Write($"[server] {e.Data}");
            }
        };
        _devServer.ErrorDataReceived += (_, e) =>
        {
            if (!string.IsNullOrWhiteSpace(e.Data))
            {
                LauncherLog.Write($"[server err] {e.Data}");
            }
        };
        _devServer.BeginOutputReadLine();
        _devServer.BeginErrorReadLine();
        _devServer.Exited += OnDevServerExited;

        await Task.Delay(200);
    }

    private void OnDevServerExited(object? sender, EventArgs e)
    {
        if (_exiting || _serverReady || !_ownsServer)
        {
            return;
        }

        var elapsed = DateTime.UtcNow - _serverStartedAt;
        if (elapsed.TotalSeconds < StartupGraceSeconds)
        {
            LauncherLog.Write($"Dev process exited during startup grace ({elapsed.TotalSeconds:0}s).");
            return;
        }

        var code = _devServer?.ExitCode;
        LauncherLog.Write($"Dev process exited with code {code}.");
        PostToUi(() => Fail($"Dev server stopped (exit code {code}).\nSee log:\n{LauncherLog.LogPath}"));
    }

    private async Task WaitForReadyAndNotifyAsync()
    {
        for (var i = 0; i < 180; i++)
        {
            if (_exiting)
            {
                return;
            }

            if (await IsThisAppReadyAsync(_appUrl!))
            {
                _serverReady = true;
                _openAppItem.Enabled = true;
                SetStatus($"Running - {_appUrl}");
                ShowBalloon(
                    "Cold Outreach Command Center",
                    "Server is ready. History sync runs in the background - open the app anytime.",
                    ToolTipIcon.Info);
                LauncherLog.Write("Server ready.");
                StartBackgroundReplySync();
                return;
            }

            if (_attachedOnly && i == 20)
            {
                LauncherLog.Write("Attached server never responded - starting a fresh dev server…");
                _attachedOnly = false;
                await NextDevManager.RecoverHungDevServerAsync(_http, _projectRoot);
                ForceStopProjectDevServer();
                await StartServerWithRetryAsync();
            }

            if (_devServer is { HasExited: true })
            {
                var graceLeft = StartupGraceSeconds - (DateTime.UtcNow - _serverStartedAt).TotalSeconds;
                if (graceLeft <= 0)
                {
                    var code = _devServer.ExitCode;
                    Fail($"Dev server exited before the app was ready (exit {code}).\n{LauncherLog.ReadTail()}");
                    return;
                }
            }

            await Task.Delay(1000);
        }

        Fail($"Timed out waiting for the app at {_appUrl}.\n{LauncherLog.ReadTail()}");
    }

    private async Task<bool> IsThisAppReadyAsync(string url)
    {
        var timeoutSeconds = _healthCheckFailures < 12 ? 60 : 10;
        var ready = await NextDevManager.IsAppReadyAsync(_http, url, timeoutSeconds);
        if (!ready)
        {
            _healthCheckFailures++;
            if (_healthCheckFailures == 1)
            {
                SetStatus("Compiling… (first load can take 1–2 min)");
                ShowBalloon("Cold Outreach Command Center", "Compiling the app - please wait…", ToolTipIcon.Info);
            }
            else if (_healthCheckFailures % 10 == 0)
            {
                LauncherLog.Write($"Still waiting for app at {url}…");
                SetStatus($"Still compiling… ({_healthCheckFailures * 10}s)");
            }
        }

        return ready;
    }

    private void StartBackgroundReplySync()
    {
        if (_replySync != null || string.IsNullOrEmpty(_appUrl))
        {
            return;
        }

        _replySync = new TrayReplySyncService(_http, _appUrl, _projectRoot, _ui);
        _replySync.NewReplies += OnNewReplies;
        LauncherLog.Write("Tray background reply sync started.");
    }

    // New replies arrived (fires on the UI thread). Accumulate them, raise the
    // red tray badge, pop up the alert dialog, and nudge with a toast.
    private void OnNewReplies(IReadOnlyList<TrayReplyNotification> replies)
    {
        if (_exiting || replies.Count == 0)
        {
            return;
        }

        foreach (var r in replies)
        {
            if (r.Row <= 0)
            {
                continue;
            }

            var existing = _unseenReplies.FindIndex(x => x.Row == r.Row);
            if (existing >= 0)
            {
                _unseenReplies[existing] = r;
            }
            else
            {
                _unseenReplies.Add(r);
            }
        }

        LauncherLog.Write($"Tray reply alert: {_unseenReplies.Count} unseen reply(ies).");
        UpdateTrayBadge(_unseenReplies.Count);
        // Only the rich reply dialog fires — the small blue toast was a noisy
        // duplicate of the same event.
        ShowReplyDialog();
    }

    private void ShowReplyDialog()
    {
        if (_unseenReplies.Count == 0)
        {
            return;
        }

        if (_replyDialog is not { IsDisposed: false })
        {
            _replyDialog = new ReplyAlertDialog(
                _http,
                _appUrl,
                onOpenApp: () => _ = OpenAppWindowAsync(),
                onAcknowledge: AcknowledgeReplies);
        }

        _replyDialog.SetReplies(_unseenReplies);
        if (!_replyDialog.Visible)
        {
            _replyDialog.Show();
        }

        _replyDialog.Activate();
        _replyDialog.BringToFront();
        _replyDialog.TopMost = true;
    }

    private void AcknowledgeReplies()
    {
        _unseenReplies.Clear();
        _replyDialog = null;
        UpdateTrayBadge(0);
    }

    // Draws a red count badge over the tray icon, or restores the plain icon
    // when count is 0. Recreates the composited HICON each change.
    private void UpdateTrayBadge(int count)
    {
        _tray.Text = count > 0
            ? $"Cold Outreach Command Center - {count} new reply(ies)"
            : "Cold Outreach Command Center";

        var previous = _badgedIcon;

        if (count <= 0)
        {
            _tray.Icon = _baseTrayIcon;
            _badgedIcon = null;
        }
        else
        {
            _badgedIcon = CreateBadgedIcon(_baseTrayIcon, count);
            _tray.Icon = _badgedIcon;
        }

        if (previous != null)
        {
            var handle = previous.Handle;
            previous.Dispose();
            DestroyIcon(handle);
        }
    }

    private static Icon CreateBadgedIcon(Icon baseIcon, int count)
    {
        using var bmp = baseIcon.ToBitmap();
        var size = Math.Max(bmp.Width, 16);
        using var canvas = new Bitmap(size, size);
        using (var g = Graphics.FromImage(canvas))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.DrawImage(bmp, 0, 0, size, size);

            var d = (int)(size * 0.66);
            var x = size - d;
            var y = 0;
            using var red = new SolidBrush(Color.FromArgb(220, 38, 38));
            using var ring = new Pen(Color.White, Math.Max(1f, size / 22f));
            g.FillEllipse(red, x, y, d - 1, d - 1);
            g.DrawEllipse(ring, x, y, d - 1, d - 1);

            var text = count > 9 ? "9+" : count.ToString();
            using var font = new Font("Segoe UI", d * 0.46f, FontStyle.Bold, GraphicsUnit.Pixel);
            using var white = new SolidBrush(Color.White);
            var sf = new StringFormat
            {
                Alignment = StringAlignment.Center,
                LineAlignment = StringAlignment.Center,
            };
            g.DrawString(text, font, white, new RectangleF(x, y, d, d), sf);
        }

        var hIcon = canvas.GetHicon();
        using var composed = Icon.FromHandle(hIcon);
        var clone = (Icon)composed.Clone();
        DestroyIcon(hIcon);
        return clone;
    }

    private async Task OpenAppWindowAsync()
    {
        if (!await EnsureServerReadyForUiAsync())
        {
            return;
        }

        try
        {
            _appWindow ??= new AppWindow();
            await _appWindow.ShowAndNavigateAsync(_appUrl!);
        }
        catch (Exception ex)
        {
            LauncherLog.Write($"OpenAppWindow: {ex}");
            ShowBalloon("Cold Outreach Command Center", ex.Message, ToolTipIcon.Error);
        }
    }

    private async Task OpenWidgetAsync()
    {
        if (!await EnsureServerReadyForUiAsync())
        {
            return;
        }

        try
        {
            _widgetWindow ??= new WidgetWindow(_appUrl!, _http);
            _widgetWindow.ShowWidget();
        }
        catch (Exception ex)
        {
            LauncherLog.Write($"OpenWidget: {ex}");
            _widgetWindow?.Dispose();
            _widgetWindow = null;
            ShowBalloon("Cold Outreach Command Center", ex.Message, ToolTipIcon.Error);
        }
    }

    private async Task<bool> EnsureServerReadyForUiAsync()
    {
        if (string.IsNullOrEmpty(_appUrl))
        {
            ShowBalloon("Cold Outreach Command Center", "Server is still starting…", ToolTipIcon.Info);
            return false;
        }

        if (!await NextDevManager.IsAppReadyAsync(_http, _appUrl, 15))
        {
            ShowBalloon("Cold Outreach Command Center", "Server is not responding yet. Wait a moment and try again.", ToolTipIcon.Warning);
            return false;
        }

        return true;
    }

    private async Task SyncRepliesNowAsync()
    {
        if (!await EnsureServerReadyForUiAsync())
        {
            return;
        }

        StartBackgroundReplySync();
        if (_replySync == null)
        {
            return;
        }

        try
        {
            await _replySync.RunNowAsync();
            ShowBalloon("Cold Outreach Command Center", "Reply sync finished.", ToolTipIcon.Info);
        }
        catch (Exception ex)
        {
            ShowBalloon("Cold Outreach Command Center", ex.Message, ToolTipIcon.Error);
        }
    }

    private async Task OpenInChromeAsync()
    {
        if (!await EnsureServerReadyForUiAsync())
        {
            return;
        }

        try
        {
            var chromePaths = new[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google", "Chrome", "Application", "chrome.exe"),
                Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA") ?? "", "Google", "Chrome", "Application", "chrome.exe"),
            };

            var chrome = chromePaths.FirstOrDefault(File.Exists);
            if (chrome != null)
            {
                Process.Start(new ProcessStartInfo(chrome, _appUrl) { UseShellExecute = true });
            }
            else
            {
                Process.Start(new ProcessStartInfo(_appUrl) { UseShellExecute = true });
            }
        }
        catch (Exception ex)
        {
            ShowBalloon("Cold Outreach Command Center", ex.Message, ToolTipIcon.Error);
        }
    }

    private void OpenLogFile()
    {
        try
        {
            if (File.Exists(LauncherLog.LogPath))
            {
                Process.Start(new ProcessStartInfo(LauncherLog.LogPath) { UseShellExecute = true });
            }
            else
            {
                ShowBalloon("Cold Outreach Command Center", "No log file yet.", ToolTipIcon.Info);
            }
        }
        catch (Exception ex)
        {
            ShowBalloon("Cold Outreach Command Center", ex.Message, ToolTipIcon.Error);
        }
    }

    private async Task RestartAsync()
    {
        SetStatus("Restarting…");
        ForceStopProjectDevServer();
        await StartServerWithRetryAsync();
        _ = WaitForReadyAndNotifyAsync();
    }

    private void ForceStopProjectDevServer()
    {
        var launchedPid = _devServer is { HasExited: false } ? _devServer.Id : (int?)null;
        StopServer();
        NextDevManager.StopOwnedDevProcesses(_projectRoot, launchedPid);
    }

    private void StopServer()
    {
        if (!_ownsServer || _devServer == null)
        {
            return;
        }

        try
        {
            if (!_devServer.HasExited)
            {
                _devServer.Kill(entireProcessTree: true);
                _devServer.WaitForExit(5000);
            }
        }
        catch (Exception ex)
        {
            LauncherLog.Write($"StopServer: {ex.Message}");
        }
        finally
        {
            _devServer.Dispose();
            _devServer = null;
            ProcessGuard.ClearOwnedProcess(_projectRoot);
        }
    }

    private static Task<int> RunNpmAsync(string arguments, string workingDirectory)
    {
        var tcs = new TaskCompletionSource<int>();
        var psi = new ProcessStartInfo
        {
            FileName = Toolchain.NpmPath!,
            Arguments = arguments,
            WorkingDirectory = workingDirectory,
            CreateNoWindow = true,
            UseShellExecute = false,
        };
        Toolchain.ApplyTo(psi);

        var process = Process.Start(psi);
        if (process == null)
        {
            tcs.SetException(new InvalidOperationException("Failed to start npm."));
            return tcs.Task;
        }

        process.EnableRaisingEvents = true;
        process.Exited += (_, _) =>
        {
            tcs.TrySetResult(process.ExitCode);
            process.Dispose();
        };

        return tcs.Task;
    }

    private void PostToUi(Action action)
    {
        _ui.Post(_ => action(), null);
    }

    private void SetStatus(string text)
    {
        _statusItem.Text = text;
        _tray.Text = text.Length > 63 ? text[..63] : text;
    }

    private void ShowBalloon(string title, string text, ToolTipIcon icon)
    {
        var kind = icon switch
        {
            ToolTipIcon.Error => ToastKind.Error,
            ToolTipIcon.Warning => ToastKind.Warning,
            ToolTipIcon.Info => ToastKind.Info,
            _ => ToastKind.Info,
        };

        if (title.Contains("ready", StringComparison.OrdinalIgnoreCase)
            || text.Contains("ready", StringComparison.OrdinalIgnoreCase))
        {
            kind = ToastKind.Success;
        }

        CustomToast.Show(title, text, kind);
    }

    private void Fail(string message)
    {
        if (_exiting)
        {
            return;
        }

        var log = LauncherLog.ReadTail();
        if (log.Contains("Another next dev server is already running", StringComparison.Ordinal))
        {
            message =
                "Next.js left a stale lock file (.next\\dev\\lock) for this folder.\n\n" +
                "No server may actually be running. Try:\n" +
                "1. Tray menu → Restart server\n" +
                "2. Or delete: .next\\dev\\lock\n\n" +
                "This launcher does not stop other projects.";
        }

        LauncherLog.Write($"ERROR: {message}");
        SetStatus("Error - see log");
        ShowBalloon("Cold Outreach Command Center", message, ToolTipIcon.Error);
        MessageBox.Show(
            message + Environment.NewLine + Environment.NewLine + "Log: " + LauncherLog.LogPath,
            "Cold Outreach Command Center",
            MessageBoxButtons.OK,
            MessageBoxIcon.Error);
    }

    private void Exit()
    {
        _exiting = true;
        _replySync?.Dispose();
        _replySync = null;
        _replyDialog?.Dispose();
        _replyDialog = null;
        _badgedIcon?.Dispose();
        _badgedIcon = null;
        CustomToast.Close();
        if (_appWindow != null)
        {
            _appWindow.ForceClose();
            _appWindow.Dispose();
            _appWindow = null;
        }

        if (_widgetWindow != null)
        {
            _widgetWindow.Dispose();
            _widgetWindow = null;
        }

        if (_ownsServer)
        {
            StopServer();
        }

        _tray.Visible = false;
        _tray.Dispose();
        _http.Dispose();
        ExitThread();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _exiting = true;
            _replySync?.Dispose();
            _replySync = null;
            _replyDialog?.Dispose();
            _replyDialog = null;
            _badgedIcon?.Dispose();
            _badgedIcon = null;
            _appWindow?.Dispose();
            _widgetWindow?.Dispose();
            if (_ownsServer)
            {
                StopServer();
            }

            _tray.Dispose();
            _http.Dispose();
        }

        base.Dispose(disposing);
    }
}
