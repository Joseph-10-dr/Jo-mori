# Privacy policy (draft)

> Draft for the MVP. Have it reviewed by a lawyer for each market (e.g. Nigeria's NDPA 2023, EU/UK
> GDPR) before public launch. Replace bracketed items.

**Controller:** [Company name, address, contact email].

## What TraceVault is
A security history service. You install a visible agent on devices you own or are authorized to
manage; it uploads security-related events so you can review them later and receive alerts.

## What we collect
| Data | Why | Source |
|---|---|---|
| Account: email, name (optional), password hash, MFA status | Sign-in and account security | You |
| Session data: browser user-agent, IP address, times | Detect suspicious sign-ins, let you sign out sessions | Your browser |
| Device details: name, platform, OS version, agent version, last-seen time, permission status | Show device health | The agent |
| Activity events: event type, time, and limited metadata (account names, app names, setting names, watched file paths) | The core service | The agent |
| Recordings (optional): screen/audio files you explicitly start, with consent records | Evidence you chose to capture | The device user |
| Audit log: actions taken in your account | Security and accountability | The service |
| Usage counts: events and storage used | Plan limits and pricing | The service |

## What we never collect
Passwords typed on devices, keystrokes, message or email contents, browsing contents, clipboard
contents, or recordings that were not started by someone at the device. The agent cannot run hidden.

## Monitoring other people
Only enroll devices you own, or that you manage with the users' knowledge (for example a company
laptop policy). Organizations can see only devices enrolled into the organization, never members'
personal devices. Organization recordings are disabled until the owner enables them and must be
started by the device user. You are responsible for giving any legally required notice.

## AI summaries
Summaries are generated on TraceVault's servers from your records using rule-based logic. No data
is sent to third-party AI providers. If that changes, we will ask for your consent first.

## Retention
You choose retention within your plan's limits (see `data-retention.md`). Deleted data is removed
from the live database immediately and from backups within [35] days.

## Your rights
Export all your data (Settings → Data & retention → Export), correct your profile, delete your
account, and contact us at [privacy email]. You can complain to your data-protection authority.

## Processors
Hosting: [e.g. Render/Vercel], database: [e.g. Supabase], email: [Resend], storage: [provider].
Data may be processed in [regions].

## Security
TLS in transit, encryption at rest, hashed credentials, audited access to sensitive data. No
system is completely secure; we notify affected users of breaches as required by law.
