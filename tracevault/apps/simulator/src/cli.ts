import { validateEvents } from '@tracevault/event-schema';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { parseArgs } from 'util';
import { OfflineQueue } from './queue';
import { lentLaptop, routine } from './scenarios';
import { Uploader } from './uploader';

const HELP = `TraceVault event simulator — generates DEMONSTRATION events (labelled "Simulated").

Usage:
  pnpm simulate --code ABCDE-FGHIJ           enroll a simulated device and upload the "lent laptop" story
  pnpm simulate                              reuse the saved device and upload more events
Options:
  --api URL            API base URL (default http://localhost:4000)
  --scenario NAME      lent | routine (default lent)
  --name NAME          device name when enrolling (default "Simulated laptop")
  --offline            queue events without uploading (to test offline sync later)
  --state DIR          where to keep the device credential and queue (default current directory)
`;

const { values } = parseArgs({
  options: {
    code: { type: 'string' },
    api: { type: 'string', default: process.env.TRACEVAULT_API ?? 'http://localhost:4000' },
    scenario: { type: 'string', default: 'lent' },
    name: { type: 'string', default: 'Simulated laptop' },
    offline: { type: 'boolean', default: false },
    state: { type: 'string', default: process.cwd() },
    help: { type: 'boolean', default: false },
  },
});

interface State {
  api: string;
  device_id: string;
  device_secret: string;
}

async function main() {
  if (values.help) return console.info(HELP);
  const stateFile = resolve(values.state!, '.tracevault-sim.json');
  const queue = new OfflineQueue(resolve(values.state!, '.tracevault-queue.json'));
  let state: State | undefined = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : undefined;

  if (values.code) {
    const res = await fetch(`${values.api}/v1/devices/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enrollment_code: values.code, name: values.name, platform: 'simulator', os_version: 'Simulated OS', agent_version: 'sim-0.1.0' }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`enrollment failed: ${body.message ?? res.status}`);
    state = { api: values.api!, device_id: body.device_id, device_secret: body.device_secret };
    writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
    chmodSync(stateFile, 0o600);
    console.info(`Enrolled simulated device ${state.device_id}. Credential saved to ${stateFile} (owner-only permissions).`);
  }
  if (!state) throw new Error('No enrolled device. Create an enrollment code in the dashboard and run with --code.');

  const events = values.scenario === 'routine' ? routine() : lentLaptop();
  const { accepted, rejected } = validateEvents(events);
  if (rejected.length) throw new Error(`generated invalid events: ${JSON.stringify(rejected)}`);
  queue.push(...accepted);
  console.info(`Queued ${accepted.length} simulated events (${queue.size} waiting${queue.dropped ? `, ${queue.dropped} dropped because the queue was full` : ''}).`);
  if (values.offline) return console.info('Offline mode: events stay queued. Run again without --offline to upload them.');

  const uploader = new Uploader({ apiUrl: state.api, deviceSecret: state.device_secret, queue, log: (m) => console.warn(m) });
  const result = await uploader.sync();
  await uploader.heartbeat({ monitoring_status: 'active', permissions: { simulated_events: 'granted' }, agent_version: 'sim-0.1.0', os_version: 'Simulated OS' });
  if (result.ok) console.info(`Uploaded ${result.uploaded} events (${result.duplicates} already stored, ${result.rejected} rejected). Queue now ${queue.size}.`);
  else {
    console.error(`Sync stopped: ${result.message}. ${queue.size} events remain queued and will be retried next run.`);
    process.exitCode = result.reason === 'revoked' ? 3 : 2;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
