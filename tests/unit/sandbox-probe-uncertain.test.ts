import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Reconnect is now a three-way contract: false = gone, throw = uncertain,
 * true = attached with a real preview URL. `probeExisting` used to treat
 * every miss as gone (`return null` → DEAD → create). An uncertain throw
 * must not write DEAD and must not create a second billable VM. A post-claim
 * throw must restore READY so the row is not stuck BOOTING for 10 minutes.
 *
 * Prisma and the driver factory are stubbed. No provider SDK, no live VM.
 */

const createSandbox = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error('driver create must not run in this suite');
  }),
);

const reconnect = vi.hoisted(() => vi.fn(async () => false));
const getSandboxUrl = vi.hoisted(() => vi.fn(() => 'https://preview.example.test'));
const getSandboxInfo = vi.hoisted(() =>
  vi.fn(() => ({ sandboxId: 'sb-live-1', url: 'https://preview.example.test' })),
);

const db = vi.hoisted(() => ({
  checkpointFindFirst: vi.fn(),
  checkpointCount: vi.fn(),
  projectFindFirst: vi.fn(),
  projectUpdate: vi.fn(),
  projectUpdateMany: vi.fn(),
  projectCount: vi.fn(),
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
}));

vi.mock('@/lib/db', () => {
  const tx = {
    $executeRaw: db.executeRaw,
    project: { findFirst: db.projectFindFirst, update: db.projectUpdate },
  };
  return {
    prisma: {
      checkpoint: { findFirst: db.checkpointFindFirst, count: db.checkpointCount },
      project: {
        findFirst: db.projectFindFirst,
        update: db.projectUpdate,
        updateMany: db.projectUpdateMany,
        count: db.projectCount,
      },
      $queryRaw: db.queryRaw,
      $executeRaw: db.executeRaw,
      $transaction: (fn: (client: typeof tx) => unknown) => fn(tx),
    },
  };
});

vi.mock('@/lib/sandbox/migrate-env', () => ({ migrateEnvSandboxProvider: async () => undefined }));

vi.mock('@/lib/sandbox/meter', () => ({
  checkSandboxMinutes: async () => ({ ok: true }),
  accrueProjectSandboxMinutes: async () => undefined,
}));

vi.mock('@/lib/sandbox/accounting', () => ({
  rollAllProviderPeriods: async () => undefined,
  accrueProviderUsage: async () => undefined,
}));

vi.mock('@/lib/plans/limits', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/plans/limits')>();
  return {
    ...actual,
    getEffectivePlan: async () => ({ maxConcurrentSandboxes: -1 }),
  };
});

vi.mock('@/lib/sandbox/router', () => ({
  selectProvider: async () => ({
    id: 'cfg_probe',
    name: 'stub',
    driver: 'e2b',
    isActive: true,
    priority: 0,
    weight: 1,
    creditType: 'recurring_monthly',
    creditRemainingUsd: 1,
    creditTotalUsd: 1,
    monthlyBudgetUsd: null,
    monthlyMinutesLimit: null,
    minutesUsed: 0,
    spendUsd: 0,
    healthStatus: 'up',
    lastCheckedAt: null,
    consecutiveFails: 0,
    downUntil: null,
    periodStart: new Date(),
    creditResetsAt: null,
    config: {},
  }),
  toCandidate: (row: unknown) => row,
}));

vi.mock('@/lib/sandbox/store', () => ({
  getProviderConfig: async () => ({
    id: 'cfg_probe',
    driver: 'e2b',
    consecutiveFails: 0,
  }),
  listProviderConfigs: async () => [],
  updateProviderConfig: async () => undefined,
}));

vi.mock('@/lib/sandbox/factory', () => {
  const driver = () => ({
    createSandbox,
    getSandboxUrl,
    getSandboxInfo,
    setupViteApp: async () => undefined,
    installAndStartDev: async () => undefined,
    writeFile: async () => undefined,
    terminate: async () => undefined,
    reconnect,
  });
  return {
    SandboxFactory: {
      fromRow: driver,
      create: driver,
    },
  };
});

const { ensureSandbox, SandboxBootError } = await import('@/lib/sandbox/manager.ts');

function projectRow(input: {
  id: string;
  status: 'NONE' | 'BOOTING' | 'READY' | 'DEAD' | 'FAILED';
  sandboxId?: string | null;
  previewUrl?: string | null;
}) {
  return {
    id: input.id,
    stack: 'NEXTJS' as const,
    sandboxId: input.sandboxId === undefined ? 'sb-live-1' : input.sandboxId,
    previewUrl: input.previewUrl === undefined ? null : input.previewUrl,
    sandboxStatus: input.status,
    sandboxStartedAt: input.status === 'BOOTING' ? new Date() : null,
    previewMode: 'STATIC' as const,
    activeJobId: null,
    lastCode: '',
  };
}

function writtenStatuses(): string[] {
  return db.projectUpdate.mock.calls
    .map((call) => {
      const data = (call[0] as { data?: { sandboxStatus?: string } } | undefined)?.data;
      return data?.sandboxStatus;
    })
    .filter((status): status is string => typeof status === 'string');
}

beforeEach(() => {
  createSandbox.mockReset();
  createSandbox.mockImplementation(async () => {
    throw new Error('driver create must not run in this suite');
  });
  reconnect.mockReset();
  reconnect.mockResolvedValue(false);
  getSandboxUrl.mockReset();
  getSandboxUrl.mockReturnValue('https://preview.example.test');
  getSandboxInfo.mockReset();
  getSandboxInfo.mockReturnValue({ sandboxId: 'sb-live-1', url: 'https://preview.example.test' });

  db.checkpointFindFirst.mockReset();
  db.checkpointCount.mockReset();
  db.projectFindFirst.mockReset();
  db.projectUpdate.mockReset();
  db.projectUpdateMany.mockReset();
  db.projectCount.mockReset();
  db.queryRaw.mockReset();
  db.executeRaw.mockReset();

  db.checkpointFindFirst.mockResolvedValue(null);
  db.checkpointCount.mockResolvedValue(0);
  db.projectUpdate.mockResolvedValue({});
  db.projectUpdateMany.mockResolvedValue({ count: 1 });
  db.projectCount.mockResolvedValue(0);
  db.queryRaw.mockResolvedValue([]);
  db.executeRaw.mockResolvedValue(1);
});

afterEach(() => {
  createSandbox.mockReset();
  reconnect.mockReset();
});

describe('an uncertain probe must not mark the row DEAD and must not create a second VM', () => {
  it('does not write DEAD or create when reconnect throws after claimBoot, and restores READY', async () => {
    const projectId = 'proj_probe_uncertain_post_claim';
    // READY + leftover id, no preview URL: waitForInflightOrReady skips probe,
    // claimBoot writes BOOTING, then bootProject probes.
    db.projectFindFirst.mockResolvedValue(
      projectRow({ id: projectId, status: 'READY', sandboxId: 'sb-live-1', previewUrl: null }),
    );
    reconnect.mockRejectedValue(new Error('E2B probe timed out'));

    const error = await ensureSandbox(projectId, { allowEmpty: true }).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(SandboxBootError);
    if (!(error instanceof SandboxBootError)) return;
    expect(error.step).toBe('probe');
    expect(error.message).toBe('E2B probe timed out');
    expect(createSandbox).not.toHaveBeenCalled();
    const statuses = writtenStatuses();
    expect(statuses).toContain('BOOTING');
    expect(statuses).not.toContain('DEAD');
    expect(statuses).not.toContain('FAILED');
    expect(statuses.at(-1)).toBe('READY');
  });

  it('treats a true reconnect with no preview URL as uncertain — not gone', async () => {
    const projectId = 'proj_probe_missing_url';
    db.projectFindFirst.mockResolvedValue(
      projectRow({ id: projectId, status: 'READY', sandboxId: 'sb-live-1', previewUrl: null }),
    );
    reconnect.mockResolvedValue(true);
    getSandboxUrl.mockReturnValue('');
    getSandboxInfo.mockReturnValue({ sandboxId: 'sb-live-1', url: '' });

    const error = await ensureSandbox(projectId, { allowEmpty: true }).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(SandboxBootError);
    if (!(error instanceof SandboxBootError)) return;
    expect(error.step).toBe('probe');
    expect(createSandbox).not.toHaveBeenCalled();
    expect(writtenStatuses()).not.toContain('DEAD');
    expect(writtenStatuses().at(-1)).toBe('READY');
  });

  it('leaves a pre-claim READY row READY when the waiter probe throws — no claim, no create', async () => {
    const projectId = 'proj_probe_uncertain_pre_claim';
    db.projectFindFirst.mockResolvedValue(
      projectRow({
        id: projectId,
        status: 'READY',
        sandboxId: 'sb-live-1',
        previewUrl: 'https://preview.example.test',
      }),
    );
    reconnect.mockRejectedValue(new Error('tunnels timed out'));

    await expect(ensureSandbox(projectId)).rejects.toThrow('tunnels timed out');
    expect(createSandbox).not.toHaveBeenCalled();
    expect(writtenStatuses()).toEqual([]);
  });
});

describe('gone and attached stay the previous honest outcomes', () => {
  it('false (gone) still marks DEAD and may create a new VM', async () => {
    const projectId = 'proj_probe_gone';
    db.projectFindFirst.mockResolvedValue(
      projectRow({ id: projectId, status: 'READY', sandboxId: 'sb-gone', previewUrl: null }),
    );
    reconnect.mockResolvedValue(false);

    await expect(ensureSandbox(projectId, { allowEmpty: true })).rejects.toBeInstanceOf(
      SandboxBootError,
    );

    expect(writtenStatuses()).toContain('DEAD');
    expect(createSandbox).toHaveBeenCalledTimes(1);
  });

  it('true with a real preview URL reuses the VM and does not create', async () => {
    const projectId = 'proj_probe_attached';
    db.projectFindFirst.mockResolvedValue(
      projectRow({
        id: projectId,
        status: 'READY',
        sandboxId: 'sb-live-1',
        previewUrl: 'https://preview.example.test',
      }),
    );
    reconnect.mockResolvedValue(true);

    const result = await ensureSandbox(projectId);

    expect(result.sandboxId).toBe('sb-live-1');
    expect(result.previewUrl).toBe('https://preview.example.test');
    expect(result.wasColdStarted).toBe(false);
    expect(createSandbox).not.toHaveBeenCalled();
    expect(writtenStatuses()).not.toContain('DEAD');
    expect(writtenStatuses()).not.toContain('BOOTING');
  });
});
