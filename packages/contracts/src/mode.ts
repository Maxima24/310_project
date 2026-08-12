/**
 * System arm state. Alert policy is evaluated against this — the same sensor
 * reading is noise in `disarmed` and an intrusion in `away`.
 */
export const SystemMode = {
  /** Sensors report, nothing alerts (except a silent agent — see AlertType). */
  Disarmed: 'disarmed',
  /** Occupied: interior motion is expected, doors are still guarded. */
  Home: 'home',
  /** Unoccupied: any sensor activity is an intrusion. */
  Away: 'away',
} as const;

export type SystemMode = (typeof SystemMode)[keyof typeof SystemMode];

export const SYSTEM_MODES: readonly SystemMode[] = Object.values(SystemMode);

export function isSystemMode(value: unknown): value is SystemMode {
  return typeof value === 'string' && (SYSTEM_MODES as readonly string[]).includes(value);
}

/** `GET /system/mode` response. */
export interface SystemModeResponse {
  mode: SystemMode;
  updatedAt: string;
}

/** `POST /system/mode` response — `previous` lets a caller detect a no-op change. */
export interface SystemModeChangeResponse extends SystemModeResponse {
  previous: SystemMode;
  changed: boolean;
}
