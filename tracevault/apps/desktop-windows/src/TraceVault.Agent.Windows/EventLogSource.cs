using System.Diagnostics.Eventing.Reader;
using System.Runtime.Versioning;
using TraceVault.Agent.Core;

namespace TraceVault.Agent.Windows;

/// <summary>
/// Reads subscribed event IDs with the documented EventLogReader API.
/// Reading the Security log requires membership of "Event Log Readers" or
/// running elevated; without it the agent reports the permission as denied
/// and monitoring as unavailable rather than failing silently.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class EventLogSource : IEventSource
{
    public long? LatestRecordId(string logName)
    {
        try
        {
            var q = new EventLogQuery(logName, PathType.LogName) { ReverseDirection = true };
            using var reader = new EventLogReader(q);
            using var rec = reader.ReadEvent();
            return rec?.RecordId;
        }
        catch (UnauthorizedAccessException) { throw new LogUnavailableException($"{logName}: access denied", denied: true); }
        catch (EventLogNotFoundException) { throw new LogUnavailableException($"{logName}: not present", denied: false); }
    }

    public IEnumerable<RawLogRecord> ReadAfter(string logName, long afterRecordId, int max)
    {
        var xpath = WindowsEventMapper.XPathFor(logName).Replace("]]", $" and EventRecordID>{afterRecordId}]]");
        var results = new List<RawLogRecord>();
        try
        {
            using var reader = new EventLogReader(new EventLogQuery(logName, PathType.LogName, xpath));
            for (var rec = reader.ReadEvent(); rec is not null && results.Count < max; rec = reader.ReadEvent())
            {
                using (rec)
                {
                    if (rec.RecordId is not long id || rec.TimeCreated is not DateTime created) continue;
                    results.Add(new RawLogRecord(logName, rec.Id, id, new DateTimeOffset(created.ToUniversalTime(), TimeSpan.Zero), rec.ProviderName, NamedData(rec)));
                }
            }
        }
        catch (UnauthorizedAccessException) { throw new LogUnavailableException($"{logName}: access denied", denied: true); }
        catch (EventLogNotFoundException) { throw new LogUnavailableException($"{logName}: not present", denied: false); }
        return results;
    }

    /// <summary>Extracts EventData name/value pairs from the record XML (only the names the mapper uses are kept later).</summary>
    private static Dictionary<string, string> NamedData(EventRecord rec)
    {
        var data = new Dictionary<string, string>();
        var xml = System.Xml.Linq.XDocument.Parse(rec.ToXml());
        foreach (var el in xml.Descendants().Where(e => e.Name.LocalName == "Data"))
        {
            var name = el.Attribute("Name")?.Value;
            if (!string.IsNullOrEmpty(name)) data[name] = el.Value;
        }
        return data;
    }
}
