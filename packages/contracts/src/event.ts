/**
 * Sensor observations agents report. These are facts, not judgements — the hub
 * decides whether a fact deserves an alert (see AlertType).
 */
export const EventType = {
  MotionDetected: 'motion_detected',
  DoorOpened: 'door_opened',
  DoorClosed: 'door_closed',
  CameraMotion: 'camera_motion',
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

export const EVENT_TYPES: readonly EventType[] = Object.values(EventType);

/**
 * Free-form per-event detail. Deliberately unschema'd: it is where a camera
 * puts its contour area today and a clip URL later (roadmap item 5) without a
 * migration.
 */
export type EventMetadata = Record<string, unknown>;

/** `POST /events` body. */
export interface CreateEventRequest {
  agentId: string;
  type: EventType;
  /** Agent-side clock, ISO 8601. The hub stamps its own receive time separately. */
  occurredAt: string;
  metadata?: EventMetadata;
}

/** An event as the hub reports it. */
export interface EventView {
  id: string;
  agentId: string;
  type: EventType;
  metadata: EventMetadata;
  /** Agent clock. */
  occurredAt: string;
  /** Hub clock — authoritative for ordering, immune to agent clock skew. */
  createdAt: string;
}

/** `GET /events` query parameters. */
export interface QueryEventsRequest {
  limit?: number;
  /** ISO 8601; returns events with `createdAt` strictly after this. */
  since?: string;
  agentId?: string;
  type?: EventType;
}
