# TraceVault

Searchable security history for your devices, with transparent, consent-based evidence capture
and help when a device is lost. Built for individuals who lend out laptops and phones, and for
small businesses managing company devices.

> **Design principle:** searchable security history first, authorized evidence capture second,
> account and device recovery third. TraceVault is not spyware: agents are visible, recordings are
> started by the person at the device, and no keystrokes, passwords or message contents are collected.

## Status (MVP, not production-ready)

| Area | Status |
|---|---|
| Cloud API (NestJS + PostgreSQL) | ✅ Implemented and tested (91 automated tests) |
| Web dashboard (Next.js) | ✅ Implemented, all 17 required screens connected to the real API; Playwright e2e passes |
| Event simulator | ✅ Implemented and tested (offline queue, retry, dedupe); events labelled *Simulated* |
| Windows agent (.NET 8) | 🟡 Core logic implemented and unit-tested (16 tests); console agent compiles; **not yet run on a real Windows PC**; tray app builds only on Windows CI |
| macOS app | ⛔ Not started (no Xcode toolchain available) — plan in `apps/desktop-macos/README.md` |
| Android app | ⛔ Not started — plan in `apps/mobile-android/README.md` |
| iOS app | ⛔ Not started — plan in `apps/mobile-ios/README.md` |
| Screen/audio capture on any client | ⛔ Not implemented in clients; API upload/consent/storage pipeline is implemented and tested |
| Email delivery | 🟡 Resend adapter written but **untested** (no API key); development uses an in-database outbox |
| Object storage | 🟡 Local AES-256-GCM encrypted storage works; S3/Supabase adapter not written |
| AI summaries | ✅ Deterministic, grounded summarizer; no external AI provider connected |
| Payments | ⛔ Not integrated by design; plans can be switched in non-production for testing |
| Push notifications | ⛔ Not implemented (needs mobile apps) |
| Deployment | ⛔ Not deployed; Dockerfiles written but not built (registry rate limits) — see `infrastructure/deployment/README.md` |

### MVP definition-of-done checklist
- [x] Repository organized and documented
- [x] Authentication works (register, verify, login, MFA, reset, sessions)
- [x] Users can register and revoke devices
- [x] Event schema is validated
- [x] Events travel from a device/simulator through the API into PostgreSQL
- [x] Events are searchable in the real dashboard
- [x] Users cannot access other users' records (tested)
- [x] Organization boundaries have automated tests
- [x] Failed uploads and offline synchronization are handled (simulator + Windows core)
- [x] Optional capture has explicit permission and visible-indicator requirements (enforced server-side; no client captures yet)
- [x] Recording storage is private and access-controlled
- [x] Retention and deletion workflows exist
- [x] Core automated tests pass
- [x] Local development instructions tested (`docs/development-setup.md`)
- [x] Deployment instructions list all external prerequisites
- [x] README describes the current implementation and limitations

## Quick start
```bash
cd tracevault
pnpm install
pnpm --filter @tracevault/event-schema build && pnpm --filter @tracevault/api-contracts build
# PostgreSQL 16 with a `tracevault` database/user — see docs/development-setup.md
pnpm dev:api        # http://localhost:4000 (API docs at /docs)
pnpm dev:web        # http://localhost:3000
pnpm simulate --code <code from Devices → Enroll>
```

## Repository layout
```
apps/
  api/               NestJS REST API (/v1), migrations applied on start
  web/               Next.js dashboard
  simulator/         Demo-event generator exercising the device pipeline
  desktop-windows/   .NET 8 agent: Core library, console agent, tray app, xUnit tests
  desktop-macos/ mobile-android/ mobile-ios/   status + implementation plans
packages/
  event-schema/      Versioned event contract (Zod) + tests
  api-contracts/     Roles/permissions, plan limits, shared types
  design-system/     Tokens (light/dark) and accessible components
infrastructure/
  database/migrations/  SQL schema (14 required entities + auth support tables, RLS)
  docker/            Dockerfiles + docker-compose for local full stack
  deployment/        Deployment prerequisites and checklist
docs/                architecture, threat model, privacy policy, retention, incident response, API, setup
tests/
  unit/ integration/ security/   Jest suites (run via the API package)
  end-to-end/        Playwright browser tests against the real stack
```

## Tests
| Suite | Count | Command |
|---|---|---|
| Event schema unit tests | 14 | `pnpm --filter @tracevault/event-schema test` |
| API unit + integration + security | 91 | `pnpm --filter @tracevault/api test` |
| Browser end-to-end | 2 flows | `pnpm test:e2e` |
| Windows agent (xUnit) | 16 | `dotnet test apps/desktop-windows/tests/TraceVault.Agent.Tests` |

Covered: registration/login/MFA/reset/lockout, CSRF, device enrollment and plan limits, batch
ingestion, deduplication, malformed and oversized payloads, offline/delayed events, time-zone
normalisation, search/filter/pagination, export with formula-injection defence, alert rules,
revocation and credential rotation, user and organization isolation (IDOR), role permissions, MFA
for admin actions, recording consent/quota/signed-URL expiry and single use/integrity/authorization,
encryption at rest, audit-log immutability and hash chain, retention purge, account export and
deletion, rate limiting, secrets absent from logs, and prompt-injection-safe grounded summaries.

Not yet covered: real Windows event logs, backup restoration, permission revocation on real
devices, and capture on any client (no client captures yet).

## Next steps
1. Run the Windows agent on Windows 10/11, validate every mapped event ID, sign and package it (MSIX).
2. Create Supabase + Resend accounts; add the S3/Supabase Storage adapter; deploy to staging; run the e2e suite against staging.
3. Add Sentry error reporting and a shared rate-limit store; perform a backup-restore drill.
4. Implement Windows screen capture (Windows.Graphics.Capture) using the existing recording pipeline.
5. Start the macOS and Android clients (see their READMEs).

## Documentation
[Architecture](docs/architecture.md) · [Threat model](docs/threat-model.md) ·
[Privacy policy](docs/privacy-policy.md) · [Data retention](docs/data-retention.md) ·
[Incident response](docs/incident-response.md) · [API](docs/api.md) ·
[Development setup](docs/development-setup.md) · [Deployment](infrastructure/deployment/README.md) ·
[Security policy](SECURITY.md)
