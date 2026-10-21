-- TraceVault initial schema.
-- Ownership model:
--   * users own personal devices (devices.organization_id IS NULL).
--   * organizations own business devices (devices.organization_id set); the
--     enrolling user is still recorded as owner_user_id.
--   * activity_events / security_alerts / recordings copy owner_user_id and
--     organization_id from the device at write time (resolved server-side,
--     never from client input) so every read can be filtered by tenant.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            citext NOT NULL UNIQUE,
  password_hash    text NOT NULL,              -- argon2id, never plaintext
  display_name     text,
  account_type     text NOT NULL DEFAULT 'personal' CHECK (account_type IN ('personal','business')),
  email_verified_at timestamptz,
  mfa_secret_enc   text,                       -- AES-256-GCM encrypted TOTP secret
  mfa_enabled_at   timestamptz,
  failed_login_count int NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);

CREATE TABLE user_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL UNIQUE,         -- sha256(session token)
  mfa_passed    boolean NOT NULL DEFAULT false,
  user_agent    text,
  ip            inet,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);
CREATE INDEX user_sessions_user_idx ON user_sessions(user_id);

-- Single-use tokens for email verification and password reset.
CREATE TABLE email_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('verify_email','reset_password')),
  token_hash  bytea NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Development/test mail sink. Production uses the configured mail provider;
-- rows here hold only the rendered message and are purged after 7 days.
CREATE TABLE email_outbox (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_email    citext NOT NULL,
  subject     text NOT NULL,
  body        text NOT NULL,
  provider    text NOT NULL,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Enrollment policy: members may enroll devices into the org only if allowed.
  member_enrollment_allowed boolean NOT NULL DEFAULT true,
  require_mfa_for_admins    boolean NOT NULL DEFAULT true,
  -- A business plan does not by itself authorise recording employees. An owner
  -- must turn this on (with notice to staff) before org devices may record.
  recordings_allowed        boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_members (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('owner','admin','security_analyst','auditor','member')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX organization_members_user_idx ON organization_members(user_id);

CREATE TABLE organization_invitations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email           citext NOT NULL,
  role            text NOT NULL CHECK (role IN ('admin','security_analyst','auditor','member')),
  token_hash      bytea NOT NULL UNIQUE,
  invited_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at      timestamptz NOT NULL,
  accepted_at     timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organization_invitations_org_idx ON organization_invitations(organization_id);

-- Short-lived one-time codes a signed-in user creates in the dashboard and
-- types into the device agent. Exchanged for a device credential.
CREATE TABLE device_enrollment_codes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  code_hash       bytea NOT NULL UNIQUE,
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id   uuid REFERENCES organizations(id) ON DELETE CASCADE,
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  platform          text NOT NULL CHECK (platform IN ('windows','macos','android','ios','web','simulator')),
  os_version        text,
  agent_version     text,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  monitoring_status text NOT NULL DEFAULT 'active' CHECK (monitoring_status IN ('active','paused','unavailable','disabled')),
  permissions       jsonb NOT NULL DEFAULT '{}'::jsonb,
  startup_enabled   boolean NOT NULL DEFAULT false,
  registered_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz,
  last_sync_at      timestamptz,
  last_sync_error   text,
  consecutive_sync_failures int NOT NULL DEFAULT 0,
  revoked_at        timestamptz,
  revoked_by        uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX devices_owner_idx ON devices(owner_user_id);
CREATE INDEX devices_org_idx ON devices(organization_id) WHERE organization_id IS NOT NULL;

-- Device secrets are stored only as sha256 hashes (they are 256-bit random,
-- so a fast hash is appropriate). Rotation inserts a new row; old rows are
-- revoked after a short overlap.
CREATE TABLE device_credentials (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  secret_hash bytea NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  revoked_at  timestamptz,
  last_used_at timestamptz
);
CREATE INDEX device_credentials_device_idx ON device_credentials(device_id);

CREATE TABLE activity_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        uuid NOT NULL,                 -- client-generated, for dedupe
  device_id       uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  owner_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  event_type      text NOT NULL,
  severity        text NOT NULL CHECK (severity IN ('info','low','medium','high','critical')),
  source          text NOT NULL,
  occurred_at     timestamptz NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  schema_version  smallint NOT NULL,
  search_text     tsvector GENERATED ALWAYS AS (
                    to_tsvector('simple', event_type || ' ' || coalesce(metadata::text, ''))
                  ) STORED,
  UNIQUE (device_id, event_id)
);
CREATE INDEX activity_events_owner_time_idx ON activity_events(owner_user_id, occurred_at DESC);
CREATE INDEX activity_events_org_time_idx ON activity_events(organization_id, occurred_at DESC) WHERE organization_id IS NOT NULL;
CREATE INDEX activity_events_device_time_idx ON activity_events(device_id, occurred_at DESC);
CREATE INDEX activity_events_type_idx ON activity_events(event_type, occurred_at DESC);
CREATE INDEX activity_events_search_idx ON activity_events USING gin(search_text);

CREATE TABLE security_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  device_id       uuid REFERENCES devices(id) ON DELETE CASCADE,
  rule            text NOT NULL,
  title           text NOT NULL,
  severity        text NOT NULL CHECK (severity IN ('info','low','medium','high','critical')),
  confidence      text NOT NULL CHECK (confidence IN ('confirmed','likely','possible')),
  evidence_event_ids uuid[] NOT NULL DEFAULT '{}',
  explanation     text NOT NULL,
  recommended_action text NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  dedupe_key      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  resolved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  resolution_note text
);
CREATE INDEX security_alerts_owner_idx ON security_alerts(owner_user_id, created_at DESC);
CREATE INDEX security_alerts_org_idx ON security_alerts(organization_id, created_at DESC) WHERE organization_id IS NOT NULL;
CREATE UNIQUE INDEX security_alerts_dedupe_idx ON security_alerts(dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE recordings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id       uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  owner_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('screen','audio')),
  status          text NOT NULL DEFAULT 'pending_upload' CHECK (status IN ('pending_upload','available','failed','deleted')),
  storage_key     text NOT NULL UNIQUE,           -- object storage key, never the bytes
  mime_type       text NOT NULL,
  declared_bytes  bigint NOT NULL,
  size_bytes      bigint,
  sha256_hex      text NOT NULL,
  started_at      timestamptz NOT NULL,
  stopped_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  expires_at      timestamptz NOT NULL,           -- retention-driven automatic deletion
  deleted_at      timestamptz
);
CREATE INDEX recordings_owner_idx ON recordings(owner_user_id, created_at DESC);
CREATE INDEX recordings_org_idx ON recordings(organization_id) WHERE organization_id IS NOT NULL;

-- Single-use, short-lived upload/download tickets for object storage.
CREATE TABLE storage_tickets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id  uuid NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  purpose       text NOT NULL CHECK (purpose IN ('upload','download')),
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE recording_consents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id    uuid NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  device_id       uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  consenting_party text NOT NULL,                 -- who at the device agreed (local display name)
  consent_text    text NOT NULL,                  -- exact notice shown
  os_permission   text NOT NULL CHECK (os_permission IN ('granted','denied','not_required')),
  indicator_shown boolean NOT NULL,
  consented_at    timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Append-only, hash-chained audit log. UPDATE/DELETE are blocked by trigger.
CREATE TABLE audit_logs (
  id              bigserial PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor_user_id   uuid,                           -- no FK: survives user deletion
  actor_device_id uuid,
  organization_id uuid,
  subject_user_id uuid,                           -- whose data was touched
  action          text NOT NULL,
  target_type     text,
  target_id       text,
  ip              inet,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  sensitive       boolean NOT NULL DEFAULT false, -- recording access etc.
  prev_hash       bytea,
  row_hash        bytea NOT NULL
);
CREATE INDEX audit_logs_org_idx ON audit_logs(organization_id, occurred_at DESC);
CREATE INDEX audit_logs_subject_idx ON audit_logs(subject_user_id, occurred_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs(actor_user_id, occurred_at DESC);

CREATE FUNCTION audit_logs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('tracevault.allow_audit_purge', true) = 'on' AND TG_OP = 'DELETE' THEN
    RETURN OLD;  -- only the retention job sets this, inside its own transaction
  END IF;
  RAISE EXCEPTION 'audit_logs is append-only';
END $$;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

CREATE TABLE notification_preferences (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel        text NOT NULL CHECK (channel IN ('email','push')),
  min_severity   text NOT NULL DEFAULT 'medium' CHECK (min_severity IN ('info','low','medium','high','critical')),
  enabled        boolean NOT NULL DEFAULT true,
  login_alerts   boolean NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, channel)
);

-- One row per scope: either a user (personal data) or an organization.
CREATE TABLE retention_policies (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  organization_id    uuid UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  event_retention_days     int NOT NULL CHECK (event_retention_days BETWEEN 1 AND 3650),
  recording_retention_days int NOT NULL CHECK (recording_retention_days BETWEEN 1 AND 3650),
  audit_retention_days     int NOT NULL DEFAULT 365 CHECK (audit_retention_days BETWEEN 30 AND 3650),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  CHECK ((user_id IS NULL) <> (organization_id IS NULL))
);

CREATE TABLE subscriptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  organization_id  uuid UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  plan             text NOT NULL DEFAULT 'free' CHECK (plan IN ('free','personal','premium','business')),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','trialing','past_due','canceled')),
  provider         text NOT NULL DEFAULT 'none',   -- no live payment processor yet
  provider_ref     text,
  current_period_end timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((user_id IS NULL) <> (organization_id IS NULL))
);

-- Region/currency configurable prices (minor units). Display only until billing is integrated.
CREATE TABLE plan_prices (
  plan        text NOT NULL CHECK (plan IN ('free','personal','premium','business')),
  region      text NOT NULL,
  currency    char(3) NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  per         text NOT NULL CHECK (per IN ('month','seat_month')),
  PRIMARY KEY (plan, region)
);

CREATE TABLE usage_records (
  id              bigserial PRIMARY KEY,
  user_id         uuid REFERENCES users(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  metric          text NOT NULL CHECK (metric IN ('events_ingested','ingest_bytes','recording_bytes_stored','recording_bytes_downloaded','summaries_generated')),
  period_day      date NOT NULL,
  quantity        bigint NOT NULL DEFAULT 0,
  CHECK ((user_id IS NULL) <> (organization_id IS NULL))
);
CREATE UNIQUE INDEX usage_records_user_uq ON usage_records(user_id, metric, period_day) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX usage_records_org_uq ON usage_records(organization_id, metric, period_day) WHERE organization_id IS NOT NULL;

-- Row Level Security as defence in depth. The API connects as the table owner
-- (RLS bypassed) and enforces tenancy in queries; if a read-only analytics or
-- Supabase client role is ever granted access, these policies scope rows by
-- the `tracevault.user_id` setting.
ALTER TABLE activity_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE recordings ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_events ON activity_events USING (
  owner_user_id = nullif(current_setting('tracevault.user_id', true), '')::uuid
  OR organization_id IN (SELECT organization_id FROM organization_members
                         WHERE user_id = nullif(current_setting('tracevault.user_id', true), '')::uuid
                           AND role IN ('owner','admin','security_analyst','auditor')));
CREATE POLICY tenant_alerts ON security_alerts USING (
  owner_user_id = nullif(current_setting('tracevault.user_id', true), '')::uuid
  OR organization_id IN (SELECT organization_id FROM organization_members
                         WHERE user_id = nullif(current_setting('tracevault.user_id', true), '')::uuid
                           AND role IN ('owner','admin','security_analyst','auditor')));
CREATE POLICY tenant_recordings ON recordings USING (
  owner_user_id = nullif(current_setting('tracevault.user_id', true), '')::uuid
  OR organization_id IN (SELECT organization_id FROM organization_members
                         WHERE user_id = nullif(current_setting('tracevault.user_id', true), '')::uuid
                           AND role = 'owner'));
CREATE POLICY tenant_devices ON devices USING (
  owner_user_id = nullif(current_setting('tracevault.user_id', true), '')::uuid
  OR organization_id IN (SELECT organization_id FROM organization_members
                         WHERE user_id = nullif(current_setting('tracevault.user_id', true), '')::uuid
                           AND role IN ('owner','admin','security_analyst','auditor')));

INSERT INTO plan_prices (plan, region, currency, amount_minor, per) VALUES
  ('free','default','USD',0,'month'),
  ('personal','default','USD',399,'month'),
  ('premium','default','USD',999,'month'),
  ('business','default','USD',600,'seat_month'),
  ('free','NG','NGN',0,'month'),
  ('personal','NG','NGN',350000,'month'),
  ('premium','NG','NGN',900000,'month'),
  ('business','NG','NGN',500000,'seat_month');
