/**
 * Authorization model: roles, permissions, and the attributes policies read.
 *
 * Shared so the hub and the dashboard cannot disagree about what a role may do. The
 * hub remains authoritative — the dashboard also *receives* its effective permissions
 * from `GET /auth/me` rather than deriving them, so a policy change on the server
 * takes effect in the UI without a redeploy, and a stale client cannot grant itself
 * anything.
 */

/** Who is calling. */
export const AuthRole = {
  /** Provisioning secret. Enrollment only — `POST /agents/register`, nothing else. */
  Bootstrap: 'bootstrap',
  /** A per-agent token. Scoped to one agent id: its own heartbeats and its own events. */
  Agent: 'agent',
  /** Read-only human. Can be restricted to specific zones. */
  Viewer: 'viewer',
  /** Day-to-day operator: acknowledge alerts, arm and disarm. */
  Operator: 'operator',
  /** Everything an operator can do, plus overrides and the delivery audit. */
  Admin: 'admin',
} as const;

export type AuthRole = (typeof AuthRole)[keyof typeof AuthRole];

/**
 * Individual capabilities. Routes are guarded on these rather than on roles, so
 * changing what a role may do never means editing a controller.
 */
export const Permission = {
  AgentsRead: 'agents:read',
  EventsRead: 'events:read',
  AlertsRead: 'alerts:read',
  AlertsAck: 'alerts:ack',
  SystemModeRead: 'system:mode:read',
  /** disarmed/home -> away, or disarmed -> home. Raising protection. */
  SystemArm: 'system:arm',
  /** Anything -> disarmed. Lowering protection, so it is separately gated. */
  SystemDisarm: 'system:disarm',
  /** The notification delivery audit: was anyone actually told? */
  NotificationsRead: 'notifications:read',
  /** Enrolling an agent. */
  AgentsEnroll: 'agents:enroll',
  /** An agent reporting its own event. */
  EventsWrite: 'events:write',
  /** An agent proving liveness. */
  AgentsHeartbeat: 'agents:heartbeat',
  /** Watching a camera's live view. Separate from AgentsRead: knowing a camera exists
   *  and being allowed to look through it are different things. */
  CamerasView: 'cameras:view',
  /** A camera agent pushing its own frames. */
  CamerasPublish: 'cameras:publish',
  /**
   * Minting a publishing credential for a browser to act as a camera.
   *
   * ADMIN ONLY, and the reason is the shared-secret model: credentials here are per
   * role, not per person, so granting this to operators would let everyone holding the
   * operator key create publishing identities. Issuing a credential is an admin act.
   */
  CamerasProvision: 'cameras:provision',
  /** The audit trail: who changed the mode, who cleared an alert, who was refused. */
  AuditRead: 'audit:read',
  SchedulesRead: 'schedules:read',
  /**
   * Creating or editing a schedule. Holding this is NOT sufficient on its own: a
   * schedule that disarms is a delegated disarm, so the policy layer additionally
   * requires the caller to hold the arm/disarm permission the schedule would exercise.
   * Otherwise this permission would be a way to do indirectly what you may not do
   * directly, on a timer.
   */
  SchedulesWrite: 'schedules:write',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

const VIEWER_PERMISSIONS: Permission[] = [
  Permission.AgentsRead,
  Permission.EventsRead,
  Permission.AlertsRead,
  Permission.SystemModeRead,
  Permission.CamerasView,
  // Reading schedules is part of understanding why the system is in the mode it is in.
  Permission.SchedulesRead,
];

const OPERATOR_PERMISSIONS: Permission[] = [
  ...VIEWER_PERMISSIONS,
  Permission.AlertsAck,
  Permission.SystemArm,
  Permission.SystemDisarm,
  Permission.SchedulesWrite,
];

/**
 * Role -> permissions (the RBAC half).
 *
 * Note that `operator` holds SystemDisarm: the restriction on disarming during an
 * active critical alert is attribute-based, not role-based, so it lives in the policy
 * layer rather than here. Roles answer "what may this kind of user do?"; policies
 * answer "may they do it right now, to this thing?".
 */
export const ROLE_PERMISSIONS: Record<AuthRole, readonly Permission[]> = {
  [AuthRole.Bootstrap]: [Permission.AgentsEnroll],
  [AuthRole.Agent]: [
    Permission.EventsWrite,
    Permission.AgentsHeartbeat,
    Permission.CamerasPublish,
  ],
  [AuthRole.Viewer]: VIEWER_PERMISSIONS,
  [AuthRole.Operator]: OPERATOR_PERMISSIONS,
  [AuthRole.Admin]: [
    ...OPERATOR_PERMISSIONS,
    Permission.NotificationsRead,
    // Admin-only, and not because the contents are secret. An audit trail readable by
    // the people it records invites tidying, and its whole value is that it is written
    // by the system rather than curated by its subjects.
    Permission.AuditRead,
    Permission.CamerasProvision,
  ],
};

export function permissionsForRole(role: AuthRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

/** Actions a policy can be asked about, beyond a plain permission check. */
export const PolicyAction = {
  SetMode: 'system:setMode',
  AcknowledgeAlert: 'alerts:acknowledge',
  ReadAgent: 'agents:readOne',
} as const;

export type PolicyAction = (typeof PolicyAction)[keyof typeof PolicyAction];

/** Why a policy refused, so the UI can explain rather than just disable a button. */
export interface PolicyDecision {
  allowed: boolean;
  /** Human-readable, shown directly to an operator. Absent when allowed. */
  reason?: string;
  /** Which role could perform it instead, when the block is role-based. */
  requiresRole?: AuthRole;
}

/**
 * `GET /auth/me`. The dashboard renders from this instead of hardcoding a role table,
 * so the server stays the single source of truth.
 */
export interface IdentityResponse {
  role: AuthRole;
  permissions: Permission[];
  /**
   * Agent locations this credential may see. Empty means unrestricted — the
   * attribute-based half of the model: two viewers with the same role can see
   * different data.
   */
  zones: string[];
  /** Present only for an agent token. */
  agentId?: string;
}

/** Every credential travels as `Authorization: Bearer <credential>`. */
export const AUTH_HEADER = 'authorization';
export const BEARER_PREFIX = 'Bearer ';

/** Prefix on issued agent tokens, so a leaked string is recognisable in a log. */
export const AGENT_TOKEN_PREFIX = 'ag_';

/**
 * Registration response. `token` is shown exactly once — the hub stores only a
 * hash, so it cannot be recovered later, only rotated by re-enrolling.
 */
export interface EnrollmentResponse {
  token: string;
  /** When the token was issued, for operators auditing a fleet. */
  issuedAt: string;
  /**
   * True when this replaced an existing token. Re-enrollment is legitimate (an agent
   * that lost its token file) but worth surfacing, since it is also what an attacker
   * holding the bootstrap key would do.
   */
  rotated: boolean;
}

/** True when the role's permission set contains `permission`. */
export function roleHas(role: AuthRole, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}

/**
 * True when a zone-restricted credential may see a given agent location.
 * An empty `zones` list means unrestricted.
 */
export function zoneAllows(zones: readonly string[], location: string): boolean {
  if (zones.length === 0) return true;
  return zones.some((zone) => zone.toLowerCase() === location.toLowerCase());
}
