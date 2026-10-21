using System.Net;
using System.Text;
using System.Text.Json;
using TraceVault.Agent.Core;
using Xunit;

namespace TraceVault.Agent.Tests;

public class MapperTests
{
    private static RawLogRecord Rec(string log, int id, long rid, params (string, string)[] data) =>
        new(log, id, rid, DateTimeOffset.Parse("2026-10-21T10:00:00+01:00"), "test", data.ToDictionary(d => d.Item1, d => d.Item2));

    [Fact]
    public void Interactive_logon_maps_to_user_login_with_minimal_metadata()
    {
        var e = WindowsEventMapper.Map(Rec("Security", 4624, 1, ("TargetUserName", "alice"), ("LogonType", "2"), ("IpAddress", "10.0.0.5"), ("ProcessName", "C:\\x.exe")), "m")!;
        Assert.Equal("user_login", e.EventType);
        Assert.Equal("windows", e.Source);
        Assert.Equal("2026-10-21T09:00:00.0000000+00:00", e.OccurredAt);
        Assert.Equal("alice", e.Metadata["account_name"]);
        Assert.False(e.Metadata.ContainsKey("IpAddress"));
        Assert.DoesNotContain(e.Metadata.Values, v => v is string s && (s.Contains("10.0.0.5") || s.Contains("x.exe")));
    }

    [Theory]
    [InlineData("3")] // network logon
    [InlineData("5")] // service logon
    public void Service_and_network_logons_are_ignored(string type) =>
        Assert.Null(WindowsEventMapper.Map(Rec("Security", 4624, 1, ("TargetUserName", "alice"), ("LogonType", type)), "m"));

    [Fact]
    public void Machine_accounts_are_ignored() =>
        Assert.Null(WindowsEventMapper.Map(Rec("Security", 4624, 1, ("TargetUserName", "DESKTOP$"), ("LogonType", "2")), "m"));

    [Fact]
    public void Account_creation_and_admin_grant_are_high_severity()
    {
        var created = WindowsEventMapper.Map(Rec("Security", 4720, 2, ("TargetUserName", "helpdesk2"), ("SubjectUserName", "guest")), "m")!;
        Assert.Equal(("local_account_created", "high"), (created.EventType, created.Severity));
        var admin = WindowsEventMapper.Map(Rec("Security", 4732, 3, ("TargetSid", "S-1-5-32-544"), ("MemberSid", "S-1-5-21-1"), ("SubjectUserName", "guest")), "m")!;
        Assert.Equal("privilege_granted", admin.EventType);
        Assert.Null(WindowsEventMapper.Map(Rec("Security", 4732, 4, ("TargetSid", "S-1-5-32-545")), "m")); // Users group
    }

    [Fact]
    public void Defender_disabled_maps_to_high_security_setting_change()
    {
        var e = WindowsEventMapper.Map(Rec(WindowsEventMapper.DefenderLog, 5001, 9), "m")!;
        Assert.Equal(("security_setting_changed", "high"), (e.EventType, e.Severity));
        Assert.Equal(false, e.Metadata["new_value"]);
    }

    [Fact]
    public void Event_ids_are_stable_uuids_per_record()
    {
        var a = WindowsEventMapper.StableEventId("m", "Security", 42);
        Assert.Equal(a, WindowsEventMapper.StableEventId("m", "Security", 42));
        Assert.NotEqual(a, WindowsEventMapper.StableEventId("m", "Security", 43));
        Assert.NotEqual(a, WindowsEventMapper.StableEventId("other", "Security", 42));
        Assert.Matches("^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", a);
    }

    [Fact]
    public void XPath_selects_subscribed_ids() =>
        Assert.Equal("*[System[(EventID=6005 or EventID=6006 or EventID=6008)]]", WindowsEventMapper.XPathFor("System"));
}

/// <summary>Fake event log + fake HTTP server to exercise the full agent cycle on any OS.</summary>
public class AgentCycleTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("tv-agent-").FullName;
    public void Dispose() => Directory.Delete(_dir, true);

    private sealed class FakeSource : IEventSource
    {
        public List<RawLogRecord> Security = new();
        public bool DenySecurity;
        public long? LatestRecordId(string log) => log == "Security"
            ? (DenySecurity ? throw new LogUnavailableException("denied", true) : Security.Count == 0 ? null : Security.Max(r => r.RecordId))
            : throw new LogUnavailableException("missing", false);
        public IEnumerable<RawLogRecord> ReadAfter(string log, long after, int max) =>
            log == "Security"
                ? (DenySecurity ? throw new LogUnavailableException("denied", true) : Security.Where(r => r.RecordId > after).Take(max))
                : throw new LogUnavailableException("missing", false);
        public void Add(int eventId, long rid, params (string, string)[] data) =>
            Security.Add(new RawLogRecord("Security", eventId, rid, DateTimeOffset.UtcNow, "x", data.ToDictionary(d => d.Item1, d => d.Item2)));
    }

    private sealed class FakeServer : HttpMessageHandler
    {
        public readonly List<JsonElement> Batches = new();
        public readonly List<JsonElement> Heartbeats = new();
        public readonly HashSet<string> Stored = new();
        public Func<HttpStatusCode?> Fail = () => null;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct)
        {
            if (Fail() is HttpStatusCode code) return new HttpResponseMessage(code);
            Assert.StartsWith("Device tvd_", req.Headers.GetValues("Authorization").Single());
            var body = JsonDocument.Parse(await req.Content!.ReadAsStringAsync(ct)).RootElement.Clone();
            if (req.RequestUri!.AbsolutePath.EndsWith("/heartbeat")) { Heartbeats.Add(body); return new HttpResponseMessage(HttpStatusCode.OK); }
            Batches.Add(body);
            var ids = body.GetProperty("events").EnumerateArray().Select(e => e.GetProperty("event_id").GetString()!).ToList();
            var accepted = ids.Count(Stored.Add);
            var json = JsonSerializer.Serialize(new { accepted, duplicates = ids.Count - accepted, rejected = Array.Empty<object>() });
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
        }
    }

    private (AgentService agent, FakeSource src, FakeServer srv, StateStore store) Build(FakeSource? src = null, FakeServer? srv = null)
    {
        src ??= new FakeSource();
        srv ??= new FakeServer();
        var store = new StateStore(Path.Combine(_dir, "state.json"), new PassThroughProtector());
        var http = new HttpClient(srv) { BaseAddress = new Uri("http://localhost/") };
        var api = new ApiClient(http, "tvd_testsecretvalue", _ => Task.CompletedTask, maxAttempts: 2);
        var queue = new OfflineQueue(Path.Combine(_dir, "queue.bin"), new PassThroughProtector());
        return (new AgentService(src, store, queue, api, "Windows 11 test"), src, srv, store);
    }

    [Fact]
    public async Task First_run_skips_history_then_uploads_new_events()
    {
        var (agent, src, srv, _) = Build();
        src.Add(4624, 1, ("TargetUserName", "before-enrollment"), ("LogonType", "2"));
        var first = await agent.RunCycleAsync();
        Assert.Equal(0, first.Collected);
        src.Add(4720, 2, ("TargetUserName", "helpdesk2"));
        src.Add(4625, 3, ("TargetUserName", "alice"), ("LogonType", "2"));
        var second = await agent.RunCycleAsync();
        Assert.Equal(2, second.Collected);
        Assert.True(second.Sync!.Ok);
        Assert.Equal(2, srv.Stored.Count);
        Assert.Equal("active", srv.Heartbeats.Last().GetProperty("monitoring_status").GetString());
        Assert.Equal("granted", srv.Heartbeats.Last().GetProperty("permissions").GetProperty("security_log").GetString());
        Assert.Equal("unsupported", srv.Heartbeats.Last().GetProperty("permissions").GetProperty("system_log").GetString());
    }

    [Fact]
    public async Task Offline_events_stay_queued_and_upload_once_after_reconnect()
    {
        var (agent, src, srv, _) = Build();
        await agent.RunCycleAsync();
        var offline = true;
        srv.Fail = () => offline ? HttpStatusCode.ServiceUnavailable : null;
        src.Add(4800, 10, ("TargetUserName", "alice"));
        var down = await agent.RunCycleAsync();
        Assert.False(down.Sync!.Ok);
        Assert.Equal(1, agent.Queue.Count);
        offline = false;
        var up = await agent.RunCycleAsync();
        Assert.True(up.Sync!.Ok);
        Assert.Equal(0, agent.Queue.Count);
        Assert.Single(srv.Stored);
        Assert.Equal(0, srv.Heartbeats.Last().GetProperty("consecutive_upload_failures").GetInt32());
    }

    [Fact]
    public async Task Rereading_a_record_after_restart_is_deduplicated_by_stable_id()
    {
        var (agent, src, srv, store) = Build();
        await agent.RunCycleAsync();
        src.Add(4801, 5, ("TargetUserName", "alice"));
        await agent.RunCycleAsync();
        var s = store.Load();
        s.Checkpoints["Security"] = 0; // simulate a lost checkpoint
        store.Save(s);
        var again = await agent.RunCycleAsync();
        Assert.Equal(1, again.Sync!.Duplicates);
        Assert.Single(srv.Stored);
    }

    [Fact]
    public async Task Denied_security_log_reports_monitoring_unavailable()
    {
        var (agent, src, srv, _) = Build();
        src.DenySecurity = true;
        var r = await agent.RunCycleAsync();
        Assert.Equal(MonitoringStatus.Unavailable, r.Status);
        Assert.Equal("denied", srv.Heartbeats.Last().GetProperty("permissions").GetProperty("security_log").GetString());
    }

    [Fact]
    public async Task Pause_skips_activity_and_records_pause_events()
    {
        var (agent, src, srv, _) = Build();
        await agent.RunCycleAsync();
        agent.SetPaused(true);
        src.Add(4624, 20, ("TargetUserName", "during-pause"), ("LogonType", "2"));
        var paused = await agent.RunCycleAsync();
        Assert.Equal(MonitoringStatus.Paused, paused.Status);
        agent.SetPaused(false);
        await agent.RunCycleAsync();
        var types = srv.Batches.SelectMany(b => b.GetProperty("events").EnumerateArray()).Select(e => e.GetProperty("event_type").GetString()).ToList();
        Assert.Contains("monitoring_paused", types);
        Assert.Contains("monitoring_resumed", types);
        Assert.DoesNotContain("user_login", types);
    }

    [Fact]
    public async Task Revoked_credential_stops_the_agent()
    {
        var (agent, _, srv, store) = Build();
        agent.RecordLifecycle("agent_started", "user_requested");
        srv.Fail = () => HttpStatusCode.Unauthorized;
        var r = await agent.RunCycleAsync();
        Assert.True(r.Sync!.Revoked);
        Assert.Equal(MonitoringStatus.Disabled, r.Status);
        Assert.True(store.Load().Revoked);
        Assert.Null((await agent.RunCycleAsync()).Sync);
    }

    [Fact]
    public void Queue_caps_size_and_counts_dropped_events()
    {
        var q = new OfflineQueue(Path.Combine(_dir, "q.bin"), new PassThroughProtector(), capacity: 3);
        q.Enqueue(Enumerable.Range(0, 5).Select(i => new DeviceEvent(Guid.NewGuid().ToString(), "screen_locked", DateTimeOffset.UtcNow.ToString("O"), "windows", "info", new())));
        Assert.Equal(3, q.Count);
        Assert.Equal(2, q.Dropped);
        var reopened = new OfflineQueue(Path.Combine(_dir, "q.bin"), new PassThroughProtector(), capacity: 3);
        Assert.Equal(3, reopened.Count);
    }

    [Fact]
    public void Plain_http_is_refused_except_for_localhost()
    {
        Assert.Throws<ArgumentException>(() => new ApiClient(new HttpClient { BaseAddress = new Uri("http://api.example.com/") }));
        _ = new ApiClient(new HttpClient { BaseAddress = new Uri("https://api.example.com/") });
    }
}
