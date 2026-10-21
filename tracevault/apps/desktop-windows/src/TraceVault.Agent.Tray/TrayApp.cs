using System.Diagnostics;
using TraceVault.Agent.Core;
using TraceVault.Agent.Windows;

namespace TraceVault.Agent.Tray;

/// <summary>
/// Always-visible notification-area icon. Shows status, lets the person at the
/// PC pause/resume monitoring, sync now, toggle "Start with Windows", open the
/// dashboard, or quit. There is no hidden mode.
/// </summary>
internal sealed class TrayApp : ApplicationContext
{
    private readonly NotifyIcon _icon;
    private readonly StateStore _store = AgentFactory.Store();
    private readonly AgentService _agent;
    private readonly ToolStripMenuItem _status = new("Starting…") { Enabled = false };
    private readonly ToolStripMenuItem _pause = new("Pause monitoring");
    private readonly ToolStripMenuItem _startup = new("Start with Windows") { CheckOnClick = true };
    private readonly System.Windows.Forms.Timer _timer = new() { Interval = 60_000 };
    private bool _busy;

    public TrayApp()
    {
        var state = _store.Load();
        _agent = AgentFactory.Create(state, _store);
        _startup.Checked = StartupRegistration.IsEnabled();
        _pause.Click += (_, _) => { var s = _store.Load(); _agent.SetPaused(!s.Paused); _ = Cycle(); };
        _startup.Click += (_, _) =>
        {
            StartupRegistration.Set(_startup.Checked, $"\"{Application.ExecutablePath}\"");
            var s = _store.Load();
            s.StartupEnabled = _startup.Checked;
            _store.Save(s);
        };
        var menu = new ContextMenuStrip();
        menu.Items.AddRange(new ToolStripItem[]
        {
            _status,
            new ToolStripSeparator(),
            new ToolStripMenuItem("Sync now", null, (_, _) => _ = Cycle()),
            _pause,
            _startup,
            new ToolStripMenuItem("Open dashboard", null, (_, _) => OpenDashboard(state.ApiUrl)),
            new ToolStripSeparator(),
            new ToolStripMenuItem("Quit TraceVault", null, (_, _) => Quit()),
        });
        _icon = new NotifyIcon { Icon = SystemIcons.Shield, Text = "TraceVault", Visible = true, ContextMenuStrip = menu };
        _agent.RecordLifecycle("agent_started", "user_requested");
        _timer.Tick += (_, _) => _ = Cycle();
        _timer.Start();
        _ = Cycle();
    }

    private async Task Cycle()
    {
        if (_busy) return;
        _busy = true;
        try
        {
            var r = await _agent.RunCycleAsync();
            var paused = _store.Load().Paused;
            _pause.Text = paused ? "Resume monitoring" : "Pause monitoring";
            var text = r.Status switch
            {
                MonitoringStatus.Active => r.Sync?.Ok == true ? "Monitoring on — synced" : $"Monitoring on — upload failing ({_agent.Queue.Count} queued)",
                MonitoringStatus.Paused => "Monitoring paused",
                MonitoringStatus.Unavailable => "Can't read the Security log — run as administrator or join Event Log Readers",
                _ => "Device revoked in the dashboard",
            };
            _status.Text = text;
            _icon.Text = ("TraceVault: " + text)[..Math.Min(63, ("TraceVault: " + text).Length)];
            if (r.Status == MonitoringStatus.Disabled) _timer.Stop();
        }
        finally { _busy = false; }
    }

    private static void OpenDashboard(string apiUrl)
    {
        var web = Environment.GetEnvironmentVariable("TRACEVAULT_WEB") ?? apiUrl.Replace(":4000", ":3000");
        Process.Start(new ProcessStartInfo(web + "/dashboard") { UseShellExecute = true });
    }

    private void Quit()
    {
        _timer.Stop();
        _agent.RecordLifecycle("agent_stopped", "user_requested");
        _agent.RunCycleAsync().GetAwaiter().GetResult();
        _icon.Visible = false;
        ExitThread();
    }
}

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        if (AgentFactory.Store().Load().DeviceId is null)
        {
            MessageBox.Show("This PC isn't enrolled yet. Run `tracevault-agent enroll --code <code>` with a code from the TraceVault dashboard.", "TraceVault");
            return;
        }
        Application.Run(new TrayApp());
    }
}
