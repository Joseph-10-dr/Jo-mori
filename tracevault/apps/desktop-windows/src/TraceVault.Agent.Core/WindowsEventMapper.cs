using System.Security.Cryptography;
using System.Text;

namespace TraceVault.Agent.Core;

/// <summary>
/// Maps documented Windows event-log IDs to TraceVault event types, keeping only
/// minimal metadata (account names, logon type, group/setting names). It never
/// copies IP addresses, process command lines, or any credential material.
/// </summary>
public static class WindowsEventMapper
{
    public const string SecurityLog = "Security";
    public const string SystemLog = "System";
    public const string DefenderLog = "Microsoft-Windows-Windows Defender/Operational";
    public const string FirewallLog = "Microsoft-Windows-Windows Firewall With Advanced Security/Firewall";

    /// <summary>Event IDs subscribed per log. Used to build the XPath query.</summary>
    public static readonly IReadOnlyDictionary<string, int[]> Subscriptions = new Dictionary<string, int[]>
    {
        // 4624 logon, 4625 failed logon, 4634/4647 logoff, 4800/4801 lock/unlock,
        // 4720/4726 account created/deleted, 4732 added to local group, 4719 audit policy changed
        [SecurityLog] = new[] { 4624, 4625, 4634, 4647, 4800, 4801, 4720, 4726, 4732, 4719 },
        // 6005/6006 event log service started/stopped = startup/clean shutdown, 6008 unexpected shutdown
        [SystemLog] = new[] { 6005, 6006, 6008 },
        // 5001 real-time protection disabled, 5000 enabled
        [DefenderLog] = new[] { 5000, 5001 },
        // 2003 firewall profile setting changed
        [FirewallLog] = new[] { 2003 },
    };

    // Interactive (2), unlock (7), remote interactive (10), cached interactive (11).
    // Service and network logons (3, 5) are noise for this product and are skipped.
    private static readonly HashSet<string> HumanLogonTypes = new() { "2", "7", "10", "11" };
    private const string AdministratorsSid = "S-1-5-32-544";

    /// <summary>
    /// Stable event id derived from machine + log + record number, so re-reading
    /// the same log record after a restart produces the same id and the server
    /// deduplicates it.
    /// </summary>
    public static string StableEventId(string machineKey, string logName, long recordId)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes($"{machineKey}|{logName}|{recordId}"));
        var b = hash.AsSpan(0, 16).ToArray();
        b[6] = (byte)((b[6] & 0x0F) | 0x50); // version 5-style marker
        b[8] = (byte)((b[8] & 0x3F) | 0x80); // RFC 4122 variant
        var hex = Convert.ToHexString(b).ToLowerInvariant();
        return $"{hex[..8]}-{hex[8..12]}-{hex[12..16]}-{hex[16..20]}-{hex[20..]}";
    }

    public static DeviceEvent? Map(RawLogRecord r, string machineKey)
    {
        string Get(string key) => r.Data.TryGetValue(key, out var v) ? v : "";
        (string type, string severity, Dictionary<string, object?> meta)? mapped = (r.LogName, r.EventId) switch
        {
            (SecurityLog, 4624) when HumanLogonTypes.Contains(Get("LogonType")) && !IsMachineAccount(Get("TargetUserName")) =>
                ("user_login", "info", new() { ["account_name"] = Get("TargetUserName"), ["logon_type"] = LogonTypeName(Get("LogonType")) }),
            (SecurityLog, 4625) =>
                ("login_failed", "low", new() { ["account_name"] = Get("TargetUserName"), ["logon_type"] = LogonTypeName(Get("LogonType")), ["failure_status"] = Get("Status") }),
            (SecurityLog, 4634 or 4647) when !IsMachineAccount(Get("TargetUserName")) && (r.EventId == 4647 || HumanLogonTypes.Contains(Get("LogonType"))) =>
                ("user_logout", "info", new() { ["account_name"] = Get("TargetUserName") }),
            (SecurityLog, 4800) => ("screen_locked", "info", new() { ["account_name"] = Get("TargetUserName") }),
            (SecurityLog, 4801) => ("screen_unlocked", "info", new() { ["account_name"] = Get("TargetUserName") }),
            (SecurityLog, 4720) =>
                ("local_account_created", "high", new() { ["account_name"] = Get("TargetUserName"), ["created_by"] = Get("SubjectUserName") }),
            (SecurityLog, 4726) =>
                ("local_account_deleted", "medium", new() { ["account_name"] = Get("TargetUserName"), ["deleted_by"] = Get("SubjectUserName") }),
            (SecurityLog, 4732) when Get("TargetSid") == AdministratorsSid =>
                ("privilege_granted", "high", new() { ["group"] = "Administrators", ["member_sid"] = Get("MemberSid"), ["granted_by"] = Get("SubjectUserName") }),
            (SecurityLog, 4719) =>
                ("security_setting_changed", "medium", new() { ["setting"] = "audit_policy", ["subcategory"] = Get("SubcategoryGuid"), ["changed_by"] = Get("SubjectUserName") }),
            (SystemLog, 6005) => ("device_startup", "info", new()),
            (SystemLog, 6006) => ("device_shutdown", "info", new() { ["clean"] = true }),
            (SystemLog, 6008) => ("device_shutdown", "low", new() { ["clean"] = false }),
            (DefenderLog, 5001) => ("security_setting_changed", "high", new() { ["setting"] = "defender_real_time_protection", ["new_value"] = false }),
            (DefenderLog, 5000) => ("security_setting_changed", "info", new() { ["setting"] = "defender_real_time_protection", ["new_value"] = true }),
            (FirewallLog, 2003) => ("security_setting_changed", "medium", new() { ["setting"] = "firewall_profile", ["profile"] = Get("Profiles"), ["new_value"] = Get("SettingValueString") }),
            _ => null,
        };
        if (mapped is null) return null;
        var (type, sev, metadata) = mapped.Value;
        metadata["windows_event_id"] = r.EventId;
        // Drop empty values and cap lengths to the schema's limits.
        var clean = metadata
            .Where(kv => kv.Value is not null && !(kv.Value is string s && s.Length == 0))
            .ToDictionary(kv => kv.Key, kv => kv.Value is string s ? (object?)(s.Length > 512 ? s[..512] : s) : kv.Value);
        return new DeviceEvent(StableEventId(machineKey, r.LogName, r.RecordId), type, r.TimeCreated.ToUniversalTime().ToString("O"), "windows", sev, clean);
    }

    private static bool IsMachineAccount(string name) =>
        name.EndsWith('$') || name is "SYSTEM" or "LOCAL SERVICE" or "NETWORK SERVICE" or "ANONYMOUS LOGON" or "" || name.StartsWith("DWM-") || name.StartsWith("UMFD-");

    private static string LogonTypeName(string t) => t switch
    {
        "2" => "interactive",
        "3" => "network",
        "7" => "unlock",
        "10" => "remote_interactive",
        "11" => "cached_interactive",
        _ => $"type_{t}",
    };

    public static string XPathFor(string logName) =>
        "*[System[(" + string.Join(" or ", Subscriptions[logName].Select(id => $"EventID={id}")) + ")]]";
}
