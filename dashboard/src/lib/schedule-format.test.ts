import { describeDays, formatStartMinute, parseStartMinute } from '@cpe310/contracts';
import { describe, expect, it } from 'vitest';

/**
 * The schedule time helpers live in the shared contracts package so the hub and the
 * dashboard cannot disagree about what "22:00" means, but contracts has no runner of
 * its own — so they are exercised from here, where one does exist.
 */

describe('formatStartMinute', () => {
  it('pads both halves so the list column stays aligned', () => {
    expect(formatStartMinute(0)).toBe('00:00');
    expect(formatStartMinute(9 * 60 + 5)).toBe('09:05');
    expect(formatStartMinute(22 * 60)).toBe('22:00');
    expect(formatStartMinute(1439)).toBe('23:59');
  });
});

describe('parseStartMinute', () => {
  it('accepts what a time input produces', () => {
    expect(parseStartMinute('22:00')).toBe(1320);
    expect(parseStartMinute('00:00')).toBe(0);
    expect(parseStartMinute('9:05')).toBe(545);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseStartMinute('  07:30 ')).toBe(450);
  });

  it('rejects an impossible time rather than wrapping it', () => {
    // 25:00 silently becoming 01:00 the next day is exactly the kind of quiet
    // reinterpretation that makes a schedule fire when nobody expected it.
    expect(parseStartMinute('25:00')).toBeNull();
    expect(parseStartMinute('12:60')).toBeNull();
  });

  it('rejects anything that is not a time', () => {
    expect(parseStartMinute('')).toBeNull();
    expect(parseStartMinute('22')).toBeNull();
    expect(parseStartMinute('10pm')).toBeNull();
  });

  it('round-trips with formatStartMinute', () => {
    for (const minute of [0, 1, 545, 720, 1320, 1439]) {
      expect(parseStartMinute(formatStartMinute(minute))).toBe(minute);
    }
  });
});

describe('describeDays', () => {
  it('treats empty and all-seven alike, because both mean every day', () => {
    expect(describeDays([])).toBe('Every day');
    expect(describeDays([0, 1, 2, 3, 4, 5, 6])).toBe('Every day');
  });

  it('names the common patterns rather than listing them', () => {
    expect(describeDays([1, 2, 3, 4, 5])).toBe('Weekdays');
    expect(describeDays([0, 6])).toBe('Weekends');
  });

  it('lists anything else in week order regardless of input order', () => {
    expect(describeDays([5, 1])).toBe('Mon, Fri');
  });
});
