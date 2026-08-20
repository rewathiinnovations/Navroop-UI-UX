import { describe, expect, it, vi } from 'vitest';
import {
  ADMIN_DATE_EMPTY,
  formatAdminDate,
  formatAdminDateTime,
} from '../../app/(app)/admin/format-admin-date';

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

  it('prints the admin no-value placeholder, not a blank cell, when there is no date', () => {
    expect(ADMIN_DATE_EMPTY).toBe('—');
    expect(formatAdminDateTime('not-a-date')).toBe(ADMIN_DATE_EMPTY);
    expect(formatAdminDateTime(null)).toBe(ADMIN_DATE_EMPTY);
    expect(formatAdminDateTime(undefined)).toBe(ADMIN_DATE_EMPTY);
    expect(formatAdminDateTime('')).toBe(ADMIN_DATE_EMPTY);
  });

  it('lets a caller substitute its own wording for an absent date', () => {
    expect(formatAdminDateTime(null, 'never')).toBe('never');
  });
});

describe('formatAdminDate', () => {
  it('passes an explicit locale so SSR and the browser cannot disagree', () => {
    const spy = vi.spyOn(Date.prototype, 'toLocaleDateString');
    formatAdminDate(new Date(2026, 7, 17));
    expect(spy.mock.calls[0]?.[0]).toBe('en-US');
    spy.mockRestore();
  });

  it('prints the admin no-value placeholder, not a blank cell, when there is no date', () => {
    expect(formatAdminDate('not-a-date')).toBe(ADMIN_DATE_EMPTY);
    expect(formatAdminDate(null)).toBe(ADMIN_DATE_EMPTY);
  });

  it('lets a caller substitute its own wording for an absent date', () => {
    expect(formatAdminDate(undefined, 'unknown')).toBe('unknown');
  });
});
