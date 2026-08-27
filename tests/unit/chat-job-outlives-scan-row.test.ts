import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chatRecoveryVerdict } from '@/components/workspace/useGenerationJob';
import { showsChatRecovery } from '@/lib/jobs/chat-ui';
import type { JobKind } from '@/lib/jobs/types';

/**
 * A failed quality scan must not read as a failed build.
 *
 * The auto scans kicked by `settleStreamedGeneration` file a settled AUDIT row apiece
 * through `recordScanRun` → `insertSettledJob`, and that insert stamps `createdAt` with
 * the scan's `startedAt` — later than the build's. So from the first successful build
 * onwards the newest row on a project was a scan, and the two lookups the chat surface
 * depends on were both `ORDER BY "createdAt" DESC LIMIT 1` over every kind:
 *
 *  - `GET /api/projects/[id]/job` answered the poll with the AUDIT row, and
 *    `useGenerationJob` derived `recovery` from it with no kind gate. One DeepSeek 429
 *    during the scan is enough to make that row FAILED, and from then on
 *    `generationJob.recovery` was true forever: `ProjectWorkspace` computes
 *    `isGenerating = (sending || refining) && !recovery && …`, so every following message
 *    ran with no building indicator, no file name and no elapsed clock — while the panel
 *    that would have explained it stayed hidden, because *that* line does gate on
 *    `showsChatRecovery('AUDIT') === false`.
 *  - `resolveRecoveryTarget`'s no-jobId fallback got the same row and refused it with 409
 *    NOT_RECOVERABLE, so the recovery panel's own buttons stopped working.
 *
 * The fix is one decision applied in both places: ask the database for the newest *chat*
 * job instead of filtering the newest row afterwards. Filtering after `LIMIT 1` filters a
 * row that has already been chosen, which is exactly why both readers went blind.
 */

const store = vi.hoisted(() => ({ getLatestJobByKind: vi.fn(), getLatestJobOfKinds: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: {} }));
// Same cut as recovery-action-guards.test.ts: these are the static imports that pull
// next-auth into a plain-node suite, and none of them is on the lookup's path.
vi.mock('@/lib/checkpoints/actions', () => ({ createCheckpoint: vi.fn() }));
vi.mock('@/lib/projects/plan', () => ({ getApprovedPlanGenerationContext: vi.fn() }));
vi.mock('@/lib/projects/lock', () => ({ bumpContentVersion: vi.fn() }));
vi.mock('@/lib/jobs/lifecycle', () => ({
  cancelJob: vi.fn(),
  createOrReuseJob: vi.fn(),
  resolveResumablePhase: vi.fn(),
}));
vi.mock('@/lib/jobs/store', () => ({
  getLatestJobByKind: store.getLatestJobByKind,
  getLatestJobOfKinds: store.getLatestJobOfKinds,
}));

const { CHAT_JOB_KINDS, getLatestChatJob } = await import('@/lib/jobs/recovery');

/**
 * Every member of the `JobKind` union. `satisfies Record<JobKind, true>` is the point:
 * adding a kind without deciding whether chat owns it is a compile error here rather than
 * a row that silently starts or stops reaching the workspace poll.
 */
const ALL_JOB_KINDS = Object.keys({
  PLAN: true,
  BUILD: true,
  FOLLOWUP: true,
  IMPORT: true,
  AUDIT: true,
  PUBLISH: true,
  DOMAIN_VERIFY: true,
  EXPORT: true,
  TEMPLATE_THUMBNAIL: true,
} satisfies Record<JobKind, true>) as JobKind[];

const BUILD = {
  id: 'job-build',
  projectId: 'proj-1',
  kind: 'BUILD',
  status: 'SUCCEEDED',
  createdAt: new Date('2026-08-20T10:00:00.000Z'),
};
const FOLLOWUP = {
  id: 'job-followup',
  projectId: 'proj-1',
  kind: 'FOLLOWUP',
  status: 'SUCCEEDED',
  createdAt: new Date('2026-08-20T10:04:00.000Z'),
};
/** What `recordScanRun` leaves behind when the code scan's provider answers 429. */
const FAILED_SCAN = {
  id: 'job-scan',
  projectId: 'proj-1',
  kind: 'AUDIT',
  status: 'FAILED',
  errorCode: 'provider_error',
  createdAt: new Date('2026-08-20T10:06:00.000Z'),
};

/**
 * The project's job rows, answered the way the kind-scoped lookup asks for them: the whole
 * kind set in one call, the newest row inside it back. The per-kind lookup stays mocked so
 * the assertions that count on it never being asked for a non-chat kind keep their meaning.
 */
function jobHistory(rows: Array<Record<string, unknown>>) {
  const newestOf = (kinds: readonly string[]) => {
    const matches = rows.filter((row) => kinds.includes(row.kind as string)) as Array<{
      createdAt: Date;
    }>;
    return matches.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
  };
  store.getLatestJobOfKinds.mockImplementation(
    async (_projectId: string, kinds: readonly string[]) => newestOf(kinds),
  );
  store.getLatestJobByKind.mockImplementation(async (_projectId: string, kind: string) =>
    newestOf([kind]),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CHAT_JOB_KINDS', () => {
  it('is the same set as showsChatRecovery, kind for kind', () => {
    for (const kind of ALL_JOB_KINDS) {
      expect(CHAT_JOB_KINDS.includes(kind), kind).toBe(showsChatRecovery(kind));
    }
  });
});

describe('getLatestChatJob', () => {
  it('never asks for a kind chat did not start', async () => {
    jobHistory([BUILD, FAILED_SCAN]);

    await getLatestChatJob('proj-1');

    const asked = store.getLatestJobByKind.mock.calls.map((call) => call[1] as JobKind);
    expect(asked.some((kind) => !showsChatRecovery(kind))).toBe(false);
  });

  /**
   * The kind set is bound into one statement. It was a `Promise.all` over `CHAT_JOB_KINDS`
   * for a while, which answers the same question at one round trip per kind — four of them
   * on the workspace poll and on every recovery click, where a single extra query had
   * already been measured as a third to a half of the request's database work (F-643).
   */
  it('asks the store once, for exactly the chat kinds', async () => {
    jobHistory([BUILD, FAILED_SCAN]);

    await getLatestChatJob('proj-1');

    expect(store.getLatestJobOfKinds).toHaveBeenCalledTimes(1);
    const [projectId, kinds] = store.getLatestJobOfKinds.mock.calls[0] as [string, JobKind[]];
    expect(projectId).toBe('proj-1');
    expect([...kinds].sort()).toEqual([...CHAT_JOB_KINDS].sort());
    // Still the kind gate, not just a cheaper query: nothing chat never showed is asked for.
    expect(kinds.some((kind) => !showsChatRecovery(kind))).toBe(false);
    expect(store.getLatestJobByKind).not.toHaveBeenCalled();
  });

  it('answers the build, not the newer AUDIT row a failed scan left behind', async () => {
    jobHistory([BUILD, FAILED_SCAN]);

    const job = await getLatestChatJob('proj-1');

    expect(job).toMatchObject({ id: 'job-build', status: 'SUCCEEDED' });
  });

  it('still picks the newest job among the chat kinds', async () => {
    jobHistory([BUILD, FOLLOWUP, FAILED_SCAN]);

    const job = await getLatestChatJob('proj-1');

    expect(job).toMatchObject({ id: 'job-followup' });
  });

  it('answers null for a project with only bookkeeping rows', async () => {
    jobHistory([FAILED_SCAN, { ...FAILED_SCAN, id: 'job-export', kind: 'EXPORT' }]);

    expect(await getLatestChatJob('proj-1')).toBeNull();
  });
});

describe('chatRecoveryVerdict', () => {
  it('does not put the chat into recovery for a failed quality scan', () => {
    expect(chatRecoveryVerdict({ job: FAILED_SCAN, clientStop: null })).toBe(false);
  });

  it('still offers recovery for a build that really failed', () => {
    expect(chatRecoveryVerdict({ job: { ...BUILD, status: 'FAILED' }, clientStop: null })).toBe(
      true,
    );
    expect(chatRecoveryVerdict({ job: { ...BUILD, status: 'ABANDONED' }, clientStop: null })).toBe(
      true,
    );
  });

  it('never offers recovery for a build that succeeded', () => {
    expect(chatRecoveryVerdict({ job: BUILD, clientStop: null })).toBe(false);
    // A watchdog stop is only "we stopped watching" — a settled job's own status wins.
    expect(chatRecoveryVerdict({ job: BUILD, clientStop: 'stale_heartbeat' })).toBe(false);
  });

  it('keeps the watchdog verdict when there is no job object to judge', () => {
    // The recovery UI also opens on a 90-second heartbeat gap, which needs no row at all.
    expect(chatRecoveryVerdict({ job: null, clientStop: 'timeout' })).toBe(true);
    expect(chatRecoveryVerdict({ job: null, clientStop: null })).toBe(false);
    // A job still in flight with a dead heartbeat is a real stall.
    expect(
      chatRecoveryVerdict({ job: { ...BUILD, status: 'RUNNING' }, clientStop: 'stale_heartbeat' }),
    ).toBe(true);
  });

  it('reads the masked row, so a finished turn cannot gate the next one', () => {
    // `activeJob` is null while a stream runs in this tab and the polled row is still the
    // previous turn's. Judging the new turn by the old row's FAILED reopened recovery over
    // a build that had already started.
    expect(chatRecoveryVerdict({ job: null, clientStop: null })).toBe(false);
  });
});
