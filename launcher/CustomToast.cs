using System.Drawing.Drawing2D;
using System.Drawing.Text;

namespace EmailFinderTray;

internal enum ToastKind
{
    Info,
    Success,
    Warning,
    Error,
}

internal static class CustomToast
{
    private static CustomToastForm? _current;
    private static Image? _cachedBackground;
    private static SynchronizationContext? _ui;

    public static void Init(SynchronizationContext ui) => _ui = ui;

    public static void Show(string title, string message, ToastKind kind = ToastKind.Info, int durationMs = 6000)
    {
        if (_ui != null)
        {
            _ui.Post(_ => ShowCore(title, message, kind, durationMs), null);
            return;
        }

        ShowCore(title, message, kind, durationMs);
    }

    private static void ShowCore(string title, string message, ToastKind kind, int durationMs)
    {
        _current?.Close();
        _current?.Dispose();

        var bg = LoadBackground();
        _current = new CustomToastForm(title, message, kind, bg);
        _current.Show();
        _current.StartAutoClose(durationMs);
    }

    public static void Close()
    {
        _current?.Close();
        _current = null;
    }

    private static Image LoadBackground()
    {
        // Always draw a clean generated gradient. The old notification-bg.png
        // had the app name baked into the image, which collided with the drawn
        // title text and made the toast look doubled/broken.
        _cachedBackground ??= CreateCleanBackground();
        return _cachedBackground;
    }

    private static Bitmap CreateCleanBackground()
    {
        var bmp = new Bitmap(420, 140);
        using var g = Graphics.FromImage(bmp);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using var brush = new LinearGradientBrush(
            new Rectangle(0, 0, bmp.Width, bmp.Height),
            Color.FromArgb(15, 23, 42),
            Color.FromArgb(76, 29, 149),
            20f);
        // Three-stop blend (slate to blue to violet) for a little depth,
        // matching the app's cyan/indigo theme. No text, no logo.
        brush.InterpolationColors = new ColorBlend
        {
            Colors =
            [
                Color.FromArgb(15, 23, 42),
                Color.FromArgb(30, 58, 138),
                Color.FromArgb(76, 29, 149),
            ],
            Positions = [0f, 0.55f, 1f],
        };
        g.FillRectangle(brush, 0, 0, bmp.Width, bmp.Height);
        return bmp;
    }
}

internal sealed class CustomToastForm : Form
{
    private const int AccentWidth = 5;

    private readonly System.Windows.Forms.Timer _closeTimer = new() { Interval = 100 };
    private readonly Image _background;
    private readonly string _title;
    private readonly string _message;
    private readonly ToastKind _kind;
    private readonly Color _accent;
    private readonly string _iconText;
    private Rectangle _closeBounds;
    private bool _closeHover;

    public CustomToastForm(string title, string message, ToastKind kind, Image background)
    {
        _title = title;
        _message = message.Length > 220 ? message[..217] + "…" : message;
        _kind = kind;
        _background = background;
        _accent = kind switch
        {
            ToastKind.Success => Color.FromArgb(34, 197, 94),
            ToastKind.Warning => Color.FromArgb(234, 179, 8),
            ToastKind.Error => Color.FromArgb(239, 68, 68),
            _ => Color.FromArgb(59, 130, 246),
        };
        _iconText = kind switch
        {
            ToastKind.Success => "✓",
            ToastKind.Warning => "!",
            ToastKind.Error => "✕",
            _ => "ℹ",
        };

        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        Size = new Size(420, 140);
        BackColor = Color.FromArgb(30, 58, 138);
        Font = new Font("Segoe UI", 9.5f);
        DoubleBuffered = true;
        Cursor = Cursors.Default;

        ApplyRoundedCorners();
        PositionNearTray();
    }

    public void StartAutoClose(int durationMs)
    {
        var remaining = durationMs;
        _closeTimer.Tick += (_, _) =>
        {
            remaining -= _closeTimer.Interval;
            if (remaining <= 0)
            {
                _closeTimer.Stop();
                Close();
            }
        };
        _closeTimer.Start();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;

        g.DrawImage(_background, 0, 0, Width, Height);

        using (var accentBrush = new SolidBrush(_accent))
        {
            g.FillRectangle(accentBrush, 0, 0, AccentWidth, Height);
        }

        using var iconFont = new Font("Segoe UI", 16f, FontStyle.Bold);
        using var titleFont = new Font("Segoe UI", 11f, FontStyle.Bold);
        using var bodyFont = new Font("Segoe UI", 9.5f, FontStyle.Regular);
        using var closeFont = new Font("Segoe UI", 14f, FontStyle.Regular);
        using var iconBrush = new SolidBrush(_accent);
        using var titleBrush = new SolidBrush(Color.White);
        using var bodyBrush = new SolidBrush(Color.FromArgb(226, 232, 240));
        using var closeBrush = new SolidBrush(
            _closeHover ? Color.White : Color.FromArgb(148, 163, 184));

        g.DrawString(_iconText, iconFont, iconBrush, 18, 16);
        g.DrawString(_title, titleFont, titleBrush, 52, 14);

        var bodyRect = new RectangleF(52, 40, Width - 64, Height - 48);
        g.DrawString(_message, bodyFont, bodyBrush, bodyRect);

        var closeSize = g.MeasureString("×", closeFont);
        _closeBounds = new Rectangle(
            Width - (int)closeSize.Width - 14,
            8,
            (int)closeSize.Width + 4,
            (int)closeSize.Height + 4);
        g.DrawString("×", closeFont, closeBrush, _closeBounds.X + 2, _closeBounds.Y);
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        base.OnMouseMove(e);
        var hover = _closeBounds.Contains(e.Location);
        if (hover == _closeHover)
        {
            return;
        }

        _closeHover = hover;
        Cursor = hover ? Cursors.Hand : Cursors.Default;
        Invalidate(_closeBounds);
    }

    protected override void OnMouseClick(MouseEventArgs e)
    {
        base.OnMouseClick(e);
        if (_closeBounds.Contains(e.Location))
        {
            Close();
        }
    }

    private void ApplyRoundedCorners()
    {
        using var path = new GraphicsPath();
        const int radius = 14;
        var rect = ClientRectangle;
        path.AddArc(rect.X, rect.Y, radius * 2, radius * 2, 180, 90);
        path.AddArc(rect.Right - radius * 2, rect.Y, radius * 2, radius * 2, 270, 90);
        path.AddArc(rect.Right - radius * 2, rect.Bottom - radius * 2, radius * 2, radius * 2, 0, 90);
        path.AddArc(rect.X, rect.Bottom - radius * 2, radius * 2, radius * 2, 90, 90);
        path.CloseFigure();
        Region = new Region(path);
    }

    private void PositionNearTray()
    {
        var screen = Screen.FromPoint(Cursor.Position).WorkingArea;
        Location = new Point(
            screen.Right - Width - 12,
            screen.Bottom - Height - 12);
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        _closeTimer.Dispose();
        base.OnFormClosed(e);
    }

    protected override CreateParams CreateParams
    {
        get
        {
            const int WS_EX_TOOLWINDOW = 0x00000080;
            var cp = base.CreateParams;
            cp.ExStyle |= WS_EX_TOOLWINDOW;
            return cp;
        }
    }
}
