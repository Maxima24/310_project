/**
 * Credential roles (roadmap item 2).
 *
 * The shared `x-agent-key` this replaced let any key holder do anything: forge an
 * event as any sensor, disarm the system, acknowledge alerts. Splitting the
 * credentials means a compromised sensor can only ever speak for itself.
 */
export const AuthRole = {
  /** Provisioning secret. Enrollment only — `POST /agents/register`, nothing else. */
  Bootstrap: 'bootstrap',
  /** A per-agent token. Scoped to one agent id: its own heartbeats and its own events. */
  Agent: 'agent',
  /** Dashboards and humans: read history, arm/disarm, acknowledge alerts. */
  Operator: 'operator',
} as const;

export type AuthRole = (typeof AuthRole)[keyof typeof AuthRole];

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
