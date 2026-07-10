using System.Diagnostics;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace EmailFinderTray;

internal sealed class AppWindow : Form
{
    private readonly WebView2 _webView = new() { Dock = DockStyle.Fill };
    private string? _pendingUrl;
    private bool _webReady;
    private bool _forceClose;

    public AppWindow()
    {
        Icon = IconLoader.LoadFormIcon();
        Text = "Cold Outreach Command Center";
        ShowIcon = true;
        ShowInTaskbar = true;
        Size = new Size(1280, 840);
        MinimumSize = new Size(900, 600);
        StartPosition = FormStartPosition.CenterScreen;
        Controls.Add(_webView);
        FormClosing += OnFormClosing;
    }

    public async Task ShowAndNavigateAsync(string url)
    {
        _pendingUrl = url;

        if (!IsHandleCreated)
        {
            Show();
            Activate();
        }
        else if (!Visible)
        {
            Show();
            Activate();
        }

        await EnsureWebViewAsync();
        if (_webReady && _webView.CoreWebView2 != null)
        {
            _webView.CoreWebView2.Navigate(url);
        }
    }

    public void BringToFrontWindow()
    {
        if (!Visible)
        {
            Show();
        }

        WindowState = FormWindowState.Normal;
        Activate();
        BringToFront();
    }

    private async Task EnsureWebViewAsync()
    {
        if (_webReady)
        {
            return;
        }

        try
        {
            var browserVersion = WebView2Bootstrap.GetBrowserVersion();
            if (string.IsNullOrEmpty(browserVersion))
            {
                throw new InvalidOperationException(
                    "Microsoft Edge WebView2 Runtime is not installed.");
            }

            await _webView.EnsureCoreWebView2Async();
            _webReady = true;

            if (!string.IsNullOrEmpty(_pendingUrl))
            {
                _webView.CoreWebView2!.Navigate(_pendingUrl);
            }
        }
        catch (Exception ex)
        {
            LauncherLog.Write($"WebView2 init failed: {ex}");
            var openChrome = MessageBox.Show(
                "Could not start the in-app browser (WebView2).\n\n" +
                ex.Message +
                "\n\nInstall Microsoft Edge WebView2 Runtime:\n" +
                "https://go.microsoft.com/fwlink/p/?LinkId=2124703\n\n" +
                "Open the app in Chrome instead?",
                "Cold Outreach Command Center",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning);

            if (openChrome == DialogResult.Yes && !string.IsNullOrEmpty(_pendingUrl))
            {
                try
                {
                    Process.Start(new ProcessStartInfo(_pendingUrl) { UseShellExecute = true });
                }
                catch (Exception openEx)
                {
                    LauncherLog.Write($"Open browser failed: {openEx}");
                }
            }
        }
    }

    public void ForceClose()
    {
        _forceClose = true;
        Close();
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        if (!_forceClose && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _webView.Dispose();
        }

        base.Dispose(disposing);
    }
}
