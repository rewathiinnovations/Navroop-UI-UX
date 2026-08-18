import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Both of these used to be `prisma.appSetting.delete(...).catch(() => undefined)`. That hid the
 * ordinary case (no alert row to clear) together with a genuine write failure, and a genuine
 * failure leaves a stale "backups are failing" / "integrations are failing" banner up on an
 * otherwise healthy system. `deleteMany` removes the not-found noise so the remaining errors are
 * real, and they are logged and reported instead of dropped.
 */

const deleteMany = vi.fn();
const upsert = vi.fn().mockResolvedValue({});
const findMany = vi.fn().mockResolvedValue([]);

vi.mock('@/lib/db', () => ({
  prisma: {
    appSetting: {
      deleteMany: (...args: unknown[]) => deleteMany(...args),
      upsert: (...args: unknown[]) => upsert(...args),
    },
    integration: { update: vi.fn().mockResolvedValue({}) },
    user: { findMany: (...args: unknown[]) => findMany(...args) },
  },
}));

// Every integration reads as "not connected", so `checkAllIntegrations` takes the clear branch
// without any network access.
vi.mock('@/lib/integrations/store', () => ({
  getIntegration: async () => null,
  invalidateIntegrationCache: () => undefined,
}));

let lines: string[];

beforeEach(() => {
  deleteMany.mockReset();
  lines = [];
  const capture = (...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  };
  vi.spyOn(console, 'error').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('clearBackupAlert', () => {
  it('succeeds when there was no alert row to clear', async () => {
    deleteMany.mockResolvedValue({ count: 0 });
    const { clearBackupAlert } = await import('@/lib/backup/alerts');

    await expect(clearBackupAlert()).resolves.toEqual({ cleared: true });
    expect(deleteMany).toHaveBeenCalledWith({ where: { key: 'backup.alert' } });
    expect(lines).toEqual([]);
  });

  it('logs and reports when the alert row cannot be cleared', async () => {
    deleteMany.mockRejectedValue(new Error('connection reset'));
    const { clearBackupAlert } = await import('@/lib/backup/alerts');

    const result = await clearBackupAlert();

    expect(result.cleared).toBe(false);
    expect(lines.join(' ')).toContain('could not clear the backup alert');
    expect(lines.join(' ')).toContain('connection reset');
  });
});

describe('checkAllIntegrations alert clear', () => {
  it('reports the alert cleared when nothing is failing', async () => {
    deleteMany.mockResolvedValue({ count: 1 });
    const { checkAllIntegrations } = await import('@/lib/integrations/health');

    const result = await checkAllIntegrations();

    expect(result.failures).toEqual([]);
    expect(result.alertCleared).toBe(true);
  });

  it('logs and reports when the alert row cannot be cleared', async () => {
    deleteMany.mockRejectedValue(new Error('connection reset'));
    const { checkAllIntegrations } = await import('@/lib/integrations/health');

    const result = await checkAllIntegrations();

    expect(result.alertCleared).toBe(false);
    expect(lines.join(' ')).toContain('integrations.health.alert_clear_failed');
  });
});
