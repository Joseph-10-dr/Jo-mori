import { randomUUID } from 'crypto';
import { SCHEMA_VERSION, type DeviceEventInput, type EventType, type Severity } from '@tracevault/event-schema';

function ev(type: EventType, at: Date, metadata: Record<string, string | number | boolean> = {}, severity: Severity = 'info'): DeviceEventInput {
  return {
    event_id: randomUUID(),
    event_type: type,
    occurred_at: at.toISOString(),
    source: 'simulator',
    severity,
    // Every simulated event says so in its metadata as well as its source.
    metadata: { demo: true, ...metadata },
    schema_version: SCHEMA_VERSION,
  };
}

/**
 * "Lent laptop" story: the owner signs in, locks the screen and hands the
 * laptop over; the borrower signs in with a guest account, makes several
 * failed attempts on the owner account, creates a local account and turns off
 * the firewall. All events are demonstration data.
 */
export function lentLaptop(end = new Date()): DeviceEventInput[] {
  const t = (minAgo: number) => new Date(end.getTime() - minAgo * 60_000);
  return [
    ev('device_startup', t(180), { boot_reason: 'power_on' }),
    ev('agent_started', t(179), { agent_version: 'sim-0.1.0' }),
    ev('user_login', t(178), { account_name: 'owner', logon_type: 'interactive' }),
    ev('application_started', t(170), { application: 'Mail' }),
    ev('screen_locked', t(150), { account_name: 'owner' }),
    ev('user_login', t(120), { account_name: 'guest', logon_type: 'interactive' }),
    ev('application_started', t(118), { application: 'Web browser' }),
    ev('usb_device_connected', t(110), { device_class: 'mass_storage', vendor: 'Generic' }, 'low'),
    ...[0, 1, 2, 3, 4].map((i) => ev('login_failed', t(100 - i), { account_name: 'owner', failure_reason: 'bad_password' }, 'low')),
    ev('local_account_created', t(92), { account_name: 'helpdesk2', created_by: 'guest' }, 'high'),
    ev('privilege_granted', t(91), { account_name: 'helpdesk2', group: 'Administrators' }, 'high'),
    ev('security_setting_changed', t(85), { setting: 'firewall', old_value: true, new_value: false }, 'medium'),
    ev('file_deleted', t(80), { path: 'C:/Users/owner/Documents/notes.txt', watched_folder: 'Documents' }, 'low'),
    ev('user_logout', t(60), { account_name: 'guest' }),
    ev('screen_unlocked', t(30), { account_name: 'owner' }),
  ];
}

export function routine(end = new Date(), hours = 24): DeviceEventInput[] {
  const out: DeviceEventInput[] = [];
  const apps = ['Web browser', 'Mail', 'Spreadsheet', 'Music player', 'Code editor'];
  for (let h = hours; h > 0; h -= 2) {
    const at = new Date(end.getTime() - h * 3600_000);
    out.push(ev('screen_unlocked', at, { account_name: 'owner' }));
    out.push(ev('application_started', new Date(at.getTime() + 60_000), { application: apps[h % apps.length] }));
    out.push(ev('screen_locked', new Date(at.getTime() + 50 * 60_000), { account_name: 'owner' }));
  }
  return out;
}
