import { afterEach, describe, expect, it, vi } from 'vitest';

// `beginJobHeartbeat` lives in lib/jobs/lifecycle, which pulls Prisma and the publish
// compensation chain at module scope. The heartbeat itself only needs `updateJobFields`,
// so everything else is stubbed out.
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/jobs/compensate-publish', () => ({ compensateAbandonedPublish: vi.fn() }));
vi.mock('@/lib/jobs/store', () => ({
  claimJobCreditCharge: vi.fn(),
  findJobByIdempotency: vi.fn(),
  getActiveJob: vi.fn(),
  getJob: vi.fn(),
  insertJobRaw: vi.fn(),
  listLegacyStuckProjects: vi.fn(),
  listReconcileCandidates: vi.fn(),
  listTimeoutCandidates: vi.fn(),
  releaseJobCreditCharge: vi.fn(),
  setProjectActiveJob: vi.fn(),
  setProjectResumablePhase: vi.fn(),
  updateJobFields: vi.fn(),
  updateJobIfActive: vi.fn(),
}));

import { beginJobHeartbeat } from '@/lib/jobs/lifecycle';
import { updateJobFields } from '@/lib/jobs/store';

const updateJobFieldsMock = vi.mocked(updateJobFields);

afterEach(() => {
  vi.useRealTimers();
  updateJobFieldsMock.mockReset();
});

/**
 * F-022: the heartbeat write is the one place that already observes the row every 10s.
 * When it sees the row gone or no longer QUEUED/RUNNING — Cancel / Start over settled it —
 * `onInactive` fires so the caller can abort the in-flight provider stream, then the
 * heartbeat stops itself.
 */
describe('beginJobHeartbeat onInactive (F-022)', () => {
  it('fires once when a heartbeat write observes the row settled, then stops beating', async () => {
    vi.useFakeTimers();
    updateJobFieldsMock.mockResolvedValue({ id: 'job_1', status: 'CANCELLED' } as never);
    const onInactive = vi.fn();
    const heartbeat = beginJobHeartbeat('job_1', { intervalMs: 10, onInactive });
    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(updateJobFieldsMock).toHaveBeenCalledTimes(1);
      expect(onInactive).toHaveBeenCalledTimes(1);
      // The interval cleared itself: no further writes, no further callbacks.
      await vi.advanceTimersByTimeAsync(100);
      expect(updateJobFieldsMock).toHaveBeenCalledTimes(1);
      expect(onInactive).toHaveBeenCalledTimes(1);
    } finally {
      heartbeat.stop();
    }
  });

  it('does not fire while the row is still active', async () => {
    vi.useFakeTimers();
    updateJobFieldsMock.mockResolvedValue({ id: 'job_1', status: 'RUNNING' } as never);
    const onInactive = vi.fn();
    const heartbeat = beginJobHeartbeat('job_1', { intervalMs: 10, onInactive });
    try {
      await vi.advanceTimersByTimeAsync(30);
      expect(updateJobFieldsMock.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(onInactive).not.toHaveBeenCalled();
    } finally {
      heartbeat.stop();
    }
  });
});
