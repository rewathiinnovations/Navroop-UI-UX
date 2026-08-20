import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatRelativeTime } from '../../lib/format-relative-time';

describe('formatRelativeTime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses a frozen now so two renders stay identical even if the clock moves', () => {
    const value = '2026-08-18T01:55:32.442Z';
    const snapshot = Date.parse('2026-08-18T02:33:28.442Z');
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-18T02:34:32.442Z'));

    expect(formatRelativeTime(value, snapshot)).toBe('38 minutes ago');
    expect(formatRelativeTime(value, snapshot)).toBe(formatRelativeTime(value, snapshot));
  });

  it('same input and frozen now produce the same string in different timezones', () => {
    // The pair has to straddle a local calendar boundary in one zone and not the
    // other, or the case cannot fail: with the old 01:00Z/01:28Z fixture both zones
    // landed on a single local date, so even a formatter that read the zone
    // (`toDateString`, "yesterday at …") returned the same string in both and the
    // equality held for the wrong reason (F-619). 06:40Z is Aug 17 23:40 in Los
    // Angeles and Aug 18 12:10 in Kolkata, and the snapshot 28 minutes later crosses
    // midnight only in the west.
    const value = '2026-08-18T06:40:00.000Z';
    const snapshot = Date.parse('2026-08-18T07:08:00.000Z');
    const originalTz = process.env.TZ;

    process.env.TZ = 'America/Los_Angeles';
    const west = formatRelativeTime(value, snapshot);
    process.env.TZ = 'Asia/Kolkata';
    const east = formatRelativeTime(value, snapshot);
    process.env.TZ = originalTz;

    expect(west).toBe(east);
    expect(west).toBe('28 minutes ago');
  });

  /**
   * F-765: a future timestamp made `seconds` negative and fell into the `< 45`
   * branch, so a row ten days ahead read "just now" forever — and, because the
   * dashboard buckets by the same value, sorted to the top of "Last 14 days".
   * Clock skew between the database host and the app has to be visible.
   */
  it('names a future timestamp instead of absorbing it into "just now"', () => {
    const now = Date.parse('2026-08-20T12:00:00.000Z');
    expect(formatRelativeTime(new Date(now + 10 * 86_400_000), now)).toBe('in the future');
    expect(formatRelativeTime(new Date(now + 5 * 60_000), now)).toBe('in the future');
  });

  it('still reads "just now" for the sub-second skew every clock has', () => {
    const now = Date.parse('2026-08-20T12:00:00.000Z');
    expect(formatRelativeTime(new Date(now + 900), now)).toBe('just now');
    expect(formatRelativeTime(new Date(now + 30_000), now)).toBe('just now');
    expect(formatRelativeTime(new Date(now), now)).toBe('just now');
  });
});
