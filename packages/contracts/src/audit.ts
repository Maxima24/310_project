/**
 * The audit trail: what was attempted, by whom, and whether it was allowed.
 *
 * WHAT THIS CAN AND CANNOT TELL YOU. Credentials in this system are shared per-role
 * secrets, so the hub knows the ROLE that acted and — for agent tokens — the specific
 * agent, because that token is per-agent and verified. It does not know which PERSON
 * acted, and no amount of schema design changes that. Every field below is labelled
 * with which of the two it is, and the dashboard must repeat the distinction rather
 * than let an unverified name read as identity.
 *
 * The honest upgrade is a users table with per-user credentials. When that lands,
 * `actorLabel` becomes a verified user reference and nothing else here changes.
 */

import type { AuthRole } from './auth';

/**
 * Who acted. Every AuthRole, plus `system` for actions the hub takes on its own —
 * a scheduled arming has no operator behind it, and recording one would be a lie.
 */
export const AuditActor = {
  Bootstrap: 'bootstrap',
  Agent: 'agent',
  Viewer: 'viewer',
  Operator: 'operator',
  Admin: 'admin',
  System: 'system',
} as const;

export type AuditActor = (typeof AuditActor)[keyof typeof AuditActor];

export function actorForRole(role: AuthRole): AuditActor {
  return role as AuditActor;
}

/** What was attempted. */
export const AuditAction = {
  /** Arm or disarm. */
  ModeChanged: 'mode_changed',
  AlertAcknowledged: 'alert_acknowledged',
  AgentEnrolled: 'agent_enrolled',
  /** A re-enrollment that invalidated an existing token. */
  AgentTokenRotated: 'agent_token_rotated',
  /** A live view was opened — surveillance of the surveillance. */
  CameraViewed: 'camera_viewed',
  /** An automatic transition from a schedule (roadmap: scheduled arming). */
  ScheduleFired: 'schedule_fired',
  /**
   * A publishing credential was minted for a browser to act as a camera. Kept distinct
   * from AgentEnrolled because "someone created a fabricable video source" is a
   * materially different event from "a sensor came online", and the audit view filters
   * by action.
   */
  BrowserCameraProvisioned: 'browser_camera_provisioned',
  BrowserCameraRevoked: 'browser_camera_revoked',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

/**
 * Denials are recorded, not just successes. A refused disarm during an active
 * incident is the single most interesting line this table will ever hold, and until
 * now it existed only as a log line nobody reads.
 */
export const AuditOutcome = {
  Allowed: 'allowed',
  Denied: 'denied',
} as const;

export type AuditOutcome = (typeof AuditOutcome)[keyof typeof AuditOutcome];

/**
 * Optional display name, sent by the dashboard from a name typed at sign-in.
 *
 * SELF-ASSERTED AND NEVER VERIFIED. Anyone holding the credential can send any name,
 * including someone else's. It is recorded because a shift log with a claimed name is
 * more useful than one without, and displayed with that caveat attached — never as
 * though the hub confirmed it.
 */
export const OPERATOR_LABEL_HEADER = 'x-operator-label';

/** Longest label accepted. Beyond this it is a payload, not a name. */
export const MAX_OPERATOR_LABEL_LENGTH = 64;

export interface AuditEntryView {
  id: string;
  at: string;
  action: AuditAction;
  outcome: AuditOutcome;
  /** VERIFIED — established by the hub from the credential presented. */
  actor: AuditActor;
  /** VERIFIED — present only for agent tokens, which are per-agent. */
  actorAgentId?: string;
  /** UNVERIFIED — see OPERATOR_LABEL_HEADER. Display as claimed, never as identity. */
  actorLabel?: string;
  /** Why a denial happened, in the same words the caller was given. */
  reason?: string;
  targetType?: string;
  targetId?: string;
  detail: Record<string, unknown>;
  /**
   * Remote address as the hub saw it. Behind a reverse proxy this is the proxy unless
   * the hub is configured to trust it, so treat it as a hint and not evidence.
   */
  ip?: string;
}

export interface QueryAuditRequest {
  limit?: number;
  action?: AuditAction;
  outcome?: AuditOutcome;
  actor?: AuditActor;
  /** ISO timestamp; entries at or after it. */
  since?: string;
}
