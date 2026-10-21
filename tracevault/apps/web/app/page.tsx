import Link from 'next/link';

const FEATURES = [
  {
    title: 'Searchable security history',
    body: 'See sign-ins, failed attempts, new accounts, security-setting changes and app launches your devices report — searchable from any trusted browser.',
  },
  {
    title: 'Alerts that explain themselves',
    body: 'Each alert shows the recorded evidence, how confident the conclusion is, and what to do next. An app launch is never presented as proof of wrongdoing.',
  },
  {
    title: 'Evidence you chose to capture',
    body: 'Optional screen or audio recordings start only when someone at the device presses Record, with the system permission prompt and a visible indicator.',
  },
  {
    title: 'Help when a device goes missing',
    body: 'Revoke a lost device’s access in one click, review what it uploaded before it disappeared, and follow official recovery steps for your accounts.',
  },
  {
    title: 'Built for teams too',
    body: 'Organizations get roles, enrollment policies, audit logs and retention controls. A business plan never grants access to employees’ personal devices.',
  },
  {
    title: 'Privacy by design',
    body: 'No keystrokes, passwords, message contents or hidden recording. Encrypted in transit and at rest, with configurable retention and full export or deletion.',
  },
];

export default function Landing() {
  return (
    <div className="landing">
      <nav className="landing-nav" aria-label="Site">
        <Link href="/" className="brand" style={{ padding: 0 }}>
          <span className="brand-mark" aria-hidden="true">
            TV
          </span>
          TraceVault
        </Link>
        <div className="tv-row">
          <Link className="tv-btn tv-btn--ghost" href="/help">
            How it works
          </Link>
          <Link className="tv-btn" href="/login">
            Sign in
          </Link>
          <Link className="tv-btn tv-btn--primary" href="/register">
            Create free account
          </Link>
        </div>
      </nav>
      <main id="main">
        <section className="hero">
          <h1>Know what happened on your devices — even when they weren’t in your hands.</h1>
          <p>
            Lent your laptop to a friend, a repair shop or a colleague? TraceVault keeps a secure, searchable record of the security
            activity your devices report, so you can review it later from any trusted device.
          </p>
          <div className="tv-row" style={{ marginTop: 20 }}>
            <Link className="tv-btn tv-btn--primary" href="/register">
              Get started — it’s free
            </Link>
            <Link className="tv-btn" href="/register?type=business">
              Set up for a business
            </Link>
          </div>
        </section>
        <section aria-labelledby="features" className="feature-grid">
          <h2 id="features" className="tv-visually-hidden">
            Features
          </h2>
          {FEATURES.map((f) => (
            <div className="tv-card" key={f.title}>
              <h3>{f.title}</h3>
              <p className="tv-muted" style={{ margin: 0 }}>
                {f.body}
              </p>
            </div>
          ))}
        </section>
        <section className="tv-card" aria-labelledby="limits">
          <h2 id="limits">What TraceVault can and can’t do</h2>
          <div className="tv-grid tv-grid--2">
            <ul className="check-list">
              <li>Records events your operating system exposes to a visible, installed agent.</li>
              <li>Uploads them to the cloud as soon as the device is online.</li>
              <li>Alerts you about events such as new local accounts or disabled protection.</li>
            </ul>
            <ul className="check-list">
              <li>It can’t see inside other apps, websites or messages.</li>
              <li>It can’t record anything before it was installed, or events still queued on a device that was destroyed.</li>
              <li>It can’t locate, lock or wipe devices — it links you to the official services that can.</li>
            </ul>
          </div>
        </section>
      </main>
    </div>
  );
}
