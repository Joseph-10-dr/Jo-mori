import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import type { DeviceEventInput } from '@tracevault/event-schema';

/**
 * Bounded, file-backed offline queue. The file is written atomically with
 * owner-only permissions. When full, the oldest events are dropped and counted
 * so the loss is reported to the server instead of happening silently.
 * Events that never reach the cloud are lost if the device is destroyed.
 */
export class OfflineQueue {
  private events: DeviceEventInput[] = [];
  dropped = 0;

  constructor(
    private readonly file: string,
    readonly capacity = 5000,
  ) {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { events: DeviceEventInput[]; dropped: number };
      this.events = parsed.events ?? [];
      this.dropped = parsed.dropped ?? 0;
    }
  }

  get size() {
    return this.events.length;
  }

  push(...events: DeviceEventInput[]) {
    this.events.push(...events);
    const overflow = this.events.length - this.capacity;
    if (overflow > 0) {
      this.events.splice(0, overflow);
      this.dropped += overflow;
    }
    this.persist();
  }

  peek(n: number): DeviceEventInput[] {
    return this.events.slice(0, n);
  }

  /** Remove events the server has acknowledged (accepted, duplicate, or permanently rejected). */
  ack(ids: Set<string>) {
    this.events = this.events.filter((e) => !ids.has(e.event_id));
    this.persist();
  }

  private persist() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ events: this.events, dropped: this.dropped }), { mode: 0o600 });
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
  }
}
