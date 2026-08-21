/** Kind of collector agent. Determines which sensor reader it drives. */
export const AgentType = {
  Motion: 'motion',
  Door: 'door',
  Camera: 'camera',
} as const;

export type AgentType = (typeof AgentType)[keyof typeof AgentType];

export const AGENT_TYPES: readonly AgentType[] = Object.values(AgentType);

/**
 * Legal agent ids. Operator-chosen and used as the primary key, so it is constrained
 * to URL-safe characters — the id appears in `/agents/:id/heartbeat`.
 *
 * Lives here rather than only in the hub's DTO so anything that OFFERS to create an
 * agent can reject a bad id before the round trip, using the identical rule. Two copies
 * of a validation regex drift, and the drift shows up as a form that accepts a name the
 * server then refuses.
 */
export const AGENT_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
export const AGENT_ID_MAX_LENGTH = 64;

/**
 * Where an agent's data physically comes from.
 *
 * Deliberately NOT a value in `capabilities`: that array is free text the agent sends
 * about itself, and a security-relevant marker cannot be self-reported. The hub sets this
 * column, the client cannot influence it, and every view that shows a camera shows it.
 *
 * Also deliberately not a new `AgentType`. A browser is not a different kind of sensor —
 * it is a different kind of source for the same kind of sensor, and folding it into `type`
 * would break every `type === 'camera'` filter in the system.
 */
export const AgentOrigin = {
  /** A dedicated process on hardware: the Python agents, including on a laptop. */
  Device: 'device',
  /** A browser tab publishing its own webcam. Fabricable, therefore always labelled. */
  Browser: 'browser',
} as const;

export type AgentOrigin = (typeof AgentOrigin)[keyof typeof AgentOrigin];

/**
 * Liveness, derived from `lastSeenAt` by the hub's sweep — never self-reported.
 * An agent cannot tell the hub it is offline; that is the point.
 */
export const AgentStatus = {
  Online: 'online',
  Offline: 'offline',
} as const;

export type AgentStatus = (typeof AgentStatus)[keyof typeof AgentStatus];

/** `POST /agents/register` body. */
export interface RegisterAgentRequest {
  /** Operator-chosen stable id, e.g. `motion-hallway`. Used as the natural key. */
  id: string;
  type: AgentType;
  location: string;
  /** Agent software version, for spotting a fleet running mixed builds. */
  version?: string;
  /** Free-form feature flags, e.g. `["mog2", "rtsp"]`. */
  capabilities?: string[];
}

/** An agent as the hub reports it. */
export interface AgentView {
  id: string;
  type: AgentType;
  location: string;
  status: AgentStatus;
  version: string | null;
  capabilities: string[];
  /** Hub-set, unlike `capabilities`. See AgentOrigin. */
  origin: AgentOrigin;
  registeredAt: string;
  lastSeenAt: string;
  /** Derived convenience field so a dashboard doesn't need clock maths. */
  secondsSinceLastSeen: number;
}

/** `POST /agents/register` and `POST /agents/:id/heartbeat` response. */
export interface AgentAckResponse {
  agent: AgentView;
  /**
   * Echoed back so a restarting agent can align its own loop with the hub's
   * expectation instead of hardcoding 10s.
   */
  heartbeatIntervalMs: number;
  /**
   * Present only on `POST /agents/register`: the agent's own token, shown once.
   * Absent on heartbeats — see EnrollmentResponse in ./auth.
   */
  enrollment?: {
    token: string;
    issuedAt: string;
    rotated: boolean;
  };
}
