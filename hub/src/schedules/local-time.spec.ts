import { evaluateDue, isValidTimezone, localNow, seedLastFiredFor } from './local-time';

const NY = 'America/New_York';
const TOKYO = 'Asia/Tokyo';

function due(
  overrides: Partial<Parameters<typeof evaluateDue>[0]> = {},
  local = localNow(new Date('2026-08-14T12:00:00Z'), 'UTC'),
  grace = 60,
) {
  return evaluateDue(
    { enabled: true, daysOfWeek: [], startMinute: 0, lastFiredFor: null, ...overrides },
    local,
    grace,
  );
}

describe('isValidTimezone', () => {
  it('accepts a real IANA zone', () => {
    expect(isValidTimezone(NY)).toBe(true);
  });

  it('rejects a plausible-looking invention', () => {
    // The reason this check exists: "America/Metropolis" passes any regex you would
    // write and then throws inside a cron job at 03:00.
    expect(isValidTimezone('America/Metropolis')).toBe(false);
  });

  it('rejects empty and non-string input', () => {
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone(undefined as unknown as string)).toBe(false);
  });
});

describe('localNow', () => {
  it('converts UTC to the zone’s wall clock', () => {
    // 2026-08-14 12:00 UTC is 08:00 in New York (EDT, UTC-4).
    const local = localNow(new Date('2026-08-14T12:00:00Z'), NY);

    expect(local.minuteOfDay).toBe(8 * 60);
    expect(local.dateKey).toBe('2026-08-14');
  });

  it('rolls the local DATE forward where the zone is ahead', () => {
    // The case a UTC-only implementation gets wrong: in Tokyo it is already tomorrow,
    // so "today's schedule" is a different day's schedule.
    const local = localNow(new Date('2026-08-14T16:00:00Z'), TOKYO);

    expect(local.dateKey).toBe('2026-08-15');
    expect(local.minuteOfDay).toBe(1 * 60);
  });

  it('reports midnight as minute 0, not minute 1440', () => {
    // hour12:false renders midnight as "24" on some ICU builds, which would put every
    // midnight schedule a full day out.
    const local = localNow(new Date('2026-08-14T04:00:00Z'), NY);

    expect(local.minuteOfDay).toBe(0);
    expect(local.dateKey).toBe('2026-08-14');
  });

  it('numbers weekdays from Sunday, matching the stored convention', () => {
    // 2026-08-16 is a Sunday.
    expect(localNow(new Date('2026-08-16T12:00:00Z'), 'UTC').dayOfWeek).toBe(0);
    expect(localNow(new Date('2026-08-17T12:00:00Z'), 'UTC').dayOfWeek).toBe(1);
    expect(localNow(new Date('2026-08-15T12:00:00Z'), 'UTC').dayOfWeek).toBe(6);
  });

  it('tracks a DST shift without any offset arithmetic', () => {
    // US clocks go forward on 2026-03-08. 12:00 UTC is 07:00 EST before, 08:00 EDT after.
    expect(localNow(new Date('2026-03-07T12:00:00Z'), NY).minuteOfDay).toBe(7 * 60);
    expect(localNow(new Date('2026-03-09T12:00:00Z'), NY).minuteOfDay).toBe(8 * 60);
  });
});

describe('evaluateDue', () => {
  const noon = localNow(new Date('2026-08-14T12:00:00Z'), 'UTC'); // Friday, minute 720

  it('is idle before the boundary', () => {
    expect(due({ startMinute: 800 }, noon).kind).toBe('idle');
  });

  it('is due exactly at the boundary', () => {
    const verdict = due({ startMinute: 720 }, noon);

    expect(verdict.kind).toBe('due');
    expect(verdict.kind === 'due' && verdict.lateByMinutes).toBe(0);
  });

  it('is due inside the grace window', () => {
    expect(due({ startMinute: 690 }, noon, 60).kind).toBe('due');
  });

  it('is MISSED past the grace window rather than firing hours late', () => {
    // Disarming a building at noon because a 07:00 schedule was missed would lower
    // protection at a time nobody chose.
    const verdict = due({ startMinute: 420 }, noon, 60);

    expect(verdict.kind).toBe('missed');
    expect(verdict.kind === 'missed' && verdict.lateByMinutes).toBe(300);
  });

  it('is idle once it has fired for this local date', () => {
    // The restart- and overlap-safety property, keyed on local date so it survives a
    // DST change.
    expect(due({ startMinute: 720, lastFiredFor: '2026-08-14' }, noon).kind).toBe('idle');
  });

  it('becomes due again on the next local date', () => {
    expect(due({ startMinute: 720, lastFiredFor: '2026-08-13' }, noon).kind).toBe('due');
  });

  it('ignores a disabled schedule entirely', () => {
    expect(due({ enabled: false, startMinute: 720 }, noon).kind).toBe('idle');
  });

  it('treats an empty day list as every day', () => {
    expect(due({ daysOfWeek: [], startMinute: 720 }, noon).kind).toBe('due');
  });

  it('respects a day list', () => {
    // 2026-08-14 is a Friday (5).
    expect(due({ daysOfWeek: [5], startMinute: 720 }, noon).kind).toBe('due');
    expect(due({ daysOfWeek: [0, 6], startMinute: 720 }, noon).kind).toBe('idle');
  });

  it('does not wrap the grace window past local midnight', () => {
    // A 23:50 boundary missed until 00:30 stays missed. Arming a building half an hour
    // into the next day would read as a malfunction, and firing on the wrong date would
    // also consume tomorrow's slot.
    const justAfterMidnight = localNow(new Date('2026-08-15T00:30:00Z'), 'UTC');

    expect(due({ startMinute: 23 * 60 + 50 }, justAfterMidnight, 60).kind).toBe('idle');
  });
});

describe('seedLastFiredFor', () => {
  it('stamps today when the boundary has already passed', () => {
    // A schedule created at 14:00 saying "arm at 08:00" did not exist this morning and
    // must not report that it missed.
    const local = localNow(new Date('2026-08-14T14:00:00Z'), 'UTC');

    expect(seedLastFiredFor(8 * 60, local)).toBe('2026-08-14');
  });

  it('leaves it unset when the boundary is still ahead, so it fires today', () => {
    const local = localNow(new Date('2026-08-14T06:00:00Z'), 'UTC');

    expect(seedLastFiredFor(8 * 60, local)).toBeNull();
  });

  it('stamps when created exactly on the boundary minute', () => {
    const local = localNow(new Date('2026-08-14T08:00:00Z'), 'UTC');

    expect(seedLastFiredFor(8 * 60, local)).toBe('2026-08-14');
  });
});
