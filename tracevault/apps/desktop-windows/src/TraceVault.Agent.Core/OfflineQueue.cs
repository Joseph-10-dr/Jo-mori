using System.Text;
using System.Text.Json;

namespace TraceVault.Agent.Core;

/// <summary>Encrypts data at rest. On Windows this is DPAPI (current user); tests use a pass-through.</summary>
public interface IDataProtector
{
    byte[] Protect(byte[] plaintext);
    byte[] Unprotect(byte[] ciphertext);
}

public sealed class PassThroughProtector : IDataProtector
{
    public byte[] Protect(byte[] plaintext) => plaintext;
    public byte[] Unprotect(byte[] ciphertext) => ciphertext;
}

/// <summary>
/// Bounded, encrypted, file-backed queue of events waiting for upload. When full,
/// the oldest events are dropped and counted (reported in heartbeats) rather
/// than silently lost. Events never uploaded are lost if the device is destroyed.
/// </summary>
public sealed class OfflineQueue
{
    private readonly string _path;
    private readonly IDataProtector _protector;
    private readonly object _lock = new();
    private List<DeviceEvent> _events = new();

    public int Capacity { get; }
    public long Dropped { get; private set; }

    public OfflineQueue(string path, IDataProtector protector, int capacity = 20_000)
    {
        _path = path;
        _protector = protector;
        Capacity = capacity;
        Load();
    }

    public int Count { get { lock (_lock) return _events.Count; } }

    public void Enqueue(IEnumerable<DeviceEvent> events)
    {
        lock (_lock)
        {
            var known = _events.Select(e => e.EventId).ToHashSet();
            _events.AddRange(events.Where(e => known.Add(e.EventId)));
            var overflow = _events.Count - Capacity;
            if (overflow > 0)
            {
                _events.RemoveRange(0, overflow);
                Dropped += overflow;
            }
            Save();
        }
    }

    public IReadOnlyList<DeviceEvent> Peek(int n)
    {
        lock (_lock) return _events.Take(n).ToList();
    }

    public void Ack(IEnumerable<string> eventIds)
    {
        lock (_lock)
        {
            var ids = eventIds.ToHashSet();
            _events = _events.Where(e => !ids.Contains(e.EventId)).ToList();
            Save();
        }
    }

    private sealed record Persisted(List<DeviceEvent> Events, long Dropped);

    private void Load()
    {
        if (!File.Exists(_path)) return;
        try
        {
            var json = Encoding.UTF8.GetString(_protector.Unprotect(File.ReadAllBytes(_path)));
            var p = JsonSerializer.Deserialize<Persisted>(json);
            _events = p?.Events ?? new();
            Dropped = p?.Dropped ?? 0;
        }
        catch (Exception ex) when (ex is JsonException or System.Security.Cryptography.CryptographicException or IOException)
        {
            // A corrupt or foreign queue file must not stop monitoring. Keep it for inspection.
            File.Move(_path, _path + $".corrupt-{DateTime.UtcNow:yyyyMMddHHmmss}", overwrite: true);
            _events = new();
        }
    }

    private void Save()
    {
        var dir = Path.GetDirectoryName(_path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        var bytes = _protector.Protect(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new Persisted(_events, Dropped))));
        var tmp = _path + ".tmp";
        File.WriteAllBytes(tmp, bytes);
        File.Move(tmp, _path, overwrite: true);
    }
}
