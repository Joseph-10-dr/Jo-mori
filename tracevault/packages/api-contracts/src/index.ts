/**
 * Shared API contracts: roles, permissions, plans and response shapes.
 * The API enforces these; the dashboard only uses them to decide what to show.
 */
export type { StoredEvent, BatchResult, EventRejection } from '@tracevault/event-schema';

export const ORG_ROLES = ['owner', 'admin', 'security_analyst', 'auditor', 'member'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const ROLE_LABELS: Record<OrgRole, string> = {
  owner: 'Organization owner',
  admin: 'Administrator',
  security_analyst: 'Security analyst',
  auditor: 'Read-only auditor',
  member: 'Standard user',
};

export const PERMISSIONS = [
  'org.manage', // rename org, change billing plan, delete org
  'members.manage', // invite, change roles, remove members
  'devices.view_all', // see every org device and its events
  'devices.manage_all', // revoke/rename any org device
  'alerts.resolve',
  'policies.manage', // retention + enrollment policy
  'audit.view',
  'recordings.view', // sensitive: separate from ordinary event viewing
  'export.org',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Least privilege: members only ever see their own devices. */
export const ROLE_PERMISSIONS: Record<OrgRole, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: [
    'members.manage',
    'devices.view_all',
    'devices.manage_all',
    'alerts.resolve',
    'policies.manage',
    'audit.view',
    'export.org',
  ],
  security_analyst: ['devices.view_all', 'alerts.resolve'],
  auditor: ['devices.view_all', 'audit.view'],
  member: [],
};

export function roleHas(role: OrgRole, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(perm);
}

export const PLAN_IDS = ['free', 'personal', 'premium', 'business'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface PlanLimits {
  maxDevices: number;
  retentionDaysDefault: number;
  retentionDaysMax: number;
  recordingStorageBytes: number;
  maxRecordingSeconds: number;
  alertRules: 'basic' | 'all';
}

/** Feature limits per plan. Prices live in the DB (subscriptions/pricing) so they can vary by region. */
export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  free: {
    maxDevices: 1,
    retentionDaysDefault: 14,
    retentionDaysMax: 30,
    recordingStorageBytes: 0,
    maxRecordingSeconds: 0,
    alertRules: 'basic',
  },
  personal: {
    maxDevices: 5,
    retentionDaysDefault: 90,
    retentionDaysMax: 180,
    recordingStorageBytes: 1 * 1024 ** 3,
    maxRecordingSeconds: 10 * 60,
    alertRules: 'all',
  },
  premium: {
    maxDevices: 10,
    retentionDaysDefault: 180,
    retentionDaysMax: 365,
    recordingStorageBytes: 20 * 1024 ** 3,
    maxRecordingSeconds: 30 * 60,
    alertRules: 'all',
  },
  business: {
    maxDevices: 250,
    retentionDaysDefault: 180,
    retentionDaysMax: 730,
    recordingStorageBytes: 100 * 1024 ** 3,
    maxRecordingSeconds: 30 * 60,
    alertRules: 'all',
  },
};

export interface User {
  id: string;
  email: string;
  display_name: string | null;
  account_type: 'personal' | 'business';
  email_verified: boolean;
  mfa_enabled: boolean;
  plan: PlanId;
  created_at: string;
}

export interface Membership {
  organization_id: string;
  organization_name: string;
  role: OrgRole;
}

export interface Device {
  id: string;
  name: string;
  platform: string;
  os_version: string | null;
  agent_version: string | null;
  owner_user_id: string;
  organization_id: string | null;
  status: 'active' | 'revoked';
  monitoring_status: 'active' | 'paused' | 'unavailable' | 'disabled';
  sync_status: 'never' | 'ok' | 'stale' | 'failing';
  registered_at: string;
  last_seen_at: string | null;
  last_sync_at: string | null;
  revoked_at: string | null;
  permissions: Record<string, 'granted' | 'denied' | 'unsupported' | 'unknown'>;
}

export interface SecurityAlert {
  id: string;
  device_id: string | null;
  device_name: string | null;
  rule: string;
  title: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  confidence: 'confirmed' | 'likely' | 'possible';
  evidence_event_ids: string[];
  explanation: string;
  recommended_action: string;
  status: 'open' | 'resolved' | 'dismissed';
  created_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
}

export interface Paginated<T> {
  items: T[];
  next_cursor: string | null;
  total?: number;
}

export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string;
  details?: unknown;
}
