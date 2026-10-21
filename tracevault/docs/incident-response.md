# Incident response

## Severity
| Level | Examples | Response target |
|---|---|---|
| SEV1 | Cross-tenant data exposure, recording leak, credential/key compromise, audit chain broken | Immediate; all hands |
| SEV2 | Ingest outage > 30 min, alerts not delivered, auth outage | 1 hour |
| SEV3 | Degraded performance, single-feature bugs | Next business day |

## Runbook
1. **Detect** — health check failures (`GET /v1/health`), error-rate alerts, `email_outbox.status='failed'`
   spikes, `audit-logs/verify` returning `intact: false`, or a report via `SECURITY.md`.
2. **Contain**
   * Compromised device secret: revoke the device (dashboard or `UPDATE devices SET status='revoked'`).
   * Compromised user session: `UPDATE user_sessions SET revoked_at = now() WHERE user_id = …`.
   * Compromised `TV_URL_SIGNING_KEY`: rotate the env var and restart — all outstanding links die.
   * Compromised `TV_DATA_KEY`: rotate, re-encrypt MFA secrets (users re-enrol MFA if needed) and
     recording objects; treat as SEV1.
   * Compromised database credentials: rotate in the provider, restart the API.
3. **Investigate** — use the audit log (`sensitive=true` filters recording access), request logs
   (method/path/status only), and database PITR snapshots. Preserve evidence before changing data.
4. **Eradicate & recover** — patch, deploy, verify with the automated test suite and the audit chain
   verification.
5. **Notify** — affected users and regulators within legal deadlines (e.g. 72 hours under NDPA/GDPR
   for personal-data breaches). State facts, not speculation.
6. **Review** — blameless post-mortem within 5 working days; add a regression test.

## Contacts
Security lead: [name, phone]. Hosting/database/email provider support links: [fill in].
