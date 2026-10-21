using System.Runtime.Versioning;
using TraceVault.Agent.Core;
using TraceVault.Agent.Windows;

[assembly: SupportedOSPlatform("windows")]

const string Usage = """
TraceVault agent for Windows (visible; records security events this PC reports).

  tracevault-agent enroll --code ABCDE-FGHIJ [--name "My laptop"] [--api https://api.example.com]
  tracevault-agent run                 collect and upload every 60s until Ctrl+C (status printed)
  tracevault-agent status              show enrollment, sync and permission status
  tracevault-agent pause | resume      stop / restart collection (recorded as an event)
  tracevault-agent startup on|off      start with Windows for this user (off by default)
  tracevault-agent unenroll            forget this device's credential and local queue
""";

if (!OperatingSystem.IsWindows())
{
    Console.Error.WriteLine("This agent runs on Windows only. Use the simulator to try TraceVault on other systems.");
    return 1;
}

var cmd = args.FirstOrDefault() ?? "help";
string? Opt(string name) => args.SkipWhile(a => a != name).Skip(1).FirstOrDefault();
var store = AgentFactory.Store();
var state = store.Load();

switch (cmd)
{
    case "enroll":
    {
        var code = Opt("--code") ?? throw new ArgumentException("--code is required");
        state = new AgentState { ApiUrl = Opt("--api") ?? Environment.GetEnvironmentVariable("TRACEVAULT_API") ?? "http://localhost:4000" };
        var http = new HttpClient { BaseAddress = new Uri(state.ApiUrl.TrimEnd('/') + "/") };
        var reg = await new ApiClient(http).RegisterAsync(code, Opt("--name") ?? Environment.MachineName, Environment.OSVersion.VersionString, AgentService.AgentVersion);
        state.DeviceId = reg.DeviceId;
        state.DeviceSecretProtected = store.ProtectSecret(reg.DeviceSecret);
        store.Save(state);
        Console.WriteLine($"Enrolled as device {reg.DeviceId}. The credential is stored encrypted for this Windows user.");
        Console.WriteLine("Run `tracevault-agent run` (or the tray app) to start recording. Nothing before this moment is uploaded.");
        return 0;
    }
    case "run":
    {
        if (state.DeviceId is null) { Console.Error.WriteLine("Not enrolled. Run `tracevault-agent enroll --code ...` first."); return 2; }
        var agent = AgentFactory.Create(state, store);
        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };
        agent.RecordLifecycle("agent_started", "user_requested");
        Console.WriteLine("TraceVault is monitoring this PC. Press Ctrl+C to stop.");
        while (!cts.IsCancellationRequested)
        {
            var r = await agent.RunCycleAsync(cts.Token);
            var sync = r.Sync is null ? "-" : r.Sync.Ok ? $"uploaded {r.Sync.Uploaded}" : $"upload failed: {r.Sync.Error}";
            Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] status={r.Status.ToString().ToLowerInvariant()} collected={r.Collected} queued={agent.Queue.Count} {sync} permissions={string.Join(",", r.Permissions.Select(p => $"{p.Key}:{p.Value}"))}");
            if (r.Sync?.Revoked == true) { Console.Error.WriteLine("This device was revoked from the dashboard. Stopping."); return 3; }
            try { await Task.Delay(TimeSpan.FromSeconds(60), cts.Token); } catch (TaskCanceledException) { }
        }
        agent.RecordLifecycle("agent_stopped", "user_requested");
        await agent.RunCycleAsync();
        return 0;
    }
    case "status":
        Console.WriteLine(state.DeviceId is null ? "Not enrolled." : $"Device {state.DeviceId} → {state.ApiUrl}");
        Console.WriteLine($"Paused: {state.Paused}  Revoked: {state.Revoked}  Start with Windows: {StartupRegistration.IsEnabled()}");
        Console.WriteLine($"Last successful sync: {state.LastSync?.ToLocalTime().ToString() ?? "never"}  Last error: {state.LastError ?? "none"}");
        return 0;
    case "pause":
    case "resume":
        AgentFactory.Create(state, store).SetPaused(cmd == "pause");
        Console.WriteLine(cmd == "pause" ? "Monitoring paused. The dashboard will show this device as paused." : "Monitoring resumed.");
        return 0;
    case "startup":
    {
        var on = Opt("startup") == "on";
        StartupRegistration.Set(on, $"\"{Environment.ProcessPath}\" run");
        state.StartupEnabled = on;
        store.Save(state);
        Console.WriteLine(on ? "TraceVault will start when you sign in to Windows." : "TraceVault will not start automatically.");
        return 0;
    }
    case "unenroll":
        StartupRegistration.Set(false, "");
        Directory.Delete(AgentFactory.DataDir, recursive: true);
        Console.WriteLine("Local credential and queue removed. Revoke the device in the dashboard to stop it appearing there.");
        return 0;
    default:
        Console.WriteLine(Usage);
        return cmd == "help" ? 0 : 1;
}
