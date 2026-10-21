# API reference (v1)

Base URL: `https://<api-host>/v1`. Interactive OpenAPI UI at `/docs`, JSON at `/docs/openapi.json`
(lists every route; request bodies are documented here because validation uses Zod).

**Authentication**
* **User**: `tv_session` httpOnly cookie (browsers; writes also need header `x-tracevault-csrf: 1`) or
  `Authorization: Bearer tvs_…` (native clients that log in with `x-tracevault-client: native`).
* **Device**: `Authorization: Device tvd_…`.

**Errors**: `{ statusCode, error, message, details? }`. 400 validation (with `details[]`), 401, 403,
404 (also for records outside your scope), 409, 410 (expired/used link), 413, 429, 500 (with reference id).

**Rate limits** (per client IP, per minute): default 300; login/register/reset 10; forgot-password 5;
device registration 10; event batch 60 per device; heartbeat 30; summaries 20; upload URLs 10.

## Auth — `/v1/auth`
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/register` | `{email, password (≥10), display_name?, account_type: personal\|business}` | Sends verification email |
| POST | `/verify-email` | `{token}` | Single use, 24 h |
| POST | `/verify-email/resend` | — | |
| POST | `/login` | `{email, password}` | → `{mfa_required, expires_at, token?}` |
| POST | `/mfa/verify` | `{code}` | Completes login when MFA is on |
| POST | `/logout` | — | Revokes session |
| GET | `/me` | — | Profile, memberships, `mfa_pending` |
| POST | `/password/forgot` | `{email}` | Always 202 |
| POST | `/password/reset` | `{token, password}` | Revokes all sessions |
| POST | `/password/change` | `{current_password, new_password}` | Revokes other sessions |
| POST | `/mfa/setup` · `/mfa/enable` · `/mfa/disable` | `{code}` | TOTP |
| GET | `/sessions` · DELETE `/sessions/:id` · POST `/sessions/revoke-others` | | |

## Devices — `/v1/devices`
| Method | Path | Auth | Body / notes |
|---|---|---|---|
| POST | `/enrollment-codes` | user (verified) | `{organization_id?}` → `{code, expires_at}` (15 min) |
| POST | `/register` | public | `{enrollment_code, name, platform, os_version?, agent_version?}` → `{device_id, device_secret}` |
| GET | `/self` | device | |
| POST | `/self/heartbeat` | device | `{monitoring_status, permissions{}, startup_enabled, queued_events, consecutive_upload_failures, last_error?, agent_version?, os_version?}` |
| POST | `/self/rotate-credential` | device | → `{device_secret}`; old one expires in 5 min |
| GET | `/` | user | `?status=active\|revoked&organization_id=` |
| GET | `/:id` · PATCH `/:id` `{name}` · DELETE `/:id` | user | Delete removes history |
| POST | `/:id/revoke` · `/:id/report-lost` | user | |
| GET | `/:id/recovery` | user | Last sync/state, recent events, open alerts, official links |

## Events — `/v1/events`
| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/batch` | device | `{events: Event[1..500]}` → `{accepted, duplicates, rejected[{index,event_id,reason}], received_at}` |
| GET | `/` | user | `from, to, device_id, organization_id, event_type (comma list), min_severity, source, q, limit ≤200, cursor` |
| GET | `/stats` | user | same filters + `bucket=hour\|day` |
| GET | `/export` | user | same filters + `format=csv\|json` (≤10,000 rows, audited) |
| GET | `/:id` | user | event + 5 before/after + related alerts |

Event (schema v1): `{event_id: uuid, event_type, occurred_at: ISO-8601 with offset, source, severity, metadata: {snake_case: string≤512|number|boolean|null} (≤20 keys), schema_version: 1}`.
Unknown fields (including `owner_id`/`organization_id`) are rejected.

## Alerts — `/v1/alerts`
GET `/` (`status, severity, device_id, limit, cursor`), GET `/:id`, POST `/:id/resolve` `{status: resolved|dismissed, note?}`.

## Recordings
| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/v1/recordings/upload-url` | device | `{kind, mime_type, size_bytes, sha256_hex, started_at, stopped_at, consent{consenting_party, consent_text, os_permission, indicator_shown, consented_at}}` → signed PUT URL (10 min, single use) |
| PUT | `/v1/storage/upload/:ticket?exp&sig` | signature | Body = file; `Content-Type` must match |
| POST | `/v1/recordings/:id/complete` | device | Server verifies size + SHA-256 |
| GET | `/v1/recordings` | user | |
| POST | `/v1/recordings/:id/download-url` | user | Owner, or org role with `recordings.view` (+MFA); 5 min single use; audited |
| GET | `/v1/storage/download/:ticket?exp&sig` | signature | |
| DELETE | `/v1/recordings/:id` | user | |

## Organizations
POST `/v1/organizations` `{name}` · GET `/v1/organizations` · GET/PATCH `/v1/organizations/:id`
(`member_enrollment_allowed, require_mfa_for_admins, recordings_allowed, name`) · PUT `/:id/retention` ·
GET `/:id/members` · PATCH/DELETE `/:id/members/:userId` · GET/POST `/:id/invitations` `{email, role}` ·
DELETE `/:id/invitations/:invId` · POST `/v1/invitations/accept` `{token}`.

Roles: owner, admin, security_analyst, auditor, member — see `packages/api-contracts/src/index.ts`.

## Other
| Method | Path | Notes |
|---|---|---|
| GET | `/v1/audit-logs` | Own history, or `?organization_id=` with `audit.view`; `action, sensitive, before_id, limit` |
| GET | `/v1/audit-logs/verify?organization_id=` | Hash-chain check |
| POST | `/v1/summaries` | `{question, device_id?, alert_id?, from?, to?}` → grounded statements with event citations |
| GET | `/v1/dashboard?days=` | Overview counts |
| GET/PATCH | `/v1/account` | Profile |
| GET/PUT | `/v1/account/notifications` · `/v1/account/retention` | |
| POST | `/v1/account/export` | JSON download |
| DELETE | `/v1/account` | `{password, confirm: "DELETE"}` |
| GET | `/v1/billing` · POST `/v1/billing/plan` | Plan change only in non-production / self-serve mode; no payment |
| GET | `/v1/health` | DB check |
| GET | `/v1/dev/outbox` | Development only |
