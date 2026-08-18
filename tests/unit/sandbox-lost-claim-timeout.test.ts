import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A lost boot-claim must not create a second VM.
 *
 * `ensureSandbox` waits for an in-flight boot, then `claimBoot` CAS-es the row to
 * BOOTING so exactly one caller creates a sandbox. If this replica loses the claim,
 * it waits again (~90s) for the winner. The defect: when that wait returned null
 * (timeout — the other boot was still going, or this replica never saw READY), the
 * loser fell through into `bootProject` anyway. That is a real bill: sandbox minutes
 * are metered (`Workspace.sandboxMinutesUsed` / `Plan.monthlySandboxMinutes`), the
 * second `sandboxId` overwrites the first, and the first VM is orphaned until the
 * idle reaper finds it — if it ever does.
 *
 * Goes red if the fallthrough comes back: `createSandbox` is called after a lost
 * claim, and the caller is not told the workspace is still starting.
 *
 * Prisma and the driver factory are stubbed. No provider SDK is imported and no
 * VM is created.
 */

const createSandbox = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error('driver create must not run in this suite');
  }),
);

const db = vi.hoisted(() => ({
  checkpointFindFirst: vi.fn(),
  projectFindFirst: vi.fn(),
  projectUpdate: vi.fn(),
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
      checkpoint: { findFirst: db.checkpointFindFirst },
      project: {
        findFirst: db.projectFindFirst,
        update: db.projectUpdate,
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
    id: 'cfg_lost_claim',
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
    id: 'cfg_lost_claim',
    driver: 'e2b',
    consecutiveFails: 0,
  }),
  listProviderConfigs: async () => [],
  updateProviderConfig: async () => undefined,
}));

vi.mock('@/lib/sandbox/factory', () => ({
  SandboxFactory: {
    fromRow: () => ({
      createSandbox,
      getSandboxUrl: () => 'https://example.com/sbx',
      getSandboxInfo: () => ({ sandboxId: 'sbx_stub', url: 'https://example.com/sbx' }),
      setupViteApp: async () => undefined,
      installAndStartDev: async () => undefined,
      writeFile: async () => undefined,
      terminate: async () => undefined,
      reconnect: async () => false,
    }),
    create: () => ({
      createSandbox,
      reconnect: async () => false,
    }),
  },
}));

const { ensureSandbox, SandboxBootError } = await import('@/lib/sandbox/manager.ts');

const LOST_CLAIM_TIMEOUT = 'The workspace is still starting. Try again.';

function projectRow(input: { id: string; status: 'NONE' | 'BOOTING' }) {
  return {
    id: input.id,
    stack: 'NEXTJS' as const,
    sandboxId: null,
    previewUrl: null,
    sandboxStatus: input.status,
    sandboxStartedAt: input.status === 'BOOTING' ? new Date() : null,
    previewMode: 'STATIC' as const,
    activeJobId: null,
    lastCode: '',
  };
}

/**
 * First wait sees NONE (not already booting here). The claim transaction is the
 * second `findFirst` and is the only one that reports a fresh BOOTING — so this
 * replica loses. The wait after that sees NONE again, which is the same `null`
 * the 90s ready-poll returns on timeout. The loser must stop there.
 */
function loseClaimThenWaitReturnsNull(projectId: string) {
  let finds = 0;
  db.projectFindFirst.mockImplementation(async () => {
    finds += 1;
    return projectRow({ id: projectId, status: finds === 2 ? 'BOOTING' : 'NONE' });
  });
}

function alwaysIdle(projectId: string) {
  db.projectFindFirst.mockResolvedValue(projectRow({ id: projectId, status: 'NONE' }));
}

beforeEach(() => {
  createSandbox.mockClear();
  db.checkpointFindFirst.mockReset();
  db.projectFindFirst.mockReset();
  db.projectUpdate.mockReset();
  db.projectCount.mockReset();
  db.queryRaw.mockReset();
  db.executeRaw.mockReset();

  db.checkpointFindFirst.mockResolvedValue(null);
  db.projectUpdate.mockResolvedValue({});
  db.projectCount.mockResolvedValue(0);
  db.queryRaw.mockResolvedValue([]);
  db.executeRaw.mockResolvedValue(1);
});

afterEach(() => {
  createSandbox.mockClear();
});

describe('ensureSandbox after a lost claim', () => {
  it('does not create a sandbox when the wait then returns null', async () => {
    const projectId = 'proj_lost_claim_timeout';
    loseClaimThenWaitReturnsNull(projectId);

    const error = await ensureSandbox(projectId, { allowEmpty: true }).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(SandboxBootError);
    if (!(error instanceof SandboxBootError)) return;
    expect(error.step).toBe('ready');
    expect(error.message).toBe(LOST_CLAIM_TIMEOUT);
    expect(error.message.toLowerCase()).not.toContain('boot failed');
    // The billable step. If the loser falls through, this is called and we pay twice.
    expect(createSandbox).not.toHaveBeenCalled();
  });

  it('a genuine cold boot still reaches the driver create', async () => {
    const projectId = 'proj_lost_claim_cold';
    alwaysIdle(projectId);

    await expect(ensureSandbox(projectId, { allowEmpty: true })).rejects.toBeInstanceOf(
      SandboxBootError,
    );
    expect(createSandbox).toHaveBeenCalledTimes(1);
  });

  it('concurrent callers still share a single boot attempt', async () => {
    const projectId = 'proj_lost_claim_coalesce';
    alwaysIdle(projectId);

    const first = ensureSandbox(projectId, { allowEmpty: true });
    const second = ensureSandbox(projectId, { allowEmpty: true });
    const [a, b] = await Promise.all([
      first.catch((error: unknown) => error),
      second.catch((error: unknown) => error),
    ]);

    expect(a).toBeInstanceOf(SandboxBootError);
    expect(b).toBe(a);
    expect(createSandbox).toHaveBeenCalledTimes(1);
  });
});
