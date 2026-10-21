# Development setup

Verified on Ubuntu 24.04 with Node 22.22, pnpm 10.28, PostgreSQL 16.15 and .NET SDK 8.0.

## 1. Prerequisites
* Node.js 22+ and pnpm 10 (`corepack enable`)
* PostgreSQL 16 (local install, or `docker compose -f infrastructure/docker/docker-compose.yml up db`)
* Optional: .NET 8 SDK for the Windows agent tests; Chromium for e2e tests (`pnpm exec playwright install chromium`)

## 2. Database
```bash
sudo -u postgres psql -c "CREATE ROLE tracevault LOGIN PASSWORD 'tracevault' CREATEDB;"
sudo -u postgres psql -c "CREATE DATABASE tracevault OWNER tracevault;"
sudo -u postgres psql -c "CREATE DATABASE tracevault_test OWNER tracevault;"   # for tests
sudo -u postgres psql -c "CREATE DATABASE tracevault_e2e OWNER tracevault;"    # for e2e tests
```

## 3. Install and build shared packages
```bash
cd tracevault
pnpm install
pnpm --filter @tracevault/event-schema build
pnpm --filter @tracevault/api-contracts build
cp .env.example .env    # optional: defaults already match the local setup above
```

## 4. Run
```bash
pnpm dev:api     # builds and starts the API on :4000 (applies migrations, creates var/dev-keys.json)
pnpm dev:web     # dashboard on http://localhost:3000 (proxies /api → :4000)
```
The API reads configuration from environment variables (see `.env.example`); export them or use a
tool such as `dotenv`/`direnv`. Defaults work for local development.

1. Open http://localhost:3000 and create an account.
2. Open http://localhost:3000/dev/outbox and click the verification link (emails are not really sent in development).
3. Devices → Enroll a device → Create enrollment code.
4. In another terminal: `pnpm simulate --code ABCDE-FGHIJ` — uploads the "lent laptop" demo story
   (labelled *Simulated*). Run `pnpm simulate --scenario routine --offline` then `pnpm simulate --scenario routine` to see the offline queue sync.
5. Explore the timeline, alerts, investigate page and device recovery page.

API docs: http://localhost:4000/docs.

## 5. Tests
```bash
pnpm lint && pnpm format:check && pnpm typecheck
pnpm --filter @tracevault/event-schema test        # schema unit tests
pnpm --filter @tracevault/api test                 # unit + integration + security (needs tracevault_test DB)
pnpm test:e2e                                       # Playwright; starts API on :4100 and web on :3100
dotnet test apps/desktop-windows/tests/TraceVault.Agent.Tests
```
Set `TEST_DATABASE_URL` / `E2E_DATABASE_URL` if your database differs. If Chromium is pre-installed
elsewhere, set `PW_CHROMIUM_PATH` to its executable.

## Troubleshooting
* `Nest can't resolve dependencies` when running with `tsx`/esbuild: esbuild does not emit decorator
  metadata. Use `pnpm dev:api`, which compiles with `tsc`.
* 403 "Missing CSRF header" when calling the API from your own scripts with a cookie: send
  `x-tracevault-csrf: 1`, or log in with `x-tracevault-client: native` and use the Bearer token.
