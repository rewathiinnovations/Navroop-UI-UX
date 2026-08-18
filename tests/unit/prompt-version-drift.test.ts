import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Editing a stack prompt changes the assembled prefix hash. The active
 * PromptVersion row must roll to the new hash — before this, the stale row
 * stayed active and every generation after a prompt change was attributed to
 * the version that did not produce it.
 */

const prisma = vi.hoisted(() => ({
  promptVersion: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    count: vi.fn(),
  },
}));
vi.mock('@/lib/db', () => ({ prisma }));

describe('getActivePromptVersion under hash drift', () => {
  beforeEach(() => {
    for (const fn of Object.values(prisma.promptVersion)) fn.mockReset();
    prisma.promptVersion.updateMany.mockResolvedValue({ count: 1 });
  });

  it('keeps the active row while its hash matches the code', async () => {
    const { currentPromptHash, getActivePromptVersion } = await import('@/lib/prompts/version');
    const row = { id: 'pv1', hash: currentPromptHash(), label: 'v1 baseline', isActive: true };
    prisma.promptVersion.findFirst.mockResolvedValue(row);
    await expect(getActivePromptVersion()).resolves.toBe(row);
    expect(prisma.promptVersion.create).not.toHaveBeenCalled();
  });

  it('rolls to a new labeled version when the active hash is stale', async () => {
    const { currentPromptHash, getActivePromptVersion } = await import('@/lib/prompts/version');
    prisma.promptVersion.findFirst.mockResolvedValue({
      id: 'pv1',
      hash: 'stale-hash-from-before-the-edit',
      label: 'v1 baseline',
      isActive: true,
    });
    prisma.promptVersion.findUnique.mockResolvedValue(null);
    prisma.promptVersion.count.mockResolvedValue(1);
    prisma.promptVersion.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'pv2', ...data }),
    );

    const version = await getActivePromptVersion();
    expect(version.hash).toBe(currentPromptHash());
    expect(version.label).toBe('v2');
    expect(prisma.promptVersion.updateMany).toHaveBeenCalledWith({ data: { isActive: false } });
  });

  it('reactivates an existing row when the code rolls back to a known hash', async () => {
    const { currentPromptHash, getActivePromptVersion } = await import('@/lib/prompts/version');
    prisma.promptVersion.findFirst.mockResolvedValue({
      id: 'pv2',
      hash: 'some-newer-hash',
      label: 'v2',
      isActive: true,
    });
    const known = { id: 'pv1', hash: currentPromptHash(), label: 'v1 baseline', isActive: false };
    prisma.promptVersion.findUnique.mockResolvedValue(known);
    prisma.promptVersion.update.mockResolvedValue({ ...known, isActive: true });

    const version = await getActivePromptVersion();
    expect(version.id).toBe('pv1');
    expect(version.isActive).toBe(true);
    expect(prisma.promptVersion.create).not.toHaveBeenCalled();
  });
});
