# Threat model

Scope: API, dashboard, device agents, database and object storage. Method: STRIDE per asset, with
OWASP ASVS 4.0 as the verification reference. "Test" lists the automated test that covers the control.

## Assets
Activity events (sensitive metadata about a person's device use), recordings (highly sensitive),
credentials (passwords, sessions, device secrets, MFA secrets), audit log, organization membership.

## Threats and controls

| # | Threat | Control | Test |
|---|---|---|---|
| T1 | User reads another user's events by changing an ID (IDOR) | All reads filtered by `AccessService` scope; out-of-scope IDs → 404 | `tests/security/isolation.test.ts` |
| T2 | Org A admin reads org B data | Membership + role checks per org; RLS policies as defence in depth | `isolation.test.ts` (organization isolation) |
| T3 | Org admin reads an employee's personal devices | Personal devices have `organization_id NULL`; org roles only see org devices | `isolation.test.ts` |
| T4 | Device spoofs owner/org in payload | Strict schema rejects unknown keys; ownership copied from device row | `events.test.ts`, `isolation.test.ts` |
| T5 | Stolen/revoked device keeps uploading | Revocation flips status + revokes all credentials; checked on every request | `events.test.ts` (revocation) |
| T6 | Credential stuffing / brute force | Argon2id, constant-time unknown-user path, lockout after 10 failures, per-IP rate limits, MFA | `auth.test.ts`, `privacy-and-logging.test.ts` (rate limiting) |
| T7 | CSRF on cookie-authenticated writes | `SameSite=Lax` cookie + mandatory custom header (`x-tracevault-csrf`) + CORS allow-list | `auth.test.ts` |
| T8 | Session theft via XSS | httpOnly cookie; token never returned to browsers; React escaping; CSP; no `dangerouslySetInnerHTML` | `auth.test.ts` |
| T9 | Malicious metadata (oversized, nested, control chars, credentials) | Zod: flat primitives, ≤20 keys, ≤512 chars, forbidden key fragments, control chars stripped; body limit 512 KB | `packages/event-schema/test`, `events.test.ts` |
| T10 | CSV/spreadsheet formula injection in exports | Cells starting `= + - @` are prefixed with `'` | `events.test.ts` |
| T11 | Prompt injection via metadata into AI summaries | Metadata quoted as data; deterministic provider; citations validated against authorised set | `privacy-and-logging.test.ts` |
| T12 | Recording URL reuse / tampering / expiry bypass | HMAC over (ticket, purpose, expiry); single-use DB ticket; 10/5-minute expiry | `tests/security/recordings.test.ts` |
| T13 | Upload of wrong/oversized/malicious file | MIME allow-list, declared size cap during streaming, SHA-256 verified before availability | `recordings.test.ts` |
| T14 | Covert recording | Requires plan, org opt-in, consent record with OS permission granted and visible indicator; no remote start endpoint exists | `recordings.test.ts` |
| T15 | Secrets leak into logs | Request logger writes method/path/status only; bodies, headers, query strings never logged | `privacy-and-logging.test.ts` |
| T16 | Audit tampering | Append-only trigger + hash chain + verify endpoint | `privacy-and-logging.test.ts` |
| T17 | Lost device exposes data | Agent stores secret/queue with DPAPI; remote revoke; recovery guidance | `AgentTests.cs`, `events.test.ts` |
| T18 | Vulnerable dependencies | `pnpm audit` gate + CodeQL in CI; overrides for patched transitive deps | CI |

## Residual risks / not yet mitigated
* Built-in auth has no breached-password check, WebAuthn or recovery codes for MFA.
* `TV_DATA_KEY` rotation is manual (no key IDs yet).
* Local encrypted storage is single-node; production needs a managed bucket with server-side encryption and versioning.
* Rate limiting is in-memory per API instance; multiple instances need a shared store (Redis).
* No WAF/bot protection on registration; consider CAPTCHA on public endpoints.
* The Windows agent runs as the signed-in user; an administrator on that PC can stop it (by design — it is not tamper-proof and does not claim to be).
