using System.Net.Http.Json;
using System.Text.Json;

namespace EmailFinderTray;

/// <summary>
/// Polls /api/sync-replies while the tray app runs so history stays current without opening the browser window.
/// </summary>
internal sealed class TrayReplySyncService : IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private const int DefaultIntervalSeconds = 60;
    private const int MinIntervalSeconds = 30;

    // Bump when the dedup source changes so existing state re-seeds once.
    private const int StateVersion = 2;

    private readonly HttpClient _http;
    private readonly string _appUrl;
    private readonly string _statePath;
    private readonly SynchronizationContext _ui;
    private readonly System.Threading.Timer _timer;
    private readonly object _gate = new();
    private bool _busy;
    private bool _disposed;

    /// <summary>Raised on the UI thread with replies not seen in prior sessions.</summary>
    public event Action<IReadOnlyList<TrayReplyNotification>>? NewReplies;

    /// <summary>Raised on the UI thread when a sending account is newly blocked by Gmail.</summary>
    public event Action<IReadOnlyList<TraySenderBlock>>? SenderBlocked;

    public TrayReplySyncService(
        HttpClient http,
        string appUrl,
        string projectRoot,
        SynchronizationContext ui)
    {
        _http = http;
        _appUrl = appUrl.TrimEnd('/');
        _statePath = Path.Combine(projectRoot, ".data", "tray-reply-sync.json");
        _ui = ui;

        var intervalSeconds = DefaultIntervalSeconds;
        try
        {
            var envPath = Path.Combine(projectRoot, ".env.local");
            if (!File.Exists(envPath))
            {
                envPath = Path.Combine(projectRoot, ".env");
            }

            if (File.Exists(envPath))
            {
                foreach (var line in File.ReadAllLines(envPath))
                {
                    var trimmed = line.Trim();
                    if (trimmed.StartsWith("NEXT_PUBLIC_REPLY_SYNC_MS=", StringComparison.Ordinal))
                    {
                        var val = trimmed["NEXT_PUBLIC_REPLY_SYNC_MS=".Length..].Trim().Trim('"');
                        if (int.TryParse(val, out var ms) && ms >= MinIntervalSeconds * 1000)
                        {
                            intervalSeconds = Math.Max(MinIntervalSeconds, ms / 1000);
                        }

                        break;
                    }
                }
            }
        }
        catch
        {
            // Keep default interval.
        }

        var interval = TimeSpan.FromSeconds(intervalSeconds);
        _timer = new System.Threading.Timer(
            _ => _ = RunCycleAsync(),
            null,
            TimeSpan.FromSeconds(8),
            interval);
    }

    private string UiStatePath => _statePath;

    private TrayReplySyncUiState LoadUiState()
    {
        try
        {
            if (!File.Exists(UiStatePath))
            {
                return new TrayReplySyncUiState();
            }

            var json = File.ReadAllText(UiStatePath);
            return JsonSerializer.Deserialize<TrayReplySyncUiState>(json, JsonOptions)
                   ?? new TrayReplySyncUiState();
        }
        catch
        {
            return new TrayReplySyncUiState();
        }
    }

    private void SaveUiState(TrayReplySyncUiState state)
    {
        try
        {
            var dir = Path.GetDirectoryName(UiStatePath);
            if (!string.IsNullOrEmpty(dir))
            {
                Directory.CreateDirectory(dir);
            }

            File.WriteAllText(UiStatePath, JsonSerializer.Serialize(state, JsonOptions));
        }
        catch (Exception ex)
        {
            LauncherLog.Write($"Tray reply sync state save: {ex.Message}");
        }
    }

    public Task RunNowAsync() => RunCycleAsync();

    private async Task RunCycleAsync()
    {
        lock (_gate)
        {
            if (_busy || _disposed)
            {
                return;
            }

            _busy = true;
        }

        try
        {
            var senders = await FetchSendersAsync();

            // Gmail blocks toast regardless of whether reply sync / Sheets are
            // configured — they are independent features sharing one poll, and
            // gating them behind the reply-sync check would leave a Sheets-less
            // install with no warning that an account stopped sending.
            //
            // Only on a SUCCESSFUL poll: a null response means we don't know the
            // block state, and treating that as "nothing blocked" would both
            // clear ToastedBlocks for still-active blocks (re-toasting them on
            // the next good poll) and, on a first run while the server is still
            // booting, mark the seed done against an empty list.
            if (senders != null)
            {
                HandleSenderBlocks(senders.SenderBlocks);
            }

            if (senders is not { SheetsConfigured: true, GmailReplySyncConfigured: true })
            {
                return;
            }

            using var res = await _http.PostAsJsonAsync(
                $"{_appUrl}/api/sync-replies",
                new { lastMessageIds = new Dictionary<string, string>() });

            if (!res.IsSuccessStatusCode)
            {
                var errBody = await res.Content.ReadAsStringAsync();
                LauncherLog.Write($"Tray reply sync HTTP {(int)res.StatusCode}: {errBody}");
                return;
            }

            var data = await res.Content.ReadFromJsonAsync<TraySyncRepliesResponse>(JsonOptions);
            if (data == null || !data.Ok)
            {
                LauncherLog.Write($"Tray reply sync failed: {data?.Error ?? "unknown"}");
                return;
            }

            if (!data.Configured)
            {
                return;
            }

            // Prefer the full reply set (dedup client-side). Fall back to the
            // newly-changed notifications for older server builds.
            var items = data.Replies.Count > 0 ? data.Replies : data.Notifications;
            HandleNotifications(items);
        }
        catch (Exception ex)
        {
            LauncherLog.Write($"Tray reply sync: {ex.Message}");
        }
        finally
        {
            lock (_gate)
            {
                _busy = false;
            }
        }
    }

    private async Task<TraySendersResponse?> FetchSendersAsync()
    {
        try
        {
            using var res = await _http.GetAsync($"{_appUrl}/api/senders");
            if (!res.IsSuccessStatusCode)
            {
                return null;
            }

            return await res.Content.ReadFromJsonAsync<TraySendersResponse>(JsonOptions);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Toast accounts newly blocked by Gmail. Dedups on DetectedAt rather than
    /// the day, so a "Resume now" followed by a second block the same day is
    /// treated as the genuinely new event it is.
    /// </summary>
    private void HandleSenderBlocks(IReadOnlyList<TraySenderBlock> blocks)
    {
        var state = LoadUiState();

        // First run: remember what is already blocked without popping up.
        if (!state.BlocksSeeded)
        {
            state.BlocksSeeded = true;
            state.ToastedBlocks.Clear();
            foreach (var b in blocks)
            {
                if (!string.IsNullOrEmpty(b.Sender))
                {
                    state.ToastedBlocks[b.Sender] = b.DetectedAt;
                }
            }

            SaveUiState(state);
            if (blocks.Count > 0)
            {
                LauncherLog.Write($"Tray sender blocks seeded ({blocks.Count} existing; no popups).");
            }

            return;
        }

        var fresh = new List<TraySenderBlock>();
        foreach (var b in blocks)
        {
            if (string.IsNullOrEmpty(b.Sender))
            {
                continue;
            }

            if (state.ToastedBlocks.TryGetValue(b.Sender, out var prev) &&
                string.Equals(prev, b.DetectedAt, StringComparison.Ordinal))
            {
                continue;
            }

            fresh.Add(b);
            state.ToastedBlocks[b.Sender] = b.DetectedAt;
        }

        // Forget accounts that are no longer blocked, so tomorrow's block on the
        // same account is seen as new.
        var active = new HashSet<string>(StringComparer.Ordinal);
        foreach (var b in blocks)
        {
            active.Add(b.Sender);
        }

        var stale = new List<string>();
        foreach (var key in state.ToastedBlocks.Keys)
        {
            if (!active.Contains(key))
            {
                stale.Add(key);
            }
        }

        foreach (var key in stale)
        {
            state.ToastedBlocks.Remove(key);
        }

        if (fresh.Count == 0 && stale.Count == 0)
        {
            return;
        }

        SaveUiState(state);
        if (fresh.Count > 0)
        {
            _ui.Post(_ => SenderBlocked?.Invoke(fresh), null);
        }
    }

    private void HandleNotifications(IReadOnlyList<TrayReplyNotification> notifications)
    {
        if (notifications.Count == 0)
        {
            return;
        }

        var state = LoadUiState();
        if (!state.Seeded || state.Version != StateVersion)
        {
            state.Seeded = true;
            state.Version = StateVersion;
            state.ToastedMessageIds.Clear();
            foreach (var n in notifications)
            {
                if (n.Row > 0 && !string.IsNullOrEmpty(n.MessageId))
                {
                    state.ToastedMessageIds[n.Row.ToString()] = n.MessageId;
                }
            }

            SaveUiState(state);
            if (notifications.Count > 0)
            {
                LauncherLog.Write(
                    $"Tray reply sync seeded ({notifications.Count} existing thread(s); no popups).");
            }

            return;
        }

        var fresh = new List<TrayReplyNotification>();
        foreach (var n in notifications)
        {
            if (n.Row <= 0 || string.IsNullOrEmpty(n.MessageId))
            {
                continue;
            }

            var key = n.Row.ToString();
            if (state.ToastedMessageIds.TryGetValue(key, out var prev) &&
                string.Equals(prev, n.MessageId, StringComparison.Ordinal))
            {
                continue;
            }

            fresh.Add(n);
            state.ToastedMessageIds[key] = n.MessageId;
        }

        if (fresh.Count == 0)
        {
            return;
        }

        SaveUiState(state);
        _ui.Post(_ => NewReplies?.Invoke(fresh), null);
    }

    public void Dispose()
    {
        lock (_gate)
        {
            _disposed = true;
        }

        _timer.Dispose();
    }
}
