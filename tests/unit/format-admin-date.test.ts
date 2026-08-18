import { describe, expect, it, vi } from 'vitest';
import { formatAdminDate, formatAdminDateTime } from '../../app/(app)/admin/format-admin-date';

describe('formatAdminDateTime', () => {
  it('passes an explicit locale so SSR and the browser cannot disagree', () => {
    const spy = vi.spyOn(Date.prototype, 'toLocaleString');
    formatAdminDateTime(new Date(2026, 7, 17, 23, 17, 39));
    expect(spy.mock.calls[0]?.[0]).toBe('en-US');
    spy.mockRestore();
  });

  it('matches the pinned en-US absolute timestamp, not the host locale', () => {
    const date = new Date(2026, 7, 17, 23, 17, 39);
    const options = {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    } as const;
    const us = date.toLocaleString('en-US', options);
    const gb = date.toLocaleString('en-GB', options);
    expect(us).not.toBe(gb);
    expect(formatAdminDateTime(date)).toBe(us);
    expect(formatAdminDateTime(date)).not.toBe(gb);
    expect(formatAdminDateTime(date)).toMatch(/^8\/17\/2026/);
  });

  it('returns an empty string for invalid values', () => {
    expect(formatAdminDateTime('not-a-date')).toBe('');
    expect(formatAdminDateTime(null)).toBe('');
  });
});

describe('formatAdminDate', () => {
  it('passes an explicit locale so SSR and the browser cannot disagree', () => {
    const spy = vi.spyOn(Date.prototype, 'toLocaleDateString');
    formatAdminDate(new Date(2026, 7, 17));
    expect(spy.mock.calls[0]?.[0]).toBe('en-US');
    spy.mockRestore();
  });

  it('returns an empty string for invalid values', () => {
    expect(formatAdminDate('not-a-date')).toBe('');
  });
});
