using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Net.Http;
using Rx = System.Text.RegularExpressions.Regex;

namespace EmailFinderTray;

/// <summary>
/// Toast-style pop-up shown when new replies are detected — the primary alert
/// for a user who only opens the app occasionally. Lists each new reply with an
/// avatar and a cleaned preview, and offers to open the full app. Closing it
/// acknowledges the replies (clears the tray badge).
/// </summary>
internal sealed class ReplyAlertDialog : Form
{
    private const int Width_ = 444;
    private const int Pad = 18;
    private const int ContentWidth = Width_ - Pad * 2;
    private const int CornerRadius = 16;
    private const int ButtonGap = 14;
    private const int ButtonHeight = 40;
    private const int ButtonWidth = (ContentWidth - ButtonGap) / 2;
    private const int MaxCards = 4;

    // Brighter than TextMuted for legible secondary text on the popup.
    private static readonly Color SubtleText = Color.FromArgb(178, 190, 208);
    private static readonly Color BodyText = Color.FromArgb(216, 223, 234);

    private readonly FlowLayoutPanel _list;
    private readonly Label _header;
    private readonly Label _subheader;
    private readonly HttpClient? _http;
    private readonly string? _appUrl;
    private readonly Action _onOpenApp;
    private readonly Action _onAcknowledge;

    public ReplyAlertDialog(
        HttpClient? http,
        string? appUrl,
        Action onOpenApp,
        Action onAcknowledge)
    {
        _http = http;
        _appUrl = string.IsNullOrWhiteSpace(appUrl) ? null : appUrl.TrimEnd('/');
        _onOpenApp = onOpenApp;
        _onAcknowledge = onAcknowledge;

        Text = "New replies";
        Icon = IconLoader.LoadFormIcon();
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = true;
        TopMost = true;
        BackColor = WidgetTheme.Bg;
        ForeColor = WidgetTheme.Text;
        Font = new Font("Segoe UI", 9.25f);
        DoubleBuffered = true;
        Width = Width_;
        Padding = new Padding(1);

        var root = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            BackColor = WidgetTheme.Bg,
            Padding = new Padding(Pad, Pad - 2, Pad, Pad),
            Width = Width_,
        };

        // --- Header: icon tile + title/subtitle + close ---
        var titleBar = new Panel
        {
            Width = ContentWidth,
            Height = 44,
            BackColor = WidgetTheme.Bg,
            Margin = new Padding(0, 0, 0, 12),
        };
        var iconTile = new GlyphTile("")
        {
            Size = new Size(42, 42),
            Location = new Point(0, 1),
        };
        _header = new Label
        {
            Text = "New replies",
            ForeColor = WidgetTheme.Text,
            Font = new Font("Segoe UI Semibold", 13f, FontStyle.Bold),
            AutoSize = true,
            Location = new Point(54, 2),
            BackColor = WidgetTheme.Bg,
        };
        _subheader = new Label
        {
            Text = "Replies to your outreach",
            ForeColor = SubtleText,
            Font = new Font("Segoe UI", 9f),
            AutoSize = true,
            Location = new Point(54, 25),
            BackColor = WidgetTheme.Bg,
        };
        var closeBtn = new CircleButton("✕")
        {
            Size = new Size(30, 30),
            Location = new Point(ContentWidth - 30, 6),
            Anchor = AnchorStyles.Top | AnchorStyles.Right,
        };
        closeBtn.Click += (_, _) => Close();
        titleBar.Controls.AddRange([iconTile, _header, _subheader, closeBtn]);

        // --- Reply list ---
        _list = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            AutoScroll = false,
            BackColor = WidgetTheme.Bg,
            Width = ContentWidth,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Margin = new Padding(0, 0, 0, 12),
        };

        // --- Actions: two equal pills, symmetric margins, clear of corners ---
        var buttons = new Panel
        {
            Width = ContentWidth,
            Height = ButtonHeight,
            BackColor = WidgetTheme.Bg,
            Margin = new Padding(0, 2, 0, 2),
        };
        var openBtn = new PillButton("Open app", primary: true)
        {
            Size = new Size(ButtonWidth, ButtonHeight),
            Location = new Point(0, 0),
        };
        openBtn.Click += (_, _) =>
        {
            _onOpenApp();
            Close();
        };
        var dismissBtn = new PillButton("Dismiss", primary: false)
        {
            Size = new Size(ButtonWidth, ButtonHeight),
            Location = new Point(ContentWidth - ButtonWidth, 0),
            Anchor = AnchorStyles.Top | AnchorStyles.Right,
        };
        dismissBtn.Click += (_, _) => Close();
        buttons.Controls.AddRange([openBtn, dismissBtn]);

        root.Controls.Add(titleBar);
        root.Controls.Add(_list);
        root.Controls.Add(buttons);
        Controls.Add(root);

        WidgetDrag.Enable(this, titleBar, _header, _subheader);
    }

    /// <summary>Replace the shown list with the current unseen replies.</summary>
    public void SetReplies(IReadOnlyList<TrayReplyNotification> replies)
    {
        _header.Text = replies.Count == 1
            ? "1 new reply"
            : $"{replies.Count} new replies";

        _list.Controls.Clear();
        var shown = Math.Min(replies.Count, MaxCards);
        for (var i = 0; i < shown; i++)
        {
            _list.Controls.Add(BuildReplyCard(replies[i]));
        }

        if (replies.Count > shown)
        {
            _list.Controls.Add(BuildMoreRow(replies.Count - shown));
        }

        ReflowAndPosition();
    }

    private Control BuildMoreRow(int extra)
    {
        var link = new Label
        {
            Text = $"+ {extra} more — open app to view",
            ForeColor = WidgetTheme.Accent,
            Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
            AutoSize = true,
            Cursor = Cursors.Hand,
            BackColor = WidgetTheme.Bg,
            Margin = new Padding(6, 2, 0, 2),
        };
        link.Click += (_, _) =>
        {
            _onOpenApp();
            Close();
        };
        return link;
    }

    private Control BuildReplyCard(TrayReplyNotification r)
    {
        var card = new ReplyCard
        {
            Width = ContentWidth,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Margin = new Padding(0, 0, 0, 10),
            Padding = new Padding(16, 14, 16, 14),
        };
        card.Click += (_, _) =>
        {
            _onOpenApp();
            Close();
        };

        var layout = new TableLayoutPanel
        {
            ColumnCount = 2,
            RowCount = 1,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            BackColor = WidgetTheme.CardFill,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 56));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));

        var who = string.IsNullOrWhiteSpace(r.Name) ? r.Contact : r.Name;
        var avatar = new AvatarCircle(who, r.Contact, 44, _http, AvatarUrl(r.Contact))
        {
            Margin = new Padding(0, 2, 12, 0),
        };

        var textWidth = ContentWidth - 32 - 56;
        var textCol = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            BackColor = WidgetTheme.CardFill,
            Width = textWidth,
            Margin = Padding.Empty,
        };

        var nameLabel = new Label
        {
            Text = who,
            ForeColor = WidgetTheme.Text,
            Font = new Font("Segoe UI Semibold", 11f, FontStyle.Bold),
            AutoSize = true,
            Margin = new Padding(0, 0, 0, 1),
            BackColor = WidgetTheme.CardFill,
        };
        var contactLabel = new Label
        {
            Text = r.Contact,
            ForeColor = WidgetTheme.Accent,
            Font = new Font("Segoe UI", 9f),
            AutoSize = true,
            Margin = new Padding(0, 0, 0, 6),
            BackColor = WidgetTheme.CardFill,
        };
        textCol.Controls.Add(nameLabel);
        textCol.Controls.Add(contactLabel);

        var preview = CleanSnippet(r.Snippet);
        if (string.IsNullOrWhiteSpace(preview))
        {
            preview = CleanSnippet(r.Subject);
        }
        if (!string.IsNullOrWhiteSpace(preview))
        {
            if (preview.Length > 240)
            {
                preview = preview[..237] + "…";
            }

            textCol.Controls.Add(new Label
            {
                Text = preview,
                ForeColor = BodyText,
                Font = new Font("Segoe UI", 9.75f),
                AutoSize = true,
                MaximumSize = new Size(textWidth, 0),
                BackColor = WidgetTheme.CardFill,
                Margin = new Padding(0, 1, 0, 0),
            });
        }

        layout.Controls.Add(avatar, 0, 0);
        layout.Controls.Add(textCol, 1, 0);

        // Let clicks on the inner controls also open the app.
        foreach (Control child in new Control[] { layout, textCol, nameLabel, contactLabel })
        {
            child.Click += (_, _) =>
            {
                _onOpenApp();
                Close();
            };
        }

        card.Controls.Add(layout);
        return card;
    }

    private string? AvatarUrl(string email)
    {
        var e = (email ?? "").Trim();
        if (_appUrl == null || !e.Contains('@'))
        {
            return null;
        }

        return $"{_appUrl}/api/avatar?email={Uri.EscapeDataString(e)}";
    }

    // Keep only the replier's new text — strip the quoted history so the popup
    // shows the reply, not the message it's replying to. Handles English
    // ("On … wrote:") and localized attributions (e.g. Ukrainian "… пише:"),
    // the "<email>" quote header, and Outlook dividers, plus HTML entities.
    private static string CleanSnippet(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return "";
        }

        var s = raw.Replace("\r", " ").Replace("\n", " ");

        // Decode numeric entities (&#39; &#x27;) then named ones.
        s = Rx.Replace(s, @"&#(\d{1,6});", mm => SafeChar(int.Parse(mm.Groups[1].Value)));
        s = Rx.Replace(s, @"&#x([0-9a-fA-F]{1,5});",
            mm => SafeChar(Convert.ToInt32(mm.Groups[1].Value, 16)));
        s = s
            .Replace("&lt;", "<")
            .Replace("&gt;", ">")
            .Replace("&quot;", "\"")
            .Replace("&#39;", "'")
            .Replace("&nbsp;", " ")
            .Replace("&amp;", "&");

        var cut = s.Length;

        // "<email>" quote header — the attribution usually reads
        // "<date> <time> Name <email> wrote/пише:". Cut at the start of that
        // attribution: back up to a nearby "On"/time/year anchor before it.
        var email = Rx.Match(s, @"<[^<>]{1,80}@[^<>]{1,80}>");
        if (email.Success)
        {
            var a = email.Index;
            var winStart = Math.Max(0, a - 220);
            var head = s.Substring(winStart, a - winStart);
            // Cut at the earliest attribution anchor before the address (an
            // "On", a time, or a year) so the whole "date time name" preamble
            // goes, not just part of it. Fall back to the address itself.
            var attrStart = a;
            foreach (var pat in new[]
            {
                @"\p{L}{2,4},\s*\d{1,2}\b", // "Mon, 6" / "пн, 6" weekday preamble
                @"\bOn\b",
                @"\b\d{1,2}[:.]\d{2}\b",
                @"\b(19|20)\d{2}\b",
            })
            {
                var mm = Rx.Match(head, pat);
                if (mm.Success)
                {
                    attrStart = Math.Min(attrStart, winStart + mm.Index);
                }
            }
            cut = Math.Min(cut, attrStart);
        }

        // Attribution verbs across locales, ending in a colon.
        var wrote = Rx.Match(
            s,
            @"\b(wrote|schrieb|escribió|escreveu|napisał|geschreven|ha scritto|"
                + @"написав|написала|написал|пише|пишет)\b\s*:",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        if (wrote.Success)
        {
            cut = Math.Min(cut, wrote.Index);
        }

        foreach (var marker in new[] { "-----Original Message-----", "________________________________" })
        {
            var idx = s.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
            if (idx >= 0)
            {
                cut = Math.Min(cut, idx);
            }
        }

        if (cut < s.Length)
        {
            s = s[..cut];
        }

        s = Rx.Replace(s, @"\s{2,}", " ").Trim().TrimEnd(',', ';', ':', '-', '–', '—');
        return s.Trim();
    }

    private static string SafeChar(int code) =>
        code is > 0 and <= 0x10FFFF ? char.ConvertFromUtf32(code) : "";

    private void ReflowAndPosition()
    {
        PerformLayout();
        Region = new Region(WidgetCard.RoundedRect(
            new Rectangle(0, 0, Width, Height), CornerRadius));

        var screen = Screen.FromPoint(Cursor.Position).WorkingArea;
        Location = new Point(
            screen.Right - Width - 18,
            screen.Bottom - Height - 18);
    }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        // Painted in OnPaint so the rounded corners stay crisp.
        using var fill = new SolidBrush(WidgetTheme.Bg);
        e.Graphics.FillRectangle(fill, ClientRectangle);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var rect = new Rectangle(0, 0, Width - 1, Height - 1);
        using var path = WidgetCard.RoundedRect(rect, CornerRadius);
        using var border = new Pen(WidgetTheme.CardBorder, 1f);
        g.DrawPath(border, path);
        // Accent line under the header for a bit of polish.
        using var accent = new Pen(Color.FromArgb(70, WidgetTheme.Accent), 1f);
        g.DrawLine(accent, Pad, 62, Width - Pad, 62);
    }

    // Native drop shadow around the borderless window.
    protected override CreateParams CreateParams
    {
        get
        {
            const int CS_DROPSHADOW = 0x00020000;
            var cp = base.CreateParams;
            cp.ClassStyle |= CS_DROPSHADOW;
            return cp;
        }
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        _onAcknowledge();
        base.OnFormClosed(e);
    }

    // --- Reusable painted controls -------------------------------------

    /// <summary>Rounded card with a left accent bar (unread indicator).</summary>
    private sealed class ReplyCard : Panel
    {
        private bool _hover;

        public ReplyCard()
        {
            SetStyle(
                ControlStyles.AllPaintingInWmPaint |
                ControlStyles.UserPaint |
                ControlStyles.OptimizedDoubleBuffer |
                ControlStyles.ResizeRedraw,
                true);
            BackColor = WidgetTheme.CardFill;
            Cursor = Cursors.Hand;
        }

        protected override void OnMouseEnter(EventArgs e)
        {
            _hover = true;
            Invalidate();
            base.OnMouseEnter(e);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            if (!ClientRectangle.Contains(PointToClient(Cursor.Position)))
            {
                _hover = false;
                Invalidate();
            }

            base.OnMouseLeave(e);
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            // fill in OnPaint
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            var rect = new Rectangle(0, 0, Width - 1, Height - 1);
            using var path = WidgetCard.RoundedRect(rect, 12);
            using var fill = new SolidBrush(_hover ? WidgetTheme.Surface : WidgetTheme.CardFill);
            g.FillPath(fill, path);
            using var pen = new Pen(_hover ? WidgetTheme.Accent : WidgetTheme.CardBorder, 1f);
            g.DrawPath(pen, path);

            // Left accent bar.
            using var bar = new SolidBrush(WidgetTheme.Accent);
            g.FillRectangle(bar, 0, 10, 3, Height - 20);
        }
    }

    /// <summary>Rounded solid/ghost action button.</summary>
    private sealed class PillButton : Button
    {
        private readonly bool _primary;
        private bool _hover;

        public PillButton(string text, bool primary)
        {
            _primary = primary;
            Text = text;
            SetStyle(
                ControlStyles.UserPaint |
                ControlStyles.AllPaintingInWmPaint |
                ControlStyles.OptimizedDoubleBuffer,
                true);
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            Font = new Font("Segoe UI Semibold", 9.75f, FontStyle.Bold);
            Cursor = Cursors.Hand;
            BackColor = WidgetTheme.Bg;
        }

        protected override void OnMouseEnter(EventArgs e)
        {
            _hover = true;
            Invalidate();
            base.OnMouseEnter(e);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            _hover = false;
            Invalidate();
            base.OnMouseLeave(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
            var rect = new Rectangle(0, 0, Width - 1, Height - 1);
            using var path = WidgetCard.RoundedRect(rect, Height / 2);

            Color fillColor;
            Color textColor;
            if (_primary)
            {
                fillColor = _hover ? WidgetTheme.Accent : WidgetTheme.AccentDark;
                textColor = WidgetTheme.Bg;
            }
            else
            {
                fillColor = _hover ? WidgetTheme.SurfaceLight : WidgetTheme.Surface;
                textColor = WidgetTheme.Text;
            }

            using (var fill = new SolidBrush(fillColor))
            {
                g.FillPath(fill, path);
            }

            if (!_primary)
            {
                using var pen = new Pen(WidgetTheme.CardBorder, 1f);
                g.DrawPath(pen, path);
            }

            TextRenderer.DrawText(
                g, Text, Font, rect, textColor,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
        }
    }

    /// <summary>Rounded accent-tinted tile with a centered Segoe glyph.</summary>
    private sealed class GlyphTile : Panel
    {
        private readonly string _glyph;

        public GlyphTile(string glyph)
        {
            _glyph = glyph;
            SetStyle(
                ControlStyles.AllPaintingInWmPaint |
                ControlStyles.UserPaint |
                ControlStyles.OptimizedDoubleBuffer |
                ControlStyles.ResizeRedraw,
                true);
            BackColor = WidgetTheme.Bg;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
            var rect = new Rectangle(0, 0, Width - 1, Height - 1);
            using var path = WidgetCard.RoundedRect(rect, 11);
            using var fill = new SolidBrush(Color.FromArgb(38, WidgetTheme.Accent));
            g.FillPath(fill, path);
            using var pen = new Pen(Color.FromArgb(90, WidgetTheme.Accent), 1f);
            g.DrawPath(pen, path);

            using var glyphFont = new Font("Segoe MDL2 Assets", 15f);
            TextRenderer.DrawText(
                g, _glyph, glyphFont, rect, WidgetTheme.Accent,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
        }
    }

    /// <summary>Small round hover button (window close).</summary>
    private sealed class CircleButton : Button
    {
        private readonly string _glyph;
        private bool _hover;

        public CircleButton(string glyph)
        {
            _glyph = glyph;
            SetStyle(
                ControlStyles.UserPaint |
                ControlStyles.AllPaintingInWmPaint |
                ControlStyles.OptimizedDoubleBuffer,
                true);
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            TabStop = false;
            Cursor = Cursors.Hand;
            BackColor = WidgetTheme.Bg;
        }

        protected override void OnMouseEnter(EventArgs e)
        {
            _hover = true;
            Invalidate();
            base.OnMouseEnter(e);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            _hover = false;
            Invalidate();
            base.OnMouseLeave(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
            if (_hover)
            {
                using var fill = new SolidBrush(WidgetTheme.Surface);
                g.FillEllipse(fill, 0, 0, Width - 1, Height - 1);
            }

            using var font = new Font("Segoe UI", 10f);
            TextRenderer.DrawText(
                g, _glyph, font, new Rectangle(0, 0, Width, Height),
                _hover ? WidgetTheme.Text : WidgetTheme.TextMuted,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
        }
    }

    /// <summary>Circular avatar — real photo via the proxy, initials fallback.</summary>
    private sealed class AvatarCircle : Panel
    {
        private static readonly (Color, Color)[] Palette =
        {
            (Color.FromArgb(34, 211, 238), Color.FromArgb(14, 116, 144)),
            (Color.FromArgb(167, 139, 250), Color.FromArgb(109, 40, 217)),
            (Color.FromArgb(52, 211, 153), Color.FromArgb(4, 120, 87)),
            (Color.FromArgb(251, 191, 36), Color.FromArgb(180, 83, 9)),
            (Color.FromArgb(251, 113, 133), Color.FromArgb(159, 18, 57)),
            (Color.FromArgb(56, 189, 248), Color.FromArgb(3, 105, 161)),
            (Color.FromArgb(45, 212, 191), Color.FromArgb(15, 118, 110)),
            (Color.FromArgb(244, 114, 182), Color.FromArgb(157, 23, 77)),
        };

        private readonly string _initials;
        private readonly Color _c1;
        private readonly Color _c2;
        private Image? _image;

        public AvatarCircle(string name, string email, int size, HttpClient? http, string? avatarUrl)
        {
            SetStyle(
                ControlStyles.AllPaintingInWmPaint |
                ControlStyles.UserPaint |
                ControlStyles.OptimizedDoubleBuffer |
                ControlStyles.ResizeRedraw,
                true);
            Size = new Size(size, size);
            BackColor = WidgetTheme.CardFill;
            Cursor = Cursors.Hand;
            _initials = InitialsOf(name, email);
            var seed = (string.IsNullOrWhiteSpace(email) ? name : email) ?? "";
            (_c1, _c2) = Palette[Math.Abs(StableHash(seed)) % Palette.Length];

            if (http != null && !string.IsNullOrEmpty(avatarUrl))
            {
                _ = LoadAsync(http, avatarUrl);
            }
        }

        private async Task LoadAsync(HttpClient http, string url)
        {
            try
            {
                using var res = await http.GetAsync(url);
                if (!res.IsSuccessStatusCode)
                {
                    return;
                }

                var bytes = await res.Content.ReadAsByteArrayAsync();
                using var ms = new MemoryStream(bytes);
                var img = Image.FromStream(ms);
                if (IsDisposed)
                {
                    img.Dispose();
                    return;
                }

                try
                {
                    BeginInvoke(() =>
                    {
                        _image?.Dispose();
                        _image = img;
                        Invalidate();
                    });
                }
                catch
                {
                    img.Dispose();
                }
            }
            catch
            {
                // keep initials
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            var rect = new Rectangle(0, 0, Width - 1, Height - 1);

            if (_image != null)
            {
                using var clip = new GraphicsPath();
                clip.AddEllipse(rect);
                var old = g.Clip;
                g.SetClip(clip);
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.DrawImage(_image, 0, 0, Width, Height);
                g.Clip = old;
                using var ring = new Pen(Color.FromArgb(40, 255, 255, 255), 1f);
                g.DrawEllipse(ring, rect);
                return;
            }

            using var brush = new LinearGradientBrush(rect, _c1, _c2, 55f);
            g.FillEllipse(brush, rect);
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
            using var font = new Font("Segoe UI Semibold", Height * 0.34f, FontStyle.Bold, GraphicsUnit.Pixel);
            TextRenderer.DrawText(
                g, _initials, font, new Rectangle(0, 0, Width, Height), Color.White,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _image?.Dispose();
            }

            base.Dispose(disposing);
        }

        private static string InitialsOf(string name, string email)
        {
            var n = (name ?? "").Trim();
            if (n.Length > 0)
            {
                var parts = n.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length >= 2)
                {
                    return (char.ToUpperInvariant(parts[0][0]).ToString()
                            + char.ToUpperInvariant(parts[1][0]));
                }

                return char.ToUpperInvariant(n[0]).ToString();
            }

            var e = (email ?? "").Trim();
            return e.Length > 0 ? char.ToUpperInvariant(e[0]).ToString() : "?";
        }

        private static int StableHash(string s)
        {
            unchecked
            {
                var h = 17;
                foreach (var ch in s)
                {
                    h = h * 31 + ch;
                }

                return h;
            }
        }
    }
}
