using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace TraceVault.Agent.Core;

public sealed class CredentialRevokedException : Exception
{
    public CredentialRevokedException() : base("Device credential was revoked or is invalid.") { }
}

public sealed record SyncOutcome(bool Ok, int Uploaded, int Duplicates, int Rejected, string? Error, bool Revoked = false);

/// <summary>
/// HTTPS client for the device endpoints. Retries network errors, 5xx and 429
/// with exponential backoff and jitter. 401 means the credential was revoked.
/// </summary>
public sealed class ApiClient
{
    private readonly HttpClient _http;
    private readonly Func<TimeSpan, Task> _delay;
    private readonly int _maxAttempts;
    private string? _secret;

    public int ConsecutiveFailures { get; private set; }
    public string? LastError { get; private set; }
    public DateTimeOffset? LastSuccessfulSync { get; private set; }

    public ApiClient(HttpClient http, string? deviceSecret = null, Func<TimeSpan, Task>? delay = null, int maxAttempts = 5)
    {
        _http = http;
        _secret = deviceSecret;
        _delay = delay ?? (t => Task.Delay(t));
        _maxAttempts = maxAttempts;
        if (http.BaseAddress is { Scheme: not "https" } u && !u.IsLoopback)
            throw new ArgumentException("The API address must use HTTPS (plain HTTP is only allowed for localhost development).");
    }

    public async Task<Registration> RegisterAsync(string enrollmentCode, string name, string osVersion, string agentVersion, CancellationToken ct = default)
    {
        var res = await _http.PostAsJsonAsync("v1/devices/register",
            new { enrollment_code = enrollmentCode, name, platform = "windows", os_version = osVersion, agent_version = agentVersion }, ct);
        if (!res.IsSuccessStatusCode)
        {
            var msg = await ReadMessage(res, ct);
            throw new InvalidOperationException($"Enrollment failed: {msg}");
        }
        var reg = (await res.Content.ReadFromJsonAsync<Registration>(cancellationToken: ct))!;
        _secret = reg.DeviceSecret;
        return reg;
    }

    private static async Task<string> ReadMessage(HttpResponseMessage res, CancellationToken ct)
    {
        try
        {
            using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
            return doc.RootElement.TryGetProperty("message", out var m) ? m.ToString() : res.StatusCode.ToString();
        }
        catch (JsonException) { return res.StatusCode.ToString(); }
    }

    private HttpRequestMessage Authed(HttpMethod method, string path, object? body)
    {
        var req = new HttpRequestMessage(method, path);
        req.Headers.TryAddWithoutValidation("Authorization", $"Device {_secret}");
        if (body is not null) req.Content = JsonContent.Create(body);
        return req;
    }

    private async Task<BatchResult> SendBatchAsync(IReadOnlyList<DeviceEvent> events, CancellationToken ct)
    {
        for (var attempt = 1; ; attempt++)
        {
            TimeSpan? retryAfter = null;
            try
            {
                using var res = await _http.SendAsync(Authed(HttpMethod.Post, "v1/events/batch", new { events }), ct);
                if (res.IsSuccessStatusCode) return (await res.Content.ReadFromJsonAsync<BatchResult>(cancellationToken: ct))!;
                if (res.StatusCode == HttpStatusCode.Unauthorized) throw new CredentialRevokedException();
                if (res.StatusCode == HttpStatusCode.TooManyRequests) retryAfter = res.Headers.RetryAfter?.Delta;
                else if ((int)res.StatusCode < 500) throw new InvalidOperationException($"Server rejected the batch: {await ReadMessage(res, ct)}");
                LastError = $"HTTP {(int)res.StatusCode}";
            }
            catch (HttpRequestException ex) { LastError = ex.Message; }
            catch (TaskCanceledException) when (!ct.IsCancellationRequested) { LastError = "request timed out"; }
            if (attempt >= _maxAttempts) throw new HttpRequestException(LastError);
            var backoff = retryAfter ?? TimeSpan.FromMilliseconds(1000 * Math.Pow(2, attempt - 1) * (0.5 + Random.Shared.NextDouble()));
            await _delay(backoff);
        }
    }

    public async Task<SyncOutcome> SyncAsync(OfflineQueue queue, int batchSize = 200, CancellationToken ct = default)
    {
        int up = 0, dup = 0, rej = 0;
        while (queue.Count > 0)
        {
            var batch = queue.Peek(batchSize);
            try
            {
                var r = await SendBatchAsync(batch, ct);
                up += r.Accepted;
                dup += r.Duplicates;
                rej += r.Rejected.Count;
                queue.Ack(batch.Select(e => e.EventId));
                ConsecutiveFailures = 0;
                LastError = null;
                LastSuccessfulSync = DateTimeOffset.UtcNow;
            }
            catch (CredentialRevokedException ex)
            {
                ConsecutiveFailures++;
                LastError = ex.Message;
                return new SyncOutcome(false, up, dup, rej, ex.Message, Revoked: true);
            }
            catch (Exception ex) when (ex is HttpRequestException or InvalidOperationException)
            {
                ConsecutiveFailures++;
                LastError = ex.Message;
                return new SyncOutcome(false, up, dup, rej, ex.Message);
            }
        }
        return new SyncOutcome(true, up, dup, rej, null);
    }

    public async Task HeartbeatAsync(MonitoringStatus status, IReadOnlyDictionary<string, string> permissions, bool startupEnabled, int queued,
        string agentVersion, string osVersion, CancellationToken ct = default)
    {
        var body = new Dictionary<string, object?>
        {
            ["monitoring_status"] = status.ToString().ToLowerInvariant(),
            ["permissions"] = permissions,
            ["startup_enabled"] = startupEnabled,
            ["agent_version"] = agentVersion,
            ["os_version"] = osVersion,
            ["queued_events"] = queued,
            ["consecutive_upload_failures"] = ConsecutiveFailures,
        };
        if (LastError is not null) body["last_error"] = LastError.Length > 300 ? LastError[..300] : LastError;
        try
        {
            using var res = await _http.SendAsync(Authed(HttpMethod.Post, "v1/devices/self/heartbeat", body), ct);
            if (res.StatusCode == HttpStatusCode.Unauthorized) throw new CredentialRevokedException();
        }
        catch (HttpRequestException) { /* reflected in the next heartbeat */ }
    }
}
