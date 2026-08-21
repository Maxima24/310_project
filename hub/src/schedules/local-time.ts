import { DAY_LABELS } from '@cpe310/contracts';

/**
 * Wall-clock time in a given IANA zone.
 *
 * Everything about scheduled arming is expressed in local wall time, because that is
 * what an operator means by "arm at 22:00" — not "arm at 02:00 UTC", which drifts by an
 * hour twice a year. `Intl.DateTimeFormat` does the conversion with the platform's own
 * tz database, so there is no dependency to keep current and no offset arithmetic to
 * get wrong.
 */
export interface LocalNow {
  /** Minutes since local midnight, 0-1439. */
  minuteOfDay: number;
  /** 0 = Sunday, matching the stored daysOfWeek convention. */
  dayOfWeek: number;
  /** YYYY-MM-DD in the zone. The per-day idempotency key. */
  dateKey: string;
}

/** True when the string is a zone this platform can actually resolve. */
export function isValidTimezone(timezone: string): boolean {
  if (!timezone || typeof timezone !== 'string') return false;

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function localNow(at: Date, timezone: string): LocalNow {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    // h23 rather than hour12:false — the latter renders midnight as hour "24" on some
    // ICU builds, which would put every midnight schedule a full day out.
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);

  const find = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';

  const hour = Number(find('hour'));
  const minute = Number(find('minute'));
  const weekday = DAY_LABELS.indexOf(find('weekday') as (typeof DAY_LABELS)[number]);

  return {
    minuteOfDay: (hour % 24) * 60 + minute,
    dayOfWeek: weekday >= 0 ? weekday : 0,
    dateKey: `${find('year')}-${find('month')}-${find('day')}`,
  };
}

export interface DueInput {
  enabled: boolean;
  daysOfWeek: readonly number[];
  startMinute: number;
  lastFiredFor: string | null;
}

export type DueVerdict =
  /** Not this schedule's day, already handled today, or the boundary is still ahead. */
  | { kind: 'idle' }
  /** The boundary passed within the grace window and has not been handled. */
  | { kind: 'due'; dateKey: string; lateByMinutes: number }
  /** The boundary passed too long ago to act on — the hub was probably down. */
  | { kind: 'missed'; dateKey: string; lateByMinutes: number };

/**
 * Decides what to do with one schedule at one instant.
 *
 * Pure, so every branch below is testable without a clock, a database, or a cron.
 *
 * The grace window deliberately does NOT wrap past local midnight. A schedule that
 * fires on the wrong day is worse than one that does not fire: arming a building at
 * 00:30 because a 23:50 boundary was missed would look like a malfunction, and the
 * `missed` verdict says so out loud instead.
 */
export function evaluateDue(
  schedule: DueInput,
  local: LocalNow,
  graceMinutes: number,
): DueVerdict {
  if (!schedule.enabled) return { kind: 'idle' };

  // Empty means every day.
  if (schedule.daysOfWeek.length > 0 && !schedule.daysOfWeek.includes(local.dayOfWeek)) {
    return { kind: 'idle' };
  }

  // Already handled for this local date — the restart- and overlap-safe check.
  if (schedule.lastFiredFor === local.dateKey) return { kind: 'idle' };

  const lateByMinutes = local.minuteOfDay - schedule.startMinute;
  if (lateByMinutes < 0) return { kind: 'idle' };

  return lateByMinutes <= graceMinutes
    ? { kind: 'due', dateKey: local.dateKey, lateByMinutes }
    : { kind: 'missed', dateKey: local.dateKey, lateByMinutes };
}

/**
 * The `lastFiredFor` a schedule should be born with.
 *
 * A schedule created at 14:00 saying "arm at 08:00" must not immediately report that it
 * missed this morning — it did not exist this morning. Stamping today's key at creation
 * makes the first boundary it can act on tomorrow's, which is what the person who typed
 * it in expects. The same applies when an edit moves the time to one already past.
 */
export function seedLastFiredFor(startMinute: number, local: LocalNow): string | null {
  return local.minuteOfDay >= startMinute ? local.dateKey : null;
}
