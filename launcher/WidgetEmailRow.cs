using System.Drawing.Drawing2D;

namespace EmailFinderTray;

/// <summary>Lifecycle of an email row from discovery through delivery.</summary>
internal enum WidgetSendState
{
    Found,
    Queued,
    Sending,
    Sent,
    Failed,
}

internal sealed class WidgetEmailRow : Panel
{
    public string Email { get; }
    public string SourceLabel { get; }
    public WidgetSendState State { get; private set; } = WidgetSendState.Found;
    public bool Sent => State == WidgetSendState.Sent;

    private readonly Label _emailLabel;
    private readonly Label _sourceLabel;
    private readonly Label _statusChip;
    private readonly ToolTip _statusTip = new();
    private bool _selected;

    public event EventHandler? RowClicked;

    public WidgetEmailRow(string email, string commitOrSource, Image? mailIcon)
    {
        Email = email;
        SourceLabel = commitOrSource;
        Height = 44;
        Width = 332;
        BackColor = WidgetTheme.Surface;
        Margin = new Padding(0, 0, 0, 6);
        Cursor = Cursors.Hand;
        Padding = new Padding(8, 6, 8, 6);
        SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);

        var iconBox = new PictureBox
        {
            Size = new Size(22, 22),
            Location = new Point(10, 11),
            SizeMode = PictureBoxSizeMode.Zoom,
            BackColor = WidgetTheme.Surface,
        };
        if (mailIcon != null)
        {
            iconBox.Image = mailIcon;
        }

        _emailLabel = new Label
        {
            Text = email,
            ForeColor = WidgetTheme.Match,
            Font = new Font("Segoe UI", 9.25f, FontStyle.Regular),
            AutoSize = false,
            AutoEllipsis = true,
            Location = new Point(40, 5),
            Size = new Size(216, 18),
        };

        _sourceLabel = new Label
        {
            Text = commitOrSource,
            ForeColor = WidgetTheme.TextMuted,
            Font = new Font("Segoe UI", 8.25f),
            AutoSize = false,
            AutoEllipsis = true,
            Location = new Point(40, 23),
            Size = new Size(216, 16),
        };

        // Hidden until the row actually enters the send lifecycle - keeps the
        // freshly-discovered list clean (no "Found" badge clutter).
        _statusChip = new Label
        {
            Text = "",
            ForeColor = WidgetTheme.TextMuted,
            BackColor = WidgetTheme.SurfaceLight,
            Font = new Font("Segoe UI", 7.5f, FontStyle.Bold),
            TextAlign = ContentAlignment.MiddleCenter,
            AutoSize = false,
            Visible = false,
            Size = new Size(64, 20),
            Location = new Point(Width - 8 - 64, 12),
            Anchor = AnchorStyles.Top | AnchorStyles.Right,
        };

        Controls.AddRange([iconBox, _emailLabel, _sourceLabel, _statusChip]);
        Click += (_, _) => RowClicked?.Invoke(this, EventArgs.Empty);
        foreach (Control c in Controls)
        {
            if (c == _statusChip)
            {
                continue;
            }

            c.Click += (_, _) => RowClicked?.Invoke(this, EventArgs.Empty);
        }
    }

    public void SetSelected(bool selected)
    {
        _selected = selected;
        BackColor = selected ? WidgetTheme.SurfaceLight : WidgetTheme.Surface;
        _emailLabel.BackColor = BackColor;
        _sourceLabel.BackColor = BackColor;
        Invalidate();
    }

    public void SetSendState(WidgetSendState state, string? detail = null)
    {
        State = state;
        var (text, fg) = state switch
        {
            WidgetSendState.Queued => ("Queued", WidgetTheme.TextMuted),
            WidgetSendState.Sending => ("Sending…", WidgetTheme.Accent),
            WidgetSendState.Sent => ("Sent ✓", WidgetTheme.Success),
            WidgetSendState.Failed => ("Failed ✕", WidgetTheme.Error),
            _ => ("", WidgetTheme.TextMuted),
        };
        _statusChip.Text = text;
        _statusChip.ForeColor = fg;
        _statusChip.Visible = state != WidgetSendState.Found;
        _statusTip.SetToolTip(
            _statusChip,
            state == WidgetSendState.Failed && !string.IsNullOrEmpty(detail) ? detail : null);
        Invalidate();
    }

    private Color StatusBarColor() => State switch
    {
        WidgetSendState.Sending => WidgetTheme.Accent,
        WidgetSendState.Sent => WidgetTheme.Success,
        WidgetSendState.Failed => WidgetTheme.Error,
        WidgetSendState.Queued => WidgetTheme.TextMuted,
        _ => Color.Empty,
    };

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;

        // Left status bar reflects the send lifecycle at a glance.
        var bar = StatusBarColor();
        if (bar != Color.Empty)
        {
            using var brush = new SolidBrush(bar);
            g.FillRectangle(brush, 0, 4, 3, Height - 8);
        }

        if (_selected)
        {
            using var pen = new Pen(WidgetTheme.Accent, 1.5f);
            g.DrawRectangle(pen, 0, 0, Width - 1, Height - 1);
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _statusTip.Dispose();
        }

        base.Dispose(disposing);
    }
}
