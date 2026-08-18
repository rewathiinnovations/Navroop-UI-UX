import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A FAILED sandbox row must be retryable, and a live BOOTING claim must not be
 * stealable just because a waiter gave up.
 *
 * After honesty landed, many more boots end FAILED (install, missing preview URL,
 * poll timeout). The old wait threw that failure before `claimBoot`, so every later
 * `ensureSandbox` replayed the last error and never created again — the opposite of
 * the "try again" copy. A careless fix that skips `claimBoot` / inflight coalescing
 * would bill a second VM while the first boot is still running.
 *
 * Prisma and the driver factory are stubbed. No provider SDK is imported and no
 * VM is created.
 */

const createSandbox = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error('driver create must not run in this suite');
  }),
);

const accrueProjectSandboxMinutes = vi.hoisted(() => vi.fn(async () => ({ minutes: 0 })));
const accrueProviderUsage = vi.hoisted(() => vi.fn(async () => ({ minutes: 0, spendUsd: 0 })));
const checkSandboxMinutes = vi.hoisted(() => vi.fn(async () => ({ ok: true as const })));

const db = vi.hoisted(() => ({
  checkpointFindFirst: vi.fn(),
  checkpointCount: vi.fn(),
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
      checkpoint: { findFirst: db.checkpointFindFirst, count: db.checkpointCount },
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
  checkSandboxMinutes,
  accrueProjectSandboxMinutes,
}));

vi.mock('@/lib/sandbox/accounting', () => ({
  rollAllProviderPeriods: async () => undefined,
  accrueProviderUsage,
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
    id: 'cfg_retry',
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
    id: 'cfg_retry',
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

const {
  ensureSandbox,
  getSandboxStatus,
  SandboxBootError,
  BOOT_WAIT_MS,
  BOOT_CLAIM_FRESH_MS,
} = await import('@/lib/sandbox/manager.ts');
const { SANDBOX_MINUTES_EXHAUSTED } = await import('@/lib/sandbox/minutes.ts');
const { JOB_TIMEOUT_MS } = await import('@/lib/jobs/poll.ts');
const { CIRCUIT_COOLDOWN_MS } = await import('@/lib/sandbox/health.ts');

const LOST_CLAIM_TIMEOUT = 'The workspace is still starting. Try again.';

function projectRow(input: {
  id: string;
  status: 'NONE' | 'BOOTING' | 'FAILED';
  sandboxStartedAt?: Date | null;
}) {
  return {
    id: input.id,
    stack: 'NEXTJS' as const,
    sandboxId: null,
    previewUrl: null,
    sandboxStatus: input.status,
    sandboxStartedAt:
      input.sandboxStartedAt !== undefined
        ? input.sandboxStartedAt
        : input.status === 'BOOTING'
          ? new Date()
          : null,
    previewMode: 'STATIC' as const,
    activeJobId: null,
    lastCode: '',
  };
}

beforeEach(() => {
  createSandbox.mockReset();
  createSandbox.mockImplementation(async () => {
    throw new Error('driver create must not run in this suite');
  });
  accrueProjectSandboxMinutes.mockReset();
  accrueProjectSandboxMinutes.mockResolvedValue({ minutes: 0 });
  accrueProviderUsage.mockReset();
  accrueProviderUsage.mockResolvedValue({ minutes: 0, spendUsd: 0 });
  checkSandboxMinutes.mockReset();
  checkSandboxMinutes.mockResolvedValue({ ok: true });

  db.checkpointFindFirst.mockReset();
  db.checkpointCount.mockReset();
  db.projectFindFirst.mockReset();
  db.projectUpdate.mockReset();
  db.projectCount.mockReset();
  db.queryRaw.mockReset();
  db.executeRaw.mockReset();

  db.checkpointFindFirst.mockResolvedValue(null);
  db.checkpointCount.mockResolvedValue(0);
  db.projectUpdate.mockResolvedValue({});
  db.projectCount.mockResolvedValue(0);
  db.queryRaw.mockResolvedValue([]);
  db.executeRaw.mockResolvedValue(1);
});

afterEach(() => {
  vi.useRealTimers();
  createSandbox.mockReset();
});

describe('a FAILED row can boot again', () => {
  it('reaches driver create instead of replaying the last failure', async () => {
    const projectId = 'proj_failed_retry';
    db.projectFindFirst.mockResolvedValue(projectRow({ id: projectId, status: 'FAILED' }));

    await expect(ensureSandbox(projectId, { allowEmpty: true })).rejects.toBeInstanceOf(
      SandboxBootError,
    );

    expect(createSandbox).toHaveBeenCalledTimes(1);
  });

  it('keeps the last honest error on the FAILED row until a new attempt finishes', async () => {
    const projectId = 'proj_failed_error_kept';
    db.projectFindFirst.mockResolvedValue(projectRow({ id: projectId, status: 'NONE' }));

    await expect(ensureSandbox(projectId, { allowEmpty: true })).rejects.toMatchObject({
      message: 'driver create must not run in this suite',
    });

    db.projectFindFirst.mockResolvedValue(projectRow({ id: projectId, status: 'FAILED' }));
    const status = await getSandboxStatus(projectId);
    expect(status?.status).toBe('FAILED');
    expect(status?.error).toBe('driver create must not run in this suite');

    await expect(ensureSandbox(projectId, { allowEmpty: true })).rejects.toBeInstanceOf(
      SandboxBootError,
    );
    expect(createSandbox).toHaveBeenCalledTimes(2);

    const after = await getSandboxStatus(projectId);
    expect(after?.error).toBe('driver create must not run in this suite');
  });

  it('re-checks a permanent minutes denial and does not create a VM', async () => {
    const projectId = 'proj_failed_minutes';
    db.projectFindFirst.mockResolvedValue(projectRow({ id: projectId, status: 'FAILED' }));
    checkSandboxMinutes.mockResolvedValue({
      ok: false,
      used: 300,
      limit: 300,
      message: SANDBOX_MINUTES_EXHAUSTED,
    });

    const error = await ensureSandbox(projectId, { allowEmpty: true }).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(SandboxBootError);
    if (!(error instanceof SandboxBootError)) return;
    expect(error.code).toBe('SANDBOX_MINUTES');
    expect(error.message).toBe(SANDBOX_MINUTES_EXHAUSTED);
    expect(checkSandboxMinutes).toHaveBeenCalled();
    expect(createSandbox).not.toHaveBeenCalled();
  });
});

describe('retry while a boot is in flight', () => {
  it('does not create a second VM when two callers retry a FAILED row', async () => {
    const projectId = 'proj_failed_coalesce';
    db.projectFindFirst.mockResolvedValue(projectRow({ id: projectId, status: 'FAILED' }));

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

  it('joins the in-flight boot instead of claiming a rival after the first retry has started', async () => {
    const projectId = 'proj_failed_inflight';
    db.projectFindFirst.mockResolvedValue(projectRow({ id: projectId, status: 'FAILED' }));

    let release!: (error: Error) => void;
    createSandbox.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          release = reject;
        }),
    );

    const first = ensureSandbox(projectId, { allowEmpty: true });
    await vi.waitFor(() => expect(createSandbox).toHaveBeenCalledTimes(1));

    const second = ensureSandbox(projectId, { allowEmpty: true });
    release(new Error('driver create must not run in this suite'));

    const [a, b] = await Promise.all([
      first.catch((error: unknown) => error),
      second.catch((error: unknown) => error),
    ]);

    expect(a).toBeInstanceOf(SandboxBootError);
    expect(b).toBe(a);
    expect(createSandbox).toHaveBeenCalledTimes(1);
  });
});

describe('boot wait timeout is not claim freshness', () => {
  it('uses a longer freshness window than the waiter, below the job timeout', () => {
    const managerSource = readFileSync(join(process.cwd(), 'lib/sandbox/manager.ts'), 'utf8');
    expect(BOOT_CLAIM_FRESH_MS).toBeGreaterThan(BOOT_WAIT_MS);
    expect(BOOT_WAIT_MS).toBe(90_000);
    expect(BOOT_CLAIM_FRESH_MS).toBe(CIRCUIT_COOLDOWN_MS);
    expect(BOOT_CLAIM_FRESH_MS).toBeLessThan(JOB_TIMEOUT_MS);
    expect(managerSource).toMatch(
      /Date\.now\(\) - row\.sandboxStartedAt\.getTime\(\) < BOOT_CLAIM_FRESH_MS/,
    );
    expect(managerSource).toMatch(/const deadline = Date\.now\(\) \+ BOOT_WAIT_MS/);
    expect(managerSource).not.toMatch(
      /sandboxStartedAt\.getTime\(\) < READY_POLL_MS/,
    );
  });

  it('does not create a second VM when the winner is still BOOTING after the wait timeout', async () => {
    vi.useFakeTimers();
    const projectId = 'proj_booting_still_fresh';
    const startedAt = new Date();
    db.projectFindFirst.mockResolvedValue(
      projectRow({ id: projectId, status: 'BOOTING', sandboxStartedAt: startedAt }),
    );

    const pending = ensureSandbox(projectId, { allowEmpty: true }).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    // Waiter times out, claimBoot refuses (still fresh), waiter runs again, then throws.
    await vi.advanceTimersByTimeAsync(2 * BOOT_WAIT_MS + 5_000);
    const error = await pending;

    expect(error).toBeInstanceOf(SandboxBootError);
    if (!(error instanceof SandboxBootError)) return;
    expect(error.message).toBe(LOST_CLAIM_TIMEOUT);
    expect(createSandbox).not.toHaveBeenCalled();
  }, 15_000);

  it('can claim a stale BOOTING row and accounts the abandoned attempt first', async () => {
    vi.useFakeTimers();
    const projectId = 'proj_booting_stale';
    const startedAt = new Date(Date.now() - BOOT_CLAIM_FRESH_MS - 1_000);
    db.projectFindFirst.mockResolvedValue(
      projectRow({ id: projectId, status: 'BOOTING', sandboxStartedAt: startedAt }),
    );

    const pending = ensureSandbox(projectId, { allowEmpty: true }).then(
      () => null,
      () => undefined,
    );
    await vi.advanceTimersByTimeAsync(BOOT_WAIT_MS + 3_000);
    await pending;

    expect(accrueProjectSandboxMinutes).toHaveBeenCalled();
    expect(createSandbox).toHaveBeenCalledTimes(1);
  }, 15_000);
});
