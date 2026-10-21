using System.Text.Json;
using System.Text.Json.Serialization;

namespace TraceVault.Agent.Core;

/// <summary>Reads new records from one event log. Implemented with EventLogReader on Windows; faked in tests.</summary>
public interface IEventSource
{
    /// <summary>Highest record id currently in the log, or null if the log is empty.</summary>
    long? LatestRecordId(string logName);
    /// <summary>Records with RecordId greater than <paramref name="afterRecordId"/>, oldest first.</summary>
    IEnumerable<RawLogRecord> ReadAfter(string logName, long afterRecordId, int max);
}

public sealed class LogUnavailableException : Exception
{
    public bool Denied { get; }
    public LogUnavailableException(string message, bool denied) : base(message) => Denied = denied;
}

public sealed class AgentState
{
    [JsonPropertyName("api_url")] public string ApiUrl { get; set; } = "";
    [JsonPropertyName("device_id")] public string? DeviceId { get; set; }
    /// <summary>Device secret, encrypted with IDataProtector (DPAPI on Windows) and base64 encoded.</summary>
    [JsonPropertyName("device_secret_protected")] public string? DeviceSecretProtected { get; set; }
    [JsonPropertyName("machine_key")] public string MachineKey { get; set; } = Guid.NewGuid().ToString("N");
    [JsonPropertyName("checkpoints")] public Dictionary<string, long> Checkpoints { get; set; } = new();
    [JsonPropertyName("paused")] public bool Paused { get; set; }
    [JsonPropertyName("startup_enabled")] public bool StartupEnabled { get; set; }
    [JsonPropertyName("revoked")] public bool Revoked { get; set; }
    [JsonPropertyName("last_sync")] public DateTimeOffset? LastSync { get; set; }
    [JsonPropertyName("last_error")] public string? LastError { get; set; }
}

public sealed class StateStore
{
    private readonly string _path;
    private readonly IDataProtector _protector;
    public StateStore(string path, IDataProtector protector)
    {
        _path = path;
        _protector = protector;
    }

    public AgentState Load() =>
        File.Exists(_path) ? JsonSerializer.Deserialize<AgentState>(File.ReadAllText(_path)) ?? new AgentState() : new AgentState();

    public void Save(AgentState s)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var tmp = _path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(s, new JsonSerializerOptions { WriteIndented = true }));
        File.Move(tmp, _path, overwrite: true);
    }

    public string ProtectSecret(string secret) => Convert.ToBase64String(_protector.Protect(System.Text.Encoding.UTF8.GetBytes(secret)));
    public string UnprotectSecret(string blob) => System.Text.Encoding.UTF8.GetString(_protector.Unprotect(Convert.FromBase64String(blob)));
}

public sealed record CycleReport(MonitoringStatus Status, int Collected, SyncOutcome? Sync, IReadOnlyDictionary<string, string> Permissions);

/// <summary>
/// One collection + upload cycle. Collected events are written to the encrypted
/// queue before checkpoints advance (at-least-once); stable event ids make
/// re-reads harmless because the server deduplicates them.
/// </summary>
public sealed class AgentService
{
    public const string AgentVersion = "0.1.0";
    private readonly IEventSource _source;
    private readonly StateStore _store;
    private readonly OfflineQueue _queue;
    private readonly ApiClient _api;
    private readonly string _osVersion;

    public AgentService(IEventSource source, StateStore store, OfflineQueue queue, ApiClient api, string osVersion)
    {
        _source = source;
        _store = store;
        _queue = queue;
        _api = api;
        _osVersion = osVersion;
    }

    public OfflineQueue Queue => _queue;

    private DeviceEvent AgentEvent(string type, Dictionary<string, object?> meta, string severity = "info") =>
        new(Guid.NewGuid().ToString(), type, DateTimeOffset.UtcNow.ToString("O"), "windows", severity, meta);

    public void RecordLifecycle(string type, string reason) =>
        _queue.Enqueue(new[] { AgentEvent(type, new() { ["reason"] = reason, ["agent_version"] = AgentVersion }) });

    public void SetPaused(bool paused)
    {
        var s = _store.Load();
        if (s.Paused == paused) return;
        s.Paused = paused;
        if (!paused)
        {
            // Activity during a pause is intentionally not collected: skip to the current end of each log.
            foreach (var log in WindowsEventMapper.Subscriptions.Keys)
            {
                try { s.Checkpoints[log] = _source.LatestRecordId(log) ?? 0; } catch (LogUnavailableException) { }
            }
        }
        _store.Save(s);
        _queue.Enqueue(new[] { AgentEvent(paused ? "monitoring_paused" : "monitoring_resumed", new() { ["reason"] = "user_requested" }, paused ? "low" : "info") });
    }

    public async Task<CycleReport> RunCycleAsync(CancellationToken ct = default)
    {
        var s = _store.Load();
        var permissions = new Dictionary<string, string>();
        var collected = 0;
        if (s.Revoked) return new CycleReport(MonitoringStatus.Disabled, 0, null, permissions);

        if (!s.Paused)
        {
            foreach (var log in WindowsEventMapper.Subscriptions.Keys)
            {
                var key = PermissionKey(log);
                try
                {
                    if (!s.Checkpoints.TryGetValue(log, out var after))
                    {
                        // First run: history before enrollment is not uploaded.
                        s.Checkpoints[log] = _source.LatestRecordId(log) ?? 0;
                        permissions[key] = "granted";
                        continue;
                    }
                    var records = _source.ReadAfter(log, after, 1000).ToList();
                    var events = records.Select(r => WindowsEventMapper.Map(r, s.MachineKey)).OfType<DeviceEvent>().ToList();
                    _queue.Enqueue(events);
                    collected += events.Count;
                    if (records.Count > 0) s.Checkpoints[log] = records.Max(r => r.RecordId);
                    permissions[key] = "granted";
                }
                catch (LogUnavailableException ex)
                {
                    permissions[key] = ex.Denied ? "denied" : "unsupported";
                }
            }
            _store.Save(s);
        }

        var status = s.Paused
            ? MonitoringStatus.Paused
            : permissions.GetValueOrDefault(PermissionKey(WindowsEventMapper.SecurityLog)) == "granted" ? MonitoringStatus.Active : MonitoringStatus.Unavailable;

        var sync = await _api.SyncAsync(_queue, ct: ct);
        s = _store.Load();
        if (sync.Revoked) s.Revoked = true;
        if (sync.Ok) s.LastSync = DateTimeOffset.UtcNow;
        s.LastError = sync.Error;
        _store.Save(s);
        if (!sync.Revoked)
        {
            try
            {
                await _api.HeartbeatAsync(status, permissions, s.StartupEnabled, _queue.Count, AgentVersion, _osVersion, ct);
            }
            catch (CredentialRevokedException)
            {
                s.Revoked = true;
                _store.Save(s);
            }
        }
        return new CycleReport(s.Revoked ? MonitoringStatus.Disabled : status, collected, sync, permissions);
    }

    public static string PermissionKey(string log) => log switch
    {
        WindowsEventMapper.SecurityLog => "security_log",
        WindowsEventMapper.SystemLog => "system_log",
        WindowsEventMapper.DefenderLog => "defender_log",
        WindowsEventMapper.FirewallLog => "firewall_log",
        _ => log.ToLowerInvariant(),
    };
}
