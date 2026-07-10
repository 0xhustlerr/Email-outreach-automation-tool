namespace EmailFinderTray;

internal static class WidgetTheme
{
    // Clean cool-slate palette: a near-black backdrop with cards a clear step
    // lighter and a crisp (not muddy) border, so the chrome reads as glass
    // rather than a flat navy wash.
    public static readonly Color Bg = Color.FromArgb(9, 12, 20);
    public static readonly Color CardFill = Color.FromArgb(21, 27, 40);
    public static readonly Color CardBorder = Color.FromArgb(90, 80, 100, 130);
    public static readonly Color Surface = Color.FromArgb(28, 35, 51);
    public static readonly Color SurfaceLight = Color.FromArgb(40, 51, 72);
    public static readonly Color Text = Color.FromArgb(232, 237, 245);
    public static readonly Color TextMuted = Color.FromArgb(148, 163, 184);
    public static readonly Color Accent = Color.FromArgb(34, 211, 238);
    public static readonly Color AccentDark = Color.FromArgb(14, 165, 196);
    public static readonly Color Success = Color.FromArgb(52, 211, 153);
    public static readonly Color Error = Color.FromArgb(248, 113, 113);
    public static readonly Color Match = Color.FromArgb(125, 235, 250);
    public static readonly Color Skip = Color.FromArgb(120, 134, 156);

    public static void StyleChromelessForm(Form form)
    {
        form.FormBorderStyle = FormBorderStyle.None;
        form.BackColor = Bg;
        form.ForeColor = Text;
        form.ShowInTaskbar = true;
    }

    public static void StyleOnCard(Control control) => control.BackColor = CardFill;

    public static void StyleInput(TextBox box)
    {
        box.BackColor = Surface;
        box.ForeColor = Text;
        box.BorderStyle = BorderStyle.FixedSingle;
    }

    public static void StyleLog(TextBox box)
    {
        box.BackColor = Surface;
        box.ForeColor = TextMuted;
        box.BorderStyle = BorderStyle.None;
        box.Font = new Font("Cascadia Mono", 8.25f, FontStyle.Regular, GraphicsUnit.Point);
        if (!FontExists(box.Font.Name))
        {
            box.Font = new Font("Consolas", 8.25f);
        }

        box.ReadOnly = true;
        box.Multiline = true;
        box.ScrollBars = ScrollBars.Vertical;
        box.WordWrap = false;
    }

    public static void StylePrimaryButton(Button btn)
    {
        btn.FlatStyle = FlatStyle.Flat;
        btn.BackColor = AccentDark;
        btn.ForeColor = Bg;
        btn.FlatAppearance.BorderSize = 0;
        btn.Cursor = Cursors.Hand;
    }

    public static void StyleSecondaryButton(Button btn)
    {
        btn.FlatStyle = FlatStyle.Flat;
        btn.BackColor = SurfaceLight;
        btn.ForeColor = Text;
        btn.FlatAppearance.BorderSize = 0;
        btn.Cursor = Cursors.Hand;
    }

    public static void StyleCombo(ComboBox combo)
    {
        combo.BackColor = Surface;
        combo.ForeColor = Text;
        combo.FlatStyle = FlatStyle.Flat;
    }

    public static Color LogColor(WidgetLogKind kind) => kind switch
    {
        WidgetLogKind.Match => Match,
        WidgetLogKind.Done => Success,
        WidgetLogKind.Error => Error,
        WidgetLogKind.Skip => Skip,
        _ => TextMuted,
    };

    private static bool FontExists(string name)
    {
        using var f = new Font(name, 9f);
        return string.Equals(f.Name, name, StringComparison.OrdinalIgnoreCase);
    }
}
