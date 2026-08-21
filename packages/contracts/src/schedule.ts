/**
 * Scheduled arming.
 *
 * THE CENTRAL DECISION: a schedule is a TRANSITION, not a continuously enforced state.
 * It fires once when its boundary passes and then leaves the system alone. The
 * alternative — re-asserting the mode every tick — would fight an operator who
 * deliberately disarmed to let a contractor in, which is exactly the wrong behaviour
 * for a security panel. So a manual change is respected until the next boundary, and
 * the next boundary still fires: the most common reason a building is left unarmed is
 * that somebody forgot, and a schedule that yields forever to one manual click does not
 * solve that.
 */

import type { SystemMode } from './mode';

export interface ArmScheduleView {
  id: string;
  name: string;
  enabled: boolean;
  /** The mode to move to when this fires. */
  mode: SystemMode;
  /** 0 = Sunday. Empty means every day. */
  daysOfWeek: number[];
  /** Minutes from local midnight, 0-1439. Stored as a number so it cannot be an
   *  unparseable string, and rendered as HH:MM at the edges. */
  startMinute: number;
  /** IANA zone, e.g. "America/New_York". Stored per schedule because the hub container
   *  runs UTC and a fixed offset would be wrong for half the year. */
  timezone: string;
  lastFiredAt?: string;
  /** Local date (YYYY-MM-DD) this last fired for. The idempotency key. */
  lastFiredFor?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertArmScheduleRequest {
  name: string;
  mode: SystemMode;
  startMinute: number;
  timezone: string;
  daysOfWeek?: number[];
  enabled?: boolean;
}

export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export const MINUTES_PER_DAY = 24 * 60;

/** 570 -> "09:30". */
export function formatStartMinute(startMinute: number): string {
  const hours = Math.floor(startMinute / 60);
  const minutes = startMinute % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** "09:30" -> 570, or null when it is not a valid time of day. */
export function parseStartMinute(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  return hours * 60 + minutes;
}

/** "Every day", "Weekdays", or a short list. */
export function describeDays(daysOfWeek: readonly number[]): string {
  if (daysOfWeek.length === 0 || daysOfWeek.length === 7) return 'Every day';

  const sorted = [...daysOfWeek].sort((a, b) => a - b);
  if (sorted.join() === '1,2,3,4,5') return 'Weekdays';
  if (sorted.join() === '0,6') return 'Weekends';

  return sorted.map((day) => DAY_LABELS[day]).join(', ');
}
