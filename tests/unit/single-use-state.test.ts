import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An OAuth `state` row is what makes the nonce single-use. Deleting it with
 * `.catch(() => undefined)` meant a failed delete left the row alive for the rest of its
 * ten-minute TTL, so the same `state` could be replayed — silently. The flow now refuses
 * whenever it cannot prove it consumed the row.
 */

const deleteMany = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: { appSetting: { deleteMany: (...args: unknown[]) => deleteMany(...args) } },
}));

let consumeRow: typeof import('@/lib/integrations/single-use').consumeRow;
let lines: string[];

beforeEach(async () => {
  deleteMany.mockReset();
  lines = [];
  vi.spyOn(console, 'warn').mockImplementation((line: unknown) => lines.push(String(line)));
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => lines.push(String(line)));
  ({ consumeRow } = await import('@/lib/integrations/single-use'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('consumeRow', () => {
  it('accepts when it deleted exactly the row it read', async () => {
    deleteMany.mockResolvedValue({ count: 1 });
    await expect(consumeRow('k', 'v')).resolves.toBe(true);
    expect(deleteMany).toHaveBeenCalledWith({ where: { key: 'k', value: 'v' } });
  });

  it('refuses and logs when the row was already gone', async () => {
    deleteMany.mockResolvedValue({ count: 0 });
    await expect(consumeRow('k', 'v')).resolves.toBe(false);
    expect(lines.join(' ')).toContain('single_use_state_already_consumed');
  });

  it('refuses and logs when the delete fails, rather than proceeding on an unconsumed nonce', async () => {
    deleteMany.mockRejectedValue(new Error('deadlock detected'));
    await expect(consumeRow('k', 'v')).resolves.toBe(false);
    expect(lines.join(' ')).toContain('single_use_state_not_consumed');
    expect(lines.join(' ')).toContain('deadlock detected');
  });
});
