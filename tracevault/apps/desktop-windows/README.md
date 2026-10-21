# TraceVault Windows agent (preview)

A visible agent that reads security-relevant entries from the Windows event logs and uploads
them to TraceVault. It never logs keystrokes, reads app contents, hides itself, or bypasses
Windows permissions.

| Project | What it is | Built/tested where |
|---|---|---|
| `src/TraceVault.Agent.Core` | Event mapping, encrypted offline queue, uploader with retry/backoff, agent cycle | Any OS (`dotnet test`) |
| `src/TraceVault.Agent.Windows` | `tracevault-agent.exe` console agent: EventLogReader collector, DPAPI, opt-in startup | Compiles on any OS; **runs on Windows only** |
| `src/TraceVault.Agent.Tray` | Notification-area app (status, pause/resume, sync now, start-with-Windows, quit) | Requires the Windows Desktop SDK — built by the `windows-agent` CI job on `windows-latest` only |
| `tests/TraceVault.Agent.Tests` | 16 xUnit tests with a fake event log and fake API | Any OS |

## Events collected

| Log | Event ID | TraceVault event |
|---|---|---|
| Security | 4624 (logon types 2, 7, 10, 11 only) | `user_login` |
| Security | 4625 | `login_failed` |
| Security | 4634 / 4647 | `user_logout` |
| Security | 4800 / 4801 | `screen_locked` / `screen_unlocked` |
| Security | 4720 / 4726 | `local_account_created` / `local_account_deleted` |
| Security | 4732 (Administrators group only) | `privilege_granted` |
| Security | 4719 | `security_setting_changed` (audit policy) |
| System | 6005 / 6006 / 6008 | `device_startup` / `device_shutdown` |
| Defender Operational | 5000 / 5001 | `security_setting_changed` (real-time protection on/off) |
| Firewall | 2003 | `security_setting_changed` (firewall profile) |

Metadata is limited to account names, logon type, group and setting names. IP addresses,
process paths and command lines are deliberately not copied.

Event IDs are derived from (machine key, log, record number), so re-reading a record after a
crash produces the same ID and the server deduplicates it.

## Requirements and permissions

* Windows 10/11, .NET 8 runtime.
* Reading the **Security** log needs administrator rights or membership of the local
  **Event Log Readers** group (`net localgroup "Event Log Readers" <user> /add`). Without it the
  agent keeps running, reports `security_log: denied`, and the dashboard shows monitoring as
  unavailable.
* Lock/unlock events (4800/4801) and account-management events require the matching audit
  policies ("Audit Other Logon/Logoff Events", "Audit User Account Management") to be enabled.

## Build and run

```powershell
cd apps/desktop-windows
dotnet test tests/TraceVault.Agent.Tests
dotnet publish src/TraceVault.Agent.Windows -c Release -r win-x64 --self-contained false -o out
dotnet publish src/TraceVault.Agent.Tray -c Release -r win-x64 --self-contained false -o out   # Windows only

out\tracevault-agent.exe enroll --code ABCDE-FGHIJ --name "My laptop" --api https://api.your-domain
out\tracevault-agent.exe run          # or start out\TraceVault.exe for the tray icon
out\tracevault-agent.exe status
out\tracevault-agent.exe pause        # recorded as an event; the dashboard shows "paused"
out\tracevault-agent.exe startup on   # opt-in, per user, via HKCU\...\Run
```

Data lives in `%LOCALAPPDATA%\TraceVault`: `state.json` (device secret encrypted with DPAPI for
the current Windows user) and `queue.bin` (DPAPI-encrypted offline queue, capped at 20,000
events; overflow is counted and reported).

## Status

* Implemented and unit-tested on Linux: mapping, queue, uploader, pause/resume, revocation,
  offline recovery, deduplication.
* Compiled but **not yet run on a real Windows machine** in this repository's development
  environment: `EventLogSource`, DPAPI, registry startup, and the tray app. Before release:
  run on Windows 10 and 11, verify each event ID with real logs, sign the binaries, and build an
  MSI/MSIX installer.
* Screen recording (Windows.Graphics.Capture with the system capture border) is not
  implemented yet; the API's recording pipeline is ready for it.
