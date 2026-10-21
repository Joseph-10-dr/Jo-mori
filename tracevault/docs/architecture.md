# Architecture

## Overview

```
 Windows agent ─┐                         ┌──────────────────────────┐
 Simulator ─────┼── HTTPS (device cred) ─▶│  API (NestJS, Node 22)   │──▶ PostgreSQL 16
 (future macOS, │                         │  /v1/*  OpenAPI at /docs │      (events, alerts, audit…)
  Android, iOS) ┘                         │                          │──▶ Object storage
                                          │                          │      (encrypted recordings)
 Browser ── HTTPS ─▶ Next.js dashboard ──▶│  same-origin /api proxy  │──▶ Mail provider (Resend)
                     (cookie session)     └──────────────────────────┘
```

| Component | Path | Technology |
|---|---|---|
| Event contract | `packages/event-schema` | Zod schema, shared by API, simulator and tests |
| API contracts | `packages/api-contracts` | Roles → permissions, plan limits, response types |
| Design system | `packages/design-system` | CSS tokens (light/dark) + accessible React primitives |
| API | `apps/api` | NestJS 11, `pg`, Argon2id, otpauth, helmet, throttler |
| Dashboard | `apps/web` | Next.js 15 (App Router), React 19 |
| Simulator | `apps/simulator` | Node CLI producing labelled demo events |
| Windows agent | `apps/desktop-windows` | .NET 8 (Core library, console agent, WinForms tray) |
| Migrations | `infrastructure/database/migrations` | Plain SQL, applied in order at API start |

## Key decisions

* **Built-in authentication instead of a managed identity provider (for now).** No identity-provider
  credentials were available, so the API implements email/password auth with Argon2id (OWASP
  parameters), opaque random session tokens stored only as SHA-256 hashes, email verification,
  password reset, TOTP MFA (secret encrypted with AES-256-GCM), lockout and rate limits. The session
  check is isolated in `common/auth.guard.ts`, so swapping in Supabase Auth/Auth0 later means
  replacing that guard and the `/v1/auth` controller.
* **Raw SQL with `pg`, not an ORM.** Tenant filters are explicit in every query, built from one helper
  (`AccessService.visibleSql`) so the isolation rule lives in one place and is easy to audit.
* **Tenancy model.** A device belongs to an owner user and optionally an organization. Events, alerts
  and recordings copy `owner_user_id`/`organization_id` from the *authenticated device row* at write
  time — never from the payload. Users see their own devices plus devices of organizations where
  their role has `devices.view_all`. Non-visible IDs return 404 (not 403) to avoid probing.
  Row Level Security policies exist as defence in depth for any future direct-database role.
* **Device credentials.** One-time enrollment codes (15 min, hashed) are exchanged for a 256-bit
  random secret (`tvd_…`) shown once and stored server-side as SHA-256. Rotation issues a new secret
  with a 5-minute overlap. Revocation is immediate.
* **Event pipeline.** Batches of ≤500 events / ≤512 KB. Each event is validated individually; invalid
  ones are reported back without failing the batch. `UNIQUE(device_id, event_id)` +
  `ON CONFLICT DO NOTHING` gives idempotent retries. `received_at` is server time; `occurred_at` is
  normalised to UTC and must be within 30 days past / 10 minutes future. Events arriving >5 minutes
  late are flagged `delayed`.
* **Alerts.** Deterministic rules run after the ingest transaction commits. Each alert records evidence
  event IDs and a confidence (`confirmed` = directly observed; `likely`/`possible` = inferred) and
  avoids claiming compromise. Dedupe keys stop duplicate alerts on retried uploads.
* **Summaries.** `SummaryService` follows the prescribed sequence (authenticate → scope → retrieve
  minimal records → structure → generate → validate citations → label gaps → audit). The only provider
  is `DeterministicSummaryProvider`; no data leaves the server. An LLM provider can implement the
  `SummaryProvider` interface; citations it returns are filtered to the authorised record set.
* **Recordings.** Bytes never touch the database. Devices request a single-use upload ticket (10 min,
  HMAC-signed URL) only after plan, quota, duration, MIME, consent and OS-permission checks. The API
  re-hashes the stored object before marking it available. Downloads use 5-minute single-use links
  and are audited as sensitive. `LocalEncryptedStorage` (AES-256-GCM per file) is the current
  backend; an S3/Supabase Storage adapter implementing `ObjectStorage` is the production next step.
* **Audit log.** Append-only (trigger blocks UPDATE/DELETE except the retention job) and hash-chained
  (each row hashes the previous row's hash + canonical JSON). `GET /v1/audit-logs/verify` recomputes
  the chain.
* **Retention.** Hourly job deletes events/recordings older than the scope's policy, expired sessions,
  tokens and dev-outbox mail, and audit rows past the audit retention period.

## Key management

| Key | Purpose | Storage | Rotation |
|---|---|---|---|
| `TV_DATA_KEY` | AES-256-GCM for MFA secrets and local recording files | Managed secret (env) | Planned: key-id prefix + re-encrypt job (not yet implemented) |
| `TV_URL_SIGNING_KEY` | HMAC for storage URLs | Managed secret (env) | Rotate any time; outstanding links (≤10 min) become invalid |
| Device secrets | Device authentication | SHA-256 hash in DB; DPAPI on Windows clients | `POST /v1/devices/self/rotate-credential` |
| Session tokens | User authentication | SHA-256 hash in DB; httpOnly cookie | Expire after `SESSION_TTL_HOURS`; revoked on password change |

In development the two keys are generated into `var/dev-keys.json` (git-ignored, mode 0600).
Production refuses to start without them.

## Platform capability matrix

See `apps/web/app/help/page.tsx` (shown in the dashboard) and each `apps/*/README.md`.
