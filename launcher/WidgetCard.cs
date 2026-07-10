using System.Drawing.Drawing2D;

namespace EmailFinderTray;

/// <summary>Rounded glass panel - gaps between cards show the desktop through the form chrome key.</summary>
internal sealed class WidgetCard : Panel
{
    public int CornerRadius { get; init; } = 14;

    public WidgetCard()
    {
        SetStyle(
            ControlStyles.AllPaintingInWmPaint |
            ControlStyles.UserPaint |
            ControlStyles.OptimizedDoubleBuffer |
            ControlStyles.ResizeRedraw,
            true);
        BackColor = WidgetTheme.CardFill;
        Padding = new Padding(12, 10, 12, 10);
        Margin = new Padding(0, 0, 0, 10);
    }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        // Card fill is drawn in OnPaint so the form chrome stays transparent between cards.
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var rect = new Rectangle(0, 0, Width - 1, Height - 1);
        using var path = RoundedRect(rect, CornerRadius);
        using var fill = new SolidBrush(WidgetTheme.CardFill);
        g.FillPath(fill, path);
        using var border = new Pen(WidgetTheme.CardBorder, 1f);
        g.DrawPath(border, path);
    }

    internal static GraphicsPath RoundedRect(Rectangle bounds, int radius)
    {
        var path = new GraphicsPath();
        var d = radius * 2;
        if (d > bounds.Height)
        {
            d = bounds.Height;
        }

        if (d > bounds.Width)
        {
            d = bounds.Width;
        }

        path.AddArc(bounds.X, bounds.Y, d, d, 180, 90);
        path.AddArc(bounds.Right - d, bounds.Y, d, d, 270, 90);
        path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
        path.AddArc(bounds.X, bounds.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }
}
