using System.Runtime.Versioning;
using System.Security.Cryptography;
using Microsoft.Win32;
using TraceVault.Agent.Core;

namespace TraceVault.Agent.Windows;

/// <summary>DPAPI, scoped to the current Windows user, protects the device secret and the offline queue at rest.</summary>
[SupportedOSPlatform("windows")]
public sealed class DpapiProtector : IDataProtector
{
    private static readonly byte[] Entropy = "TraceVault.Agent.v1"u8.ToArray();
    public byte[] Protect(byte[] plaintext) => ProtectedData.Protect(plaintext, Entropy, DataProtectionScope.CurrentUser);
    public byte[] Unprotect(byte[] ciphertext) => ProtectedData.Unprotect(ciphertext, Entropy, DataProtectionScope.CurrentUser);
}

/// <summary>
/// "Start with Windows" via the per-user Run key. Only changed when the user
/// explicitly turns it on or off; never enabled by default, never hidden.
/// </summary>
[SupportedOSPlatform("windows")]
public static class StartupRegistration
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "TraceVault";

    public static bool IsEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey);
        return key?.GetValue(ValueName) is string;
    }

    public static void Set(bool enabled, string command)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey, writable: true);
        if (enabled) key.SetValue(ValueName, command);
        else key.DeleteValue(ValueName, throwOnMissingValue: false);
    }
}

[SupportedOSPlatform("windows")]
public static class AgentFactory
{
    public static string DataDir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TraceVault");
    public static StateStore Store() => new(Path.Combine(DataDir, "state.json"), new DpapiProtector());

    public static AgentService Create(AgentState state, StateStore store)
    {
        var http = new HttpClient { BaseAddress = new Uri(state.ApiUrl.TrimEnd('/') + "/"), Timeout = TimeSpan.FromSeconds(30) };
        var secret = state.DeviceSecretProtected is null ? null : store.UnprotectSecret(state.DeviceSecretProtected);
        var queue = new OfflineQueue(Path.Combine(DataDir, "queue.bin"), new DpapiProtector());
        return new AgentService(new EventLogSource(), store, queue, new ApiClient(http, secret), Environment.OSVersion.VersionString);
    }
}
