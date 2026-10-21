using System.Text.Json.Serialization;

namespace TraceVault.Agent.Core;

/// <summary>Matches packages/event-schema (schema_version 1). Owner/org are never sent; the server resolves them.</summary>
public sealed record DeviceEvent(
    [property: JsonPropertyName("event_id")] string EventId,
    [property: JsonPropertyName("event_type")] string EventType,
    [property: JsonPropertyName("occurred_at")] string OccurredAt,
    [property: JsonPropertyName("source")] string Source,
    [property: JsonPropertyName("severity")] string Severity,
    [property: JsonPropertyName("metadata")] Dictionary<string, object?> Metadata,
    [property: JsonPropertyName("schema_version")] int SchemaVersion = 1);

/// <summary>A Windows event-log record reduced to the fields the mapper needs.</summary>
public sealed record RawLogRecord(
    string LogName,
    int EventId,
    long RecordId,
    DateTimeOffset TimeCreated,
    string? ProviderName,
    IReadOnlyDictionary<string, string> Data);

public sealed record BatchRejection(
    [property: JsonPropertyName("index")] int Index,
    [property: JsonPropertyName("event_id")] string? EventId,
    [property: JsonPropertyName("reason")] string Reason);

public sealed record BatchResult(
    [property: JsonPropertyName("accepted")] int Accepted,
    [property: JsonPropertyName("duplicates")] int Duplicates,
    [property: JsonPropertyName("rejected")] List<BatchRejection> Rejected);

public sealed record Registration(
    [property: JsonPropertyName("device_id")] string DeviceId,
    [property: JsonPropertyName("device_secret")] string DeviceSecret);

public enum MonitoringStatus { Active, Paused, Unavailable, Disabled }
