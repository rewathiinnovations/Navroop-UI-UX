import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `reconcileJobsAtBoot` is one of the four documented paths that abandon a job
 * (boot reconcile, the reaper, the SIGTERM drain, the client watchdog). It is the
 * one that recovers rows orphaned by a restart, and until 2026-08-21 no test
 * loaded it: `tests/unit/instrumentation-boot.test.ts` mocks `@/lib/jobs/boot`
 * out, so the once-only guard, the query and the catch never ran (F-660).
 *
 * That mock stays where it is — it is testing the boot *sequence*, not this
 * module. This file drives the real module with `./lifecycle` and the logger
 * stubbed, and takes a fresh copy per case so the module-level `ran` flag is not
 * shared between assertions.
 */

const lifecycle = vi.hoisted(() => ({ reconcileAbandonedJobs: vi.fn() }));
const logger = vi.hoisted(() => ({ warn: vi.fn(), logError: vi.fn() }));

vi.mock('@/lib/jobs/lifecycle', () => ({
  reconcileAbandonedJobs: lifecycle.reconcileAbandonedJobs,
}));
vi.mock('@/lib/logger', () => ({
  log: { warn: logger.warn },
  logError: logger.logError,
}));

/** A fresh module instance, so `ran` starts false for every case. */
async function freshBoot() {
  vi.resetModules();
  return import('@/lib/jobs/boot');
}

beforeEach(() => {
  lifecycle.reconcileAbandonedJobs.mockReset();
  logger.warn.mockReset();
  logger.logError.mockReset();
});

describe('reconcileJobsAtBoot', () => {
  it('runs the reconcile query and returns what it found', async () => {
    const result = { abandoned: [{ jobId: 'job_a' }, { jobId: 'job_b' }], legacyProjects: ['p_1'] };
    lifecycle.reconcileAbandonedJobs.mockResolvedValue(result);

    const { reconcileJobsAtBoot } = await freshBoot();
    await expect(reconcileJobsAtBoot()).resolves.toBe(result);

    expect(lifecycle.reconcileAbandonedJobs).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('jobs.boot_reconcile', {
      abandoned: 2,
      legacyProjects: 1,
    });
  });

  it('runs the query once per process however often boot calls it', async () => {
    lifecycle.reconcileAbandonedJobs.mockResolvedValue({ abandoned: [], legacyProjects: [] });

    const { reconcileJobsAtBoot } = await freshBoot();
    await reconcileJobsAtBoot();
    const second = await reconcileJobsAtBoot();
    const third = await reconcileJobsAtBoot();

    expect(second).toEqual({ skipped: true });
    expect(third).toEqual({ skipped: true });
    // The guard is the point: a second reconcile would race the runners that
    // have already claimed the rows the first pass left alone.
    expect(lifecycle.reconcileAbandonedJobs).toHaveBeenCalledTimes(1);
    // And the skipped calls must not log a reconcile that did not happen.
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('claims the run before awaiting, so two concurrent callers still query once', async () => {
    lifecycle.reconcileAbandonedJobs.mockResolvedValue({ abandoned: [], legacyProjects: [] });

    const { reconcileJobsAtBoot } = await freshBoot();
    const [first, second] = await Promise.all([reconcileJobsAtBoot(), reconcileJobsAtBoot()]);

    expect([first, second]).toContainEqual({ skipped: true });
    expect(lifecycle.reconcileAbandonedJobs).toHaveBeenCalledTimes(1);
  });

  it('starts unguarded in a new process', async () => {
    lifecycle.reconcileAbandonedJobs.mockResolvedValue({ abandoned: [], legacyProjects: [] });

    const first = await freshBoot();
    await first.reconcileJobsAtBoot();
    expect(await first.reconcileJobsAtBoot()).toEqual({ skipped: true });

    // Without this the guard case above would also pass on a module that always
    // returns `{ skipped: true }`.
    const second = await freshBoot();
    expect(await second.reconcileJobsAtBoot()).not.toEqual({ skipped: true });
    expect(lifecycle.reconcileAbandonedJobs).toHaveBeenCalledTimes(2);
  });

  it('reports a failing reconcile instead of rejecting into boot', async () => {
    // Postgres unavailable at the moment the app boots. A rejection here escapes
    // `register()` and Next refuses to serve at all; stale job rows are strictly
    // better than a dead server.
    const failure = new Error('connect ECONNREFUSED 127.0.0.1:5432');
    lifecycle.reconcileAbandonedJobs.mockRejectedValue(failure);

    const { reconcileJobsAtBoot } = await freshBoot();
    await expect(reconcileJobsAtBoot()).resolves.toEqual({
      abandoned: [],
      legacyProjects: [],
      error: true,
    });

    expect(logger.logError).toHaveBeenCalledWith('jobs.boot_reconcile_failed', failure);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('stays guarded after a failure, so a broken database is not retried on every call', async () => {
    lifecycle.reconcileAbandonedJobs.mockRejectedValue(new Error('down'));

    const { reconcileJobsAtBoot } = await freshBoot();
    await reconcileJobsAtBoot();
    expect(await reconcileJobsAtBoot()).toEqual({ skipped: true });
    expect(lifecycle.reconcileAbandonedJobs).toHaveBeenCalledTimes(1);
  });
});
