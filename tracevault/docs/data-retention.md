# Data retention and deletion

Implemented in `apps/api/src/retention/retention.service.ts` (runs hourly when `BACKGROUND_JOBS=true`)
and tested in `tests/security/privacy-and-logging.test.ts`.

## Ownership scopes
| Record | Belongs to | Policy used |
|---|---|---|
| Personal device + its events, alerts, recordings | The user | User's `retention_policies` row |
| Organization device + its events, alerts, recordings | The organization (enrolling user recorded as owner) | Organization's row |
| Audit log rows | The organization (if `organization_id` set) or the platform | Org `audit_retention_days`, else 365 days |
| Sessions, email tokens, tickets, dev outbox | Platform | Fixed (see below) |

## Defaults and limits
New personal accounts start with 14 days for events and 7 days for recordings; users can raise
these up to their plan's maximum. New organizations start with 180 days for events and 30 for
recordings. Downgrading a plan lowers any setting above the new maximum.

| Plan | Maximum retention (events and recordings) |
|---|---|
| Free | 30 days (no recordings) |
| Personal | 180 days |
| Premium | 365 days |
| Business | 730 days |

Audit logs: 365 days default, 30–3650 configurable by organizations.

## What the purge job deletes
* `activity_events` older than the scope's `event_retention_days` (by `occurred_at`).
* Recordings past `expires_at` (set at upload as `stopped_at + recording_retention_days`): the object
  is deleted from storage and the row marked `deleted`.
* Uploads never completed within 24 hours.
* Audit rows past audit retention (the only path allowed through the append-only trigger).
* Expired sessions (and revoked sessions after 30 days), used/expired email tokens after 1 day,
  storage tickets and enrollment codes after 1 day, dev-outbox mail after 7 days.

## User-initiated deletion
* **Recording:** object deleted immediately, row marked `deleted`, audited.
* **Device:** device, events, alerts and recording objects deleted.
* **Account:** requires password + typing `DELETE`. Deletes the user, personal devices and all their
  records, organizations they solely own, and recording objects. Blocked if the user owns an
  organization that has other members. An `account.deleted` audit row (no event data) remains for
  the audit retention period.

## Backups
Managed-database point-in-time recovery is a deployment prerequisite (see
`infrastructure/deployment/README.md`). Deleted data persists in backups until they age out
(target ≤35 days). Restores must re-run the purge job before the system is reopened.
