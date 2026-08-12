/** Kind of collector agent. Determines which sensor reader it drives. */
export const AgentType = {
  Motion: 'motion',
  Door: 'door',
  Camera: 'camera',
} as const;

export type AgentType = (typeof AgentType)[keyof typeof AgentType];

export const AGENT_TYPES: readonly AgentType[] = Object.values(AgentType);

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
}
