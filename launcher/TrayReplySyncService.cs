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
            if (!await IsSyncConfiguredAsync())
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

    private async Task<bool> IsSyncConfiguredAsync()
    {
        try
        {
            using var res = await _http.GetAsync($"{_appUrl}/api/senders");
            if (!res.IsSuccessStatusCode)
            {
                return false;
            }

            var data = await res.Content.ReadFromJsonAsync<TraySendersResponse>(JsonOptions);
            return data is { SheetsConfigured: true, GmailReplySyncConfigured: true };
        }
        catch
        {
            return false;
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
