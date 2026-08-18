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
    const value = '2026-08-18T01:00:00.000Z';
    const snapshot = Date.parse('2026-08-18T01:28:00.000Z');
    const originalTz = process.env.TZ;

    process.env.TZ = 'America/Los_Angeles';
    const west = formatRelativeTime(value, snapshot);
    process.env.TZ = 'Asia/Kolkata';
    const east = formatRelativeTime(value, snapshot);
    process.env.TZ = originalTz;

    expect(west).toBe(east);
    expect(west).toBe('28 minutes ago');
  });
});
