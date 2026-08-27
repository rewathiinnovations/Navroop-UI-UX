import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `GET /api/projects/[id]/job` is the highest-frequency endpoint in the product: every
 * 2s per open workspace for the first two minutes of a build (`nextPollIntervalMs`),
 * then every 10s, multiplied by viewers.
 *
 * F-643: it opened with `prisma.project.findFirst` purely to answer 404 for a project
 * that does not exist — a third to a half of the request's database work, spent on
 * information the caller cannot observe. `useGenerationJob.refresh` maps a non-ok
 * response and a null job to the same `null`, and `getActiveJob`/`getLatestChatJob` are
 * already scoped by `projectId`, so the existence check bought nothing.
 *
 * These count the round trips rather than trusting the shape of the source.
 */

const auth = vi.hoisted(() => ({ getSessionUser: vi.fn() }));
const prisma = vi.hoisted(() => ({ project: { findFirst: vi.fn(), findUnique: vi.fn() } }));
const store = vi.hoisted(() => ({
  getActiveJob: vi.fn(),
  getLatestJobByKind: vi.fn(),
  getLatestJobOfKinds: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ getSessionUser: auth.getSessionUser }));
vi.mock('@/lib/db', () => ({ prisma }));
vi.mock('@/lib/jobs/store', () => ({
  getActiveJob: store.getActiveJob,
  getLatestJobByKind: store.getLatestJobByKind,
  getLatestJobOfKinds: store.getLatestJobOfKinds,
}));

const RUNNING_JOB = {
  id: 'job-1',
  projectId: 'proj-1',
  kind: 'BUILD',
  status: 'RUNNING',
  filesWritten: 7,
  steps: [],
  createdAt: new Date('2026-08-20T10:00:00.000Z'),
  updatedAt: new Date('2026-08-20T10:00:30.000Z'),
};

/**
 * Answers the kind-scoped lookup behind `getLatestChatJob`.
 *
 * It takes the whole kind set and answers the newest row inside it, which is the point:
 * the fallback is one statement, not one per chat kind. The per-kind lookup is still
 * mocked so the counts below stay meaningful — a return to the fan-out would show up as
 * calls on it.
 */
function latestByKind(rows: Array<Record<string, unknown>>) {
  store.getLatestJobOfKinds.mockImplementation(async (_projectId: string, kinds: string[]) => {
    const matches = rows.filter((row) => kinds.includes(row.kind as string)) as Array<{
      createdAt: Date;
    }>;
    return matches.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
  });
}

// Dynamic so the mocks above are installed before the route module is evaluated; a
// static import would be hoisted past them.
const { GET } = await import('@/app/api/projects/[id]/job/route');

function get(id = 'proj-1') {
  return GET(new NextRequest(`http://localhost:3000/api/projects/${id}/job`, { method: 'GET' }), {
    params: Promise.resolve({ id }),
  });
}

describe('the job poll spends no query on an existence check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.getSessionUser.mockResolvedValue({ id: 'user-1', role: 'MEMBER' });
  });

  it('answers an active job with one job query and no project query', async () => {
    store.getActiveJob.mockResolvedValue(RUNNING_JOB);
    const response = await get();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { job: { id: string } | null; filesWritten: number };
    expect(body.job?.id).toBe('job-1');
    expect(body.filesWritten).toBe(7);
    // The whole point: one job read, nothing else. A live build never reaches the
    // fallback, so the 2s poll that matters is still a single query.
    expect(store.getActiveJob).toHaveBeenCalledTimes(1);
    expect(store.getLatestJobByKind).toHaveBeenCalledTimes(0);
    expect(prisma.project.findFirst).toHaveBeenCalledTimes(0);
    expect(prisma.project.findUnique).toHaveBeenCalledTimes(0);
  });

  it('falls back to the latest chat job and still spends no project query', async () => {
    store.getActiveJob.mockResolvedValue(null);
    latestByKind([{ ...RUNNING_JOB, status: 'SUCCEEDED' }]);
    const response = await get();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { job: { id: string } | null };
    expect(body.job?.id).toBe('job-1');
    expect(prisma.project.findFirst).toHaveBeenCalledTimes(0);
  });

  /**
   * The fallback was a `Promise.all` over `CHAT_JOB_KINDS` for a while — four statements
   * where the endpoint used to spend one. A project left in `phase = BUILDING` with a
   * settled job takes this branch on *every* tick (`shouldPoll` stays true and
   * `getActiveJob` keeps answering null), so that is five statements every 2s per open
   * viewer of every such workspace, plus one on each workspace mount. The kind set goes
   * into the statement instead.
   */
  it('falls back with one query, not one per chat kind', async () => {
    store.getActiveJob.mockResolvedValue(null);
    latestByKind([{ ...RUNNING_JOB, status: 'SUCCEEDED' }]);

    const response = await get();

    expect(response.status).toBe(200);
    expect(((await response.json()) as { job: { id: string } | null }).job?.id).toBe('job-1');
    expect(store.getLatestJobOfKinds).toHaveBeenCalledTimes(1);
    // The whole poll, worst case: the active-job read and the fallback.
    expect(store.getActiveJob).toHaveBeenCalledTimes(1);
    expect(store.getLatestJobByKind).not.toHaveBeenCalled();
  });

  /**
   * The auto quality scan files a settled AUDIT row when it finishes, stamped with the
   * scan's own `startedAt` — later than the build's `createdAt`. The fallback was
   * `getLatestJob`, kind-blind, so from the first successful build onwards this endpoint
   * answered every poll with the scan: a scan that failed (one provider 429 is enough)
   * read as a failed build, and `useGenerationJob` put the chat into recovery for good.
   */
  it('answers with the build, not the newer AUDIT row a failed scan left behind', async () => {
    store.getActiveJob.mockResolvedValue(null);
    latestByKind([
      { ...RUNNING_JOB, status: 'SUCCEEDED', createdAt: new Date('2026-08-20T10:00:00.000Z') },
      {
        id: 'job-scan',
        projectId: 'proj-1',
        kind: 'AUDIT',
        status: 'FAILED',
        filesWritten: 0,
        steps: [],
        errorCode: 'provider_error',
        createdAt: new Date('2026-08-20T10:02:00.000Z'),
        updatedAt: new Date('2026-08-20T10:02:10.000Z'),
      },
    ]);
    const response = await get();
    const body = (await response.json()) as { job: { id: string; status: string } | null };
    expect(body.job?.id).toBe('job-1');
    expect(body.job?.status).toBe('SUCCEEDED');
    // Not by filtering the scan out afterwards — the query never asks for AUDIT at all,
    // so /admin/jobs and the Quality panel still see the row.
    expect(store.getLatestJobByKind).not.toHaveBeenCalledWith('proj-1', 'AUDIT');
  });

  it('answers an unknown project with a null job, not a 404, and no project query', async () => {
    store.getActiveJob.mockResolvedValue(null);
    latestByKind([]);
    const response = await get('does-not-exist');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { job: unknown; filesWritten: number };
    expect(body).toEqual({ job: null, filesWritten: 0 });
    expect(prisma.project.findFirst).toHaveBeenCalledTimes(0);
  });

  it('still refuses a signed-out poll before touching the database', async () => {
    auth.getSessionUser.mockResolvedValue(null);
    const response = await get();
    expect(response.status).toBe(401);
    expect(store.getActiveJob).toHaveBeenCalledTimes(0);
    expect(store.getLatestJobByKind).toHaveBeenCalledTimes(0);
  });
});
