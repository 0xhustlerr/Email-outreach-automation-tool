using System.Diagnostics;

namespace EmailFinderTray;

internal sealed class WidgetWindow : Form
{
    private const int DebounceMs = 400;
    private const int CardWidth = 360;
    private const int EmailRowHeight = 48;
    private const int MaxVisibleEmails = 5;

    private readonly WidgetSearchService _search;
    private readonly System.Windows.Forms.Timer _debounceTimer;
    private CancellationTokenSource? _searchCts;
    private Image? _mailIconImage;

    private readonly FlowLayoutPanel _rootFlow;
    private readonly WidgetCard _profileCard;
    private TextBox _urlBox = null!;
    private readonly WidgetCard _activityCard;
    private Label _activityLine1 = null!;
    private Label _activityLine2 = null!;
    private Button _stopSearchBtn = null!;
    private readonly WidgetCard _resultsCard;
    private readonly FlowLayoutPanel _emailFlow;
    private readonly Panel _emailScroll;
    private readonly TextBox _nameBox;
    private readonly TextBox _linkBox;
    private readonly ComboBox _senderCombo;
    private readonly Button _sendBtn;
    private readonly WidgetCard _noResultsCard;
    private Button _noResultsNewSearchBtn = null!;

    private readonly List<WidgetEmailRow> _emailRows = [];
    private readonly Dictionary<string, WidgetEmailRow> _rowByEmail =
        new(StringComparer.OrdinalIgnoreCase);
    private WidgetSearchResult? _result;
    private List<MailIdentityDto> _senders = [];
    private bool _smtpConfigured;
    private int _selectedEmailIndex = -1;
    private string? _selectedEmail;
    private WidgetLogKind _activityLine1Kind = WidgetLogKind.Info;
    private string _sessionLogin = "";
    private string _sessionCountry = "";
    private string _sessionProfileUrl = "";
    private bool _searchRunning;
    private bool _stopRequested;

    // --- Compose / send ----------------------------------------------------
    private ComboBox _templateCombo = null!;
    private Label _sendStatusLabel = null!;
    private WidgetEmailTemplate _selectedTemplate =
        WidgetMailTemplates.GetById(WidgetSettings.Get(WidgetSettings.TemplateIdKey));

    public WidgetWindow(string appBaseUrl, HttpClient http)
    {
        _search = new WidgetSearchService(http, appBaseUrl);
        _debounceTimer = new System.Windows.Forms.Timer { Interval = DebounceMs };
        _debounceTimer.Tick += async (_, _) => await OnDebouncedSearchAsync();
        _mailIconImage = LoadMailIconBitmap();

        Text = "Cold Outreach Command Center";
        Icon = IconLoader.LoadFormIcon();
        TopMost = true;
        StartPosition = FormStartPosition.CenterScreen;
        MaximizeBox = false;
        MinimumSize = new Size(CardWidth + 24, 80);
        Font = new Font("Segoe UI", 9.25f);
        WidgetTheme.StyleChromelessForm(this);
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;

        _rootFlow = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            BackColor = WidgetTheme.Bg,
            Padding = new Padding(10, 10, 10, 6),
            Width = CardWidth + 20,
        };

        _profileCard = BuildProfileCard();
        _activityCard = BuildActivityCard();
        _resultsCard = BuildResultsCard(out _emailFlow, out _emailScroll, out _nameBox, out _linkBox, out _senderCombo, out _sendBtn);
        _noResultsCard = BuildNoResultsCard();

        _rootFlow.Controls.Add(_profileCard);
        _rootFlow.Controls.Add(_activityCard);
        _rootFlow.Controls.Add(_resultsCard);
        _rootFlow.Controls.Add(_noResultsCard);
        Controls.Add(_rootFlow);

        WidgetDrag.Enable(this, _profileCard, _activityCard, _resultsCard, _noResultsCard);

        Shown += async (_, _) =>
        {
            await LoadSendersAsync();
            await LoadTemplatesAsync();
            _urlBox.Focus();
        };

        ClientSize = new Size(CardWidth + 20, 100);
    }

    private WidgetCard BuildProfileCard()
    {
        var card = new WidgetCard { Width = CardWidth, AutoSize = true };
        var title = new Label
        {
            Text = "Profile URL",
            ForeColor = WidgetTheme.TextMuted,
            AutoSize = true,
            Location = new Point(0, 0),
        };
        WidgetTheme.StyleOnCard(title);
        _urlBox = new TextBox
        {
            PlaceholderText = "github.com/user or stackoverflow.com/users/…",
            Location = new Point(0, 22),
            Width = CardWidth - 24,
            Height = 28,
            Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
        };
        WidgetTheme.StyleInput(_urlBox);
        _urlBox.TextChanged += (_, _) => OnUrlChanged();

        var clearUrlBtn = new Button
        {
            Text = "Clear",
            Size = new Size(52, 24),
            Location = new Point(CardWidth - 96, 22),
            Anchor = AnchorStyles.Top | AnchorStyles.Right,
            TabStop = false,
        };
        WidgetTheme.StyleSecondaryButton(clearUrlBtn);
        clearUrlBtn.Click += (_, _) => ResetToInput();

        var closeBtn = new Button
        {
            Text = "×",
            Size = new Size(28, 24),
            Anchor = AnchorStyles.Top | AnchorStyles.Right,
            Location = new Point(CardWidth - 40, 0),
            TabStop = false,
        };
        WidgetTheme.StyleSecondaryButton(closeBtn);
        closeBtn.Font = new Font("Segoe UI", 11f, FontStyle.Regular);
        closeBtn.Click += (_, _) => Hide();

        card.Controls.AddRange([title, _urlBox, clearUrlBtn, closeBtn]);
        card.Height = 72;
        return card;
    }

    private WidgetCard BuildActivityCard()
    {
        var card = new WidgetCard { Width = CardWidth, Height = 56, Visible = false };
        _activityLine1 = CreateActivityLabel(0);
        _activityLine2 = CreateActivityLabel(20);
        _stopSearchBtn = new Button
        {
            Text = "Stop search",
            Size = new Size(108, 28),
            Location = new Point(0, 40),
            Visible = false,
        };
        WidgetTheme.StyleSecondaryButton(_stopSearchBtn);
        _stopSearchBtn.Click += (_, _) => StopSearch();
        card.Controls.AddRange([_activityLine1, _activityLine2, _stopSearchBtn]);
        return card;
    }

    private WidgetCard BuildResultsCard(
        out FlowLayoutPanel flowOut,
        out Panel scrollOut,
        out TextBox nameOut,
        out TextBox linkOut,
        out ComboBox senderOut,
        out Button sendOut)
    {
        var card = new WidgetCard { Width = CardWidth, AutoSize = true, Visible = false };

        var inner = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            BackColor = WidgetTheme.CardFill,
            Width = CardWidth - 24,
        };

        var emailsHeader = new Label
        {
            Text = "Emails found",
            ForeColor = WidgetTheme.Accent,
            Font = new Font(Font, FontStyle.Bold),
            AutoSize = true,
            Margin = new Padding(0, 0, 0, 6),
        };
        WidgetTheme.StyleOnCard(emailsHeader);

        var scroll = new Panel
        {
            Width = CardWidth - 24,
            BackColor = WidgetTheme.CardFill,
            AutoScroll = true,
            Margin = new Padding(0, 0, 0, 4),
        };
        var flow = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            BackColor = WidgetTheme.CardFill,
            Width = CardWidth - 28,
        };
        scroll.Controls.Add(flow);

        var name = MakeInput();
        var link = MakeInput();
        var sender = MakeSenderCombo();

        // Template picker - mirrors the web SendModal's template dropdown.
        _templateCombo = new ComboBox
        {
            DropDownStyle = ComboBoxStyle.DropDownList,
            Height = 28,
        };
        WidgetTheme.StyleCombo(_templateCombo);
        foreach (var t in WidgetMailTemplates.All)
        {
            _templateCombo.Items.Add(t.Label);
        }

        var selectedIndex = Math.Max(
            0,
            WidgetMailTemplates.All.ToList().FindIndex(t => t.Id == _selectedTemplate.Id));
        _templateCombo.SelectedIndex = selectedIndex;
        _templateCombo.SelectedIndexChanged += (_, _) => OnTemplateChanged();
        // Re-pull the list when the dropdown closes so edits made in the web
        // UI's Manage Templates show up without restarting the widget.
        _templateCombo.DropDownClosed += async (_, _) => await LoadTemplatesAsync();

        var send = new Button
        {
            Text = "Send email",
            Height = 36,
            Width = CardWidth - 24,
            Margin = new Padding(0, 4, 0, 0),
        };
        WidgetTheme.StylePrimaryButton(send);
        send.Click += async (_, _) => await RunSendAsync();

        // Inline send result (success/failure) shown under the button.
        _sendStatusLabel = new Label
        {
            Text = "",
            ForeColor = WidgetTheme.Success,
            BackColor = WidgetTheme.CardFill,
            Font = new Font("Segoe UI", 8.5f, FontStyle.Bold),
            AutoSize = false,
            TextAlign = ContentAlignment.MiddleLeft,
            Size = new Size(CardWidth - 24, 0),
            Margin = new Padding(0, 6, 0, 0),
            Visible = false,
        };

        inner.Controls.Add(emailsHeader);
        inner.Controls.Add(scroll);
        inner.Controls.Add(MakeField("Template", _templateCombo));
        inner.Controls.Add(MakeField("Name", name));
        inner.Controls.Add(MakeField("Link (Upwork, etc.)", link));
        inner.Controls.Add(MakeField("Sender", sender));
        inner.Controls.Add(send);
        inner.Controls.Add(_sendStatusLabel);

        card.Controls.Add(inner);
        flowOut = flow;
        scrollOut = scroll;
        nameOut = name;
        linkOut = link;
        senderOut = sender;
        sendOut = send;
        return card;
    }

    private WidgetCard BuildNoResultsCard()
    {
        var card = new WidgetCard { Width = CardWidth, Height = 88, Visible = false };
        var label = new Label
        {
            Text = "No emails found for this profile.",
            ForeColor = WidgetTheme.TextMuted,
            AutoSize = true,
            Location = new Point(0, 4),
        };
        WidgetTheme.StyleOnCard(label);
        _noResultsNewSearchBtn = new Button { Text = "New search", Location = new Point(0, 36), Size = new Size(120, 28) };
        WidgetTheme.StyleSecondaryButton(_noResultsNewSearchBtn);
        _noResultsNewSearchBtn.Click += (_, _) => ResetToInput();
        card.Controls.AddRange([label, _noResultsNewSearchBtn]);
        return card;
    }

    private static Label CreateActivityLabel(int top)
    {
        var label = new Label
        {
            AutoSize = false,
            Location = new Point(0, top),
            Size = new Size(CardWidth - 24, 18),
            Text = "",
            Font = new Font("Segoe UI", 8.5f),
        };
        WidgetTheme.StyleOnCard(label);
        return label;
    }

    private static Panel MakeField(string labelText, Control input)
    {
        var wrap = new Panel
        {
            AutoSize = true,
            Width = CardWidth - 24,
            Margin = new Padding(0, 0, 0, 8),
            BackColor = WidgetTheme.CardFill,
        };
        var lbl = new Label
        {
            Text = labelText,
            ForeColor = WidgetTheme.TextMuted,
            AutoSize = true,
            Location = new Point(0, 0),
        };
        WidgetTheme.StyleOnCard(lbl);
        input.Location = new Point(0, 20);
        input.Width = CardWidth - 24;
        input.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        input.Height = 28;
        wrap.Controls.Add(lbl);
        wrap.Controls.Add(input);
        wrap.Height = 52;
        return wrap;
    }

    private static TextBox MakeInput()
    {
        var box = new TextBox();
        WidgetTheme.StyleInput(box);
        return box;
    }

    private static ComboBox MakeSenderCombo()
    {
        var combo = new ComboBox
        {
            DropDownStyle = ComboBoxStyle.DropDownList,
            Height = 28,
        };
        WidgetTheme.StyleCombo(combo);
        return combo;
    }

    private static Image? LoadMailIconBitmap()
    {
        try
        {
            using var icon = IconLoader.LoadTrayIcon();
            return icon.ToBitmap();
        }
        catch
        {
            return null;
        }
    }

    private void OnUrlChanged()
    {
        _debounceTimer.Stop();
        _searchCts?.Cancel();

        if (string.IsNullOrWhiteSpace(_urlBox.Text))
        {
            ClearSearchSession(keepUrl: false);
            Reflow();
            return;
        }

        if (!ProfileUrlHelper.IsSearchableUrl(_urlBox.Text))
        {
            SetActivity("Paste a GitHub or Stack Overflow profile URL.", "", WidgetLogKind.Info);
            Reflow();
            return;
        }

        _debounceTimer.Start();
    }

    private async Task OnDebouncedSearchAsync()
    {
        _debounceTimer.Stop();
        if (!ProfileUrlHelper.IsSearchableUrl(_urlBox.Text))
        {
            return;
        }

        await RunSearchAsync();
    }

    private async Task RunSearchAsync()
    {
        _searchCts?.Cancel();
        _searchCts = new CancellationTokenSource();
        var ct = _searchCts.Token;

        ResetResultsUi();
        _sessionLogin = ProfileUrlHelper.ParseGitHubUsername(_urlBox.Text) ?? "";
        _sessionProfileUrl = string.IsNullOrEmpty(_sessionLogin)
            ? ""
            : ProfileUrlHelper.ProfileUrl(_sessionLogin);

        SetActivity("Starting search…", "", WidgetLogKind.Info);
        _searchRunning = true;
        _stopRequested = false;
        UpdateSearchChrome();
        ShowResultsCardDuringSearch();

        var logProgress = new Progress<WidgetLogLine>(line => RunOnUi(() => SetActivityFromLog(line)));
        var emailProgress = new Progress<WidgetEmailFound>(found =>
            RunOnUi(() => OnEmailFound(found.Contact)));
        var metaProgress = new Progress<WidgetSearchMeta>(meta =>
            RunOnUi(() => OnSearchMeta(meta)));

        try
        {
            _result = await _search.SearchAsync(_urlBox.Text, logProgress, emailProgress, metaProgress, ct);
            if (_result.EmailContacts.Count == 0)
            {
                SetActivity("Search complete.", "No emails found.", WidgetLogKind.Info);
                ShowNoResultsState();
                return;
            }

            SetActivity(
                $"Found {_result.EmailContacts.Count} email(s), {_result.Contacts.Count} contact(s) total.",
                "Select an email, fill name & link, then send.",
                WidgetLogKind.Match);
            FinishSearchResults(_result);
        }
        catch (OperationCanceledException)
        {
            if (_stopRequested)
            {
                SetActivity(
                    "Search stopped.",
                    _emailRows.Count > 0
                        ? "Fill name & link, then send."
                        : "No emails found yet.",
                    WidgetLogKind.Info);
            }
        }
        catch (Exception ex)
        {
            SetActivity("Search failed.", ex.Message, WidgetLogKind.Error);
            LauncherLog.Write($"Widget search: {ex}");
        }
        finally
        {
            _searchRunning = false;
            _stopRequested = false;
            UpdateSearchChrome();
            _sendBtn.Enabled = CanSend();
            Reflow();
        }
    }

    private void StopSearch()
    {
        if (!_searchRunning)
        {
            return;
        }

        _stopRequested = true;
        _searchCts?.Cancel();
        _searchRunning = false;
        UpdateSearchChrome();
        SetActivity("Stopping search…", "", WidgetLogKind.Info);
        _nameBox.Enabled = true;
        _linkBox.Enabled = true;
        _sendBtn.Enabled = CanSend();
        Reflow();
    }

    private void UpdateSearchChrome()
    {
        _stopSearchBtn.Visible = _searchRunning;
        _activityCard.Height = _searchRunning ? 76 : 56;
        _activityCard.Visible = _searchRunning ||
                                !string.IsNullOrEmpty(_activityLine1.Text) ||
                                !string.IsNullOrEmpty(_activityLine2.Text);
    }

    private void RunOnUi(Action action)
    {
        if (InvokeRequired)
        {
            BeginInvoke(action);
        }
        else
        {
            action();
        }
    }

    private void ShowResultsCardDuringSearch()
    {
        _resultsCard.Visible = true;
        _noResultsCard.Visible = false;
        _emailScroll.Visible = true;
        if (_emailRows.Count == 0)
        {
            _emailScroll.Height = 0;
        }

        _nameBox.Enabled = true;
        _linkBox.Enabled = true;
        _senderCombo.Enabled = true;
        _sendBtn.Visible = true;
        _sendBtn.Enabled = CanSend();
        Reflow();
    }

    private void OnSearchMeta(WidgetSearchMeta meta)
    {
        _sessionLogin = meta.Login;
        _sessionProfileUrl = meta.ProfileUrl;
        _sessionCountry = meta.Country;
        if (!string.IsNullOrWhiteSpace(meta.DisplayName) &&
            string.IsNullOrWhiteSpace(_nameBox.Text) &&
            !_nameBox.Focused)
        {
            _nameBox.Text = meta.DisplayName;
        }

        ShowResultsCardDuringSearch();
        _sendBtn.Enabled = CanSend();
    }

    private void OnEmailFound(WidgetContact contact)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => OnEmailFound(contact));
            return;
        }

        if (_emailRows.Any(r =>
                string.Equals(r.Email, contact.Value, StringComparison.OrdinalIgnoreCase)))
        {
            return;
        }

        _result ??= new WidgetSearchResult
        {
            Contacts = [],
            EmailContacts = [],
        };

        if (!_result.EmailContacts.Any(c =>
                string.Equals(c.Value, contact.Value, StringComparison.OrdinalIgnoreCase)))
        {
            _result.Contacts.Add(contact);
            _result.EmailContacts.Add(contact);
        }

        var sourceLine = WidgetContactMerger.FormatEmailSourceLine(contact);
        var email = contact.Value;
        var row = new WidgetEmailRow(email, sourceLine, _mailIconImage);
        row.RowClicked += (_, _) => SelectEmailByAddress(email);
        _emailRows.Add(row);
        _rowByEmail[email] = row;
        var index = _emailRows.Count - 1;
        _emailFlow.Controls.Add(row);

        if (index == 0)
        {
            SelectEmail(0);
        }

        _noResultsCard.Visible = false;
        EnsureResultsCardVisible();
        UpdateEmailScrollHeight();
        _sendBtn.Enabled = CanSend();
        Reflow();
    }

    private void FinishSearchResults(WidgetSearchResult result)
    {
        _sessionLogin = result.Login;
        _sessionProfileUrl = result.ProfileUrl;
        _sessionCountry = result.Country;

        if (!string.IsNullOrWhiteSpace(result.DisplayName) && string.IsNullOrWhiteSpace(_nameBox.Text))
        {
            _nameBox.Text = result.DisplayName;
        }

        if (_emailRows.Count == 0 && result.EmailContacts.Count > 0)
        {
            foreach (var c in result.EmailContacts)
            {
                OnEmailFound(c);
            }
        }

        _result = result;

        if (!string.IsNullOrEmpty(_selectedEmail))
        {
            var idx = result.EmailContacts.FindIndex(c =>
                string.Equals(c.Value, _selectedEmail, StringComparison.OrdinalIgnoreCase));
            if (idx >= 0)
            {
                _selectedEmailIndex = idx;
            }
        }

        _noResultsCard.Visible = false;
        EnsureResultsCardVisible();
        UpdateEmailScrollHeight();
        _sendBtn.Enabled = CanSend();
    }

    private void ShowNoResultsState()
    {
        _resultsCard.Visible = false;
        _noResultsCard.Visible = true;
    }

    private void EnsureResultsCardVisible()
    {
        if (_emailRows.Count == 0)
        {
            return;
        }

        _resultsCard.Visible = true;
        _noResultsCard.Visible = false;
        _sendBtn.Visible = true;
        _emailScroll.Visible = true;
    }

    private void UpdateEmailScrollHeight()
    {
        var count = _emailRows.Count;
        if (count == 0)
        {
            _emailScroll.Height = 0;
            return;
        }

        var visible = Math.Min(count, MaxVisibleEmails);
        var h = visible * EmailRowHeight + 6;
        _emailScroll.Height = h;
        _emailScroll.MinimumSize = new Size(CardWidth - 24, h);
        _emailFlow.PerformLayout();
        _emailScroll.PerformLayout();
        _resultsCard.PerformLayout();
    }

    private void SelectEmailByAddress(string email)
    {
        var index = _emailRows.FindIndex(r =>
            string.Equals(r.Email, email, StringComparison.OrdinalIgnoreCase));
        SelectEmail(index);
    }

    private void SelectEmail(int index)
    {
        if (index < 0 || index >= _emailRows.Count)
        {
            return;
        }

        _selectedEmailIndex = index;
        _selectedEmail = _emailRows[index].Email;
        for (var i = 0; i < _emailRows.Count; i++)
        {
            _emailRows[i].SetSelected(i == index);
        }

        _sendBtn.Enabled = CanSend();
    }

    private void SetActivityFromLog(WidgetLogLine line)
    {
        var text = line.Text;
        if (text.Length > 88)
        {
            text = text[..85] + "…";
        }

        if (line.Kind == WidgetLogKind.Skip)
        {
            SetActivity(_activityLine1.Text, text, _activityLine1Kind);
            return;
        }

        SetActivity(text, _activityLine1.Text, line.Kind);
    }

    private void SetActivity(string line1, string line2, WidgetLogKind line1Kind = WidgetLogKind.Info)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => SetActivity(line1, line2, line1Kind));
            return;
        }

        _activityLine1Kind = line1Kind;
        _activityLine1.Text = line1;
        _activityLine1.ForeColor = WidgetTheme.LogColor(line1Kind);
        _activityLine2.Text = line2;
        _activityLine2.ForeColor = WidgetTheme.TextMuted;
        UpdateSearchChrome();
    }

    private void ClearEmailRows()
    {
        foreach (var row in _emailRows)
        {
            row.Dispose();
        }

        _emailRows.Clear();
        _emailFlow.Controls.Clear();
        _rowByEmail.Clear();
        _selectedEmailIndex = -1;
        _selectedEmail = null;
    }

    private void ResetResultsUi()
    {
        ClearEmailRows();
        _resultsCard.Visible = false;
        _noResultsCard.Visible = false;
        _result = null;
        _nameBox.Clear();
        _linkBox.Clear();
        _sendBtn.Visible = true;
        ClearSendStatus();
    }

    private void ClearSearchSession(bool keepUrl)
    {
        _searchCts?.Cancel();
        _searchRunning = false;
        _stopRequested = false;
        UpdateSearchChrome();
        ResetResultsUi();
        _sessionLogin = "";
        _sessionCountry = "";
        _sessionProfileUrl = "";
        SetActivity("", "", WidgetLogKind.Info);
        if (!keepUrl)
        {
            _urlBox.Clear();
        }
    }

    private void OnTemplateChanged()
    {
        var idx = _templateCombo.SelectedIndex;
        if (idx < 0 || idx >= WidgetMailTemplates.All.Count)
        {
            return;
        }

        _selectedTemplate = WidgetMailTemplates.All[idx];
        WidgetSettings.Set(WidgetSettings.TemplateIdKey, _selectedTemplate.Id);
    }

    // Pull templates from the app's database (/api/templates) so widget sends
    // always use what Manage Templates saved. Built-ins stay as the fallback
    // when the server can't be reached.
    private async Task LoadTemplatesAsync()
    {
        try
        {
            var templates = await _search.GetTemplatesAsync();
            WidgetMailTemplates.ApplyServerTemplates(templates);
            RefreshTemplateCombo();
        }
        catch (Exception ex)
        {
            LauncherLog.Write($"Widget templates load failed (using built-ins): {ex.Message}");
        }
    }

    private void RefreshTemplateCombo()
    {
        var all = WidgetMailTemplates.All;
        var selectedId = _selectedTemplate.Id;

        // Skip the rebuild when labels are unchanged - avoids flicker on the
        // post-dropdown refresh.
        var unchanged = _templateCombo.Items.Count == all.Count;
        for (var i = 0; unchanged && i < all.Count; i++)
        {
            unchanged = string.Equals(_templateCombo.Items[i] as string, all[i].Label, StringComparison.Ordinal);
        }

        if (!unchanged)
        {
            _templateCombo.BeginUpdate();
            _templateCombo.Items.Clear();
            foreach (var t in all)
            {
                _templateCombo.Items.Add(t.Label);
            }
            _templateCombo.SelectedIndex = Math.Max(0, all.ToList().FindIndex(t => t.Id == selectedId));
            _templateCombo.EndUpdate();
        }

        // Re-resolve so edited subject/body take effect even when the list
        // shape didn't change.
        _selectedTemplate = WidgetMailTemplates.GetById(selectedId);
    }

    // Send the selected email using the chosen template. On success it shows an
    // inline "sent" log, marks the row, and advances to the next unsent contact
    // so a profile's emails can be worked through without restarting the search.
    private async Task RunSendAsync()
    {
        if (string.IsNullOrEmpty(_selectedEmail) ||
            !_rowByEmail.TryGetValue(_selectedEmail, out var row) ||
            !CanSend())
        {
            return;
        }

        var login = GetActiveLogin();
        var email = row.Email;
        var from = _senders[_senderCombo.SelectedIndex];
        var name = _nameBox.Text;
        var link = _linkBox.Text;
        var country = _result?.Country ?? _sessionCountry;
        var subject = WidgetMailTemplates.Substitute(_selectedTemplate.Subject, name, link);
        var body = WidgetMailTemplates.Substitute(_selectedTemplate.Body, name, link);

        _sendBtn.Enabled = false;
        _sendBtn.Text = "Sending…";
        ClearSendStatus();
        row.SetSendState(WidgetSendState.Sending);
        Reflow();

        try
        {
            await _search.SendAsync(from, email, subject, body, name, link, login, country);
            row.SetSendState(WidgetSendState.Sent);
            ShowSendStatus($"✓ Sent to {email}", WidgetTheme.Success);
            LauncherLog.Write($"Widget send → {email} ({_selectedTemplate.Id})");
            AdvanceToNextUnsent();
        }
        catch (Exception ex)
        {
            row.SetSendState(WidgetSendState.Failed, ex.Message);
            ShowSendStatus($"✕ Send failed: {ex.Message}", WidgetTheme.Error);
            LauncherLog.Write($"Widget send failed → {email}: {ex.Message}");
        }
        finally
        {
            _sendBtn.Text = "Send email";
            _sendBtn.Enabled = CanSend();
            Reflow();
        }
    }

    private void AdvanceToNextUnsent()
    {
        for (var i = 0; i < _emailRows.Count; i++)
        {
            var idx = (_selectedEmailIndex + 1 + i) % _emailRows.Count;
            if (!_emailRows[idx].Sent)
            {
                SelectEmail(idx);
                return;
            }
        }
    }

    private void ShowSendStatus(string text, Color color)
    {
        _sendStatusLabel.Text = text;
        _sendStatusLabel.ForeColor = color;
        _sendStatusLabel.Height = 32;
        _sendStatusLabel.Visible = true;
    }

    private void ClearSendStatus()
    {
        _sendStatusLabel.Text = "";
        _sendStatusLabel.Height = 0;
        _sendStatusLabel.Visible = false;
    }

    private string GetActiveLogin()
    {
        if (!string.IsNullOrEmpty(_sessionLogin))
        {
            return _sessionLogin;
        }

        return _result?.Login ?? "";
    }

    private bool CanSend() =>
        !string.IsNullOrEmpty(GetActiveLogin()) &&
        !string.IsNullOrEmpty(_selectedEmail) &&
        _smtpConfigured &&
        _senders.Count > 0 &&
        _senderCombo.SelectedIndex >= 0;

    private async Task LoadSendersAsync()
    {
        try
        {
            var data = await _search.GetSendersAsync();
            _smtpConfigured = data.SmtpConfigured;
            _senders = data.Identities;
            _senderCombo.Items.Clear();
            foreach (var s in _senders)
            {
                _senderCombo.Items.Add($"{s.Name} <{s.Email}>");
            }

            if (_senderCombo.Items.Count > 0)
            {
                _senderCombo.SelectedIndex = 0;
            }
        }
        catch (Exception ex)
        {
            SetActivity(ex.Message, "", WidgetLogKind.Error);
        }
    }

    private void ResetToInput()
    {
        ClearSearchSession(keepUrl: false);
        Reflow();
        _urlBox.Focus();
    }

    private void Reflow()
    {
        _rootFlow.PerformLayout();
        var w = _rootFlow.PreferredSize.Width + 4;
        var h = _rootFlow.PreferredSize.Height + 4;
        ClientSize = new Size(Math.Max(CardWidth + 20, w), Math.Max(80, h));
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
        }
        else
        {
            base.OnFormClosing(e);
        }
    }

    public void ShowWidget()
    {
        if (!Visible)
        {
            Show();
        }

        Activate();
        BringToFront();
        TopMost = true;
        _urlBox.Focus();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _debounceTimer.Dispose();
            _searchCts?.Cancel();
            _searchCts?.Dispose();
            _mailIconImage?.Dispose();
            ClearEmailRows();
        }

        base.Dispose(disposing);
    }
}
