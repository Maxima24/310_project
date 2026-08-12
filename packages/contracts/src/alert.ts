import type { SystemMode } from './mode';

/**
 * Hub judgements. Unlike EventType these are policy outcomes, so they carry the
 * arm mode that produced them (`modeAtTrigger`).
 */
export const AlertType = {
  IntrusionMotion: 'intrusion_motion',
  IntrusionDoor: 'intrusion_door',
  CameraMotion: 'camera_motion',
  /**
   * A sensor stopped heartbeating. Raised in every mode including `disarmed`:
   * a silent sensor is treated as possible tamper, not a harmless disconnect.
   */
  AgentOffline: 'agent_offline',
  /** The counterpart to AgentOffline, so a resolution is visible rather than a row silently vanishing. */
  AgentRecovered: 'agent_recovered',
} as const;

export type AlertType = (typeof AlertType)[keyof typeof AlertType];

export const ALERT_TYPES: readonly AlertType[] = Object.values(AlertType);

export const AlertSeverity = {
  Info: 'info',
  Warning: 'warning',
  Critical: 'critical',
} as const;

export type AlertSeverity = (typeof AlertSeverity)[keyof typeof AlertSeverity];

/** An alert as the hub reports it. */
export interface AlertView {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  message: string;
  agentId: string | null;
  eventId: string | null;
  /** The arm mode when the rule fired — the reason this alert exists at all. */
  modeAtTrigger: SystemMode;
  acknowledged: boolean;
  acknowledgedAt: string | null;
  createdAt: string;
}

/** `GET /alerts` query parameters. */
export interface QueryAlertsRequest {
  limit?: number;
  acknowledged?: boolean;
  type?: AlertType;
  agentId?: string;
}
