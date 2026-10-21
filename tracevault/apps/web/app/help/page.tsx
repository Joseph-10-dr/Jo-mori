import Link from 'next/link';

export const metadata = { title: 'Help & recovery' };

const PLATFORMS = [
  {
    name: 'Windows',
    status: 'Agent available (preview)',
    can: 'Sign-ins and failed sign-ins, lock/unlock, startup/shutdown, new local accounts, admin-group changes, audit-policy changes — read from the Windows Security and System event logs. Requires running with permission to read the Security log.',
    cannot:
      'Read other apps’ content, browser history or keystrokes. Screen recording is not in this release.',
  },
  {
    name: 'macOS',
    status: 'Planned',
    can: 'Will use the Endpoint Security / unified log where Apple permits, and ScreenCaptureKit for user-started screen recording with the macOS permission prompt.',
    cannot:
      'Cannot record without the Screen Recording permission, and macOS shows its own recording indicator.',
  },
  {
    name: 'Android',
    status: 'Planned',
    can: 'Will report app enrollment, screen lock state where allowed and device-admin events, and support screen recording through the system MediaProjection prompt.',
    cannot:
      'Android does not let apps see other apps’ activity without special access, and limits background work. Every recording session needs the system prompt.',
  },
  {
    name: 'iOS',
    status: 'Planned',
    can: 'Will support enrollment, push alerts and user-started ReplayKit broadcast recording.',
    cannot:
      'iOS does not expose other apps’ activity or a system event log to third-party apps, and background recording is not possible. iOS history will be limited.',
  },
];

export default function HelpPage() {
  return (
    <div className="landing">
      <nav className="landing-nav" aria-label="Site">
        <Link href="/" className="brand" style={{ padding: 0 }}>
          <span className="brand-mark" aria-hidden="true">
            TV
          </span>
          TraceVault
        </Link>
        <Link className="tv-btn" href="/dashboard">
          Go to dashboard
        </Link>
      </nav>
      <main id="main" className="stack">
        <h1>Help & recovery center</h1>

        <section className="tv-card" id="recovery" aria-labelledby="recovery-h">
          <h2 id="recovery-h">If a device is lost, stolen, or wasn’t returned</h2>
          <ol>
            <li>
              In TraceVault, open the device and choose{' '}
              <strong>Report lost &amp; revoke access</strong>. This stops it uploading and keeps
              its history.
            </li>
            <li>
              Review its last sync time, last known state and recent activity on the same page.
            </li>
            <li>
              Use the official lost-device service:{' '}
              <a
                href="https://account.microsoft.com/devices"
                rel="noopener noreferrer"
                target="_blank"
              >
                Microsoft
              </a>
              ,{' '}
              <a href="https://www.icloud.com/find" rel="noopener noreferrer" target="_blank">
                Apple Find My
              </a>
              ,{' '}
              <a
                href="https://www.google.com/android/find"
                rel="noopener noreferrer"
                target="_blank"
              >
                Google Find My Device
              </a>
              . Only these services can locate, lock or erase a device.
            </li>
            <li>
              From a device you trust, change the passwords of accounts used on the lost device,
              starting with your email, and sign out its sessions:{' '}
              <a
                href="https://myaccount.google.com/device-activity"
                rel="noopener noreferrer"
                target="_blank"
              >
                Google
              </a>
              ,{' '}
              <a
                href="https://account.microsoft.com/security"
                rel="noopener noreferrer"
                target="_blank"
              >
                Microsoft
              </a>
              ,{' '}
              <a
                href="https://account.apple.com/account/manage"
                rel="noopener noreferrer"
                target="_blank"
              >
                Apple ID
              </a>
              .
            </li>
            <li>
              Turn on two-step verification everywhere it is offered, and check email forwarding
              rules and recovery details.
            </li>
            <li>
              If you believe a crime occurred, report it to the police; a TraceVault export can help
              document what was recorded.
            </li>
          </ol>
          <p className="tv-muted">
            TraceVault only has history from after a device was enrolled, and only what reached the
            cloud. Events still queued on a device that was destroyed or wiped are lost.
          </p>
        </section>

        <section className="tv-card" id="alerts" aria-labelledby="alerts-h">
          <h2 id="alerts-h">How alerts work</h2>
          <p>
            Alerts come from fixed rules run on every upload. <strong>Observed</strong> means the
            device directly reported the event (for example, a new local account).{' '}
            <strong>Likely</strong> or <strong>Possible</strong> means the alert is an inference
            from a pattern (for example, several failed sign-ins), which can have innocent
            explanations. An alert is never proof that an account was compromised.
          </p>
        </section>

        <section className="tv-card" aria-labelledby="platforms-h">
          <h2 id="platforms-h">What each platform supports</h2>
          <div className="tv-table-wrap">
            <table className="tv-table">
              <thead>
                <tr>
                  <th scope="col">Platform</th>
                  <th scope="col">Status</th>
                  <th scope="col">Can record</th>
                  <th scope="col">Can’t</th>
                </tr>
              </thead>
              <tbody>
                {PLATFORMS.map((p) => (
                  <tr key={p.name}>
                    <th scope="row">{p.name}</th>
                    <td>{p.status}</td>
                    <td>{p.can}</td>
                    <td>{p.cannot}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="tv-card" id="privacy" aria-labelledby="privacy-h">
          <h2 id="privacy-h">Privacy summary</h2>
          <ul className="check-list">
            <li>
              We collect event metadata the operating system exposes (event type, time, app or
              setting names) — never passwords, keystrokes or message contents.
            </li>
            <li>
              The agent is always visible on the device and can be paused or removed by the device’s
              user.
            </li>
            <li>
              Recordings start only when someone at the device presses Record, with a system
              permission prompt and visible indicator.
            </li>
            <li>
              You choose how long data is kept, and can export or delete everything at any time.
            </li>
            <li>
              Organizations can only see devices enrolled into the organization — never members’
              personal devices.
            </li>
            <li>
              The summary assistant runs on TraceVault’s servers using your records only; no data is
              sent to third-party AI providers.
            </li>
          </ul>
          <p>
            The full privacy policy is in <code>docs/privacy-policy.md</code> in the source
            repository.
          </p>
        </section>

        <section className="tv-card" aria-labelledby="acceptable-h">
          <h2 id="acceptable-h">Acceptable use</h2>
          <p>
            Install TraceVault only on devices you own, or that you manage with the user’s knowledge
            (for example company laptops with a written policy). Secretly monitoring another
            person’s device may be illegal where you live.
          </p>
        </section>
      </main>
    </div>
  );
}
