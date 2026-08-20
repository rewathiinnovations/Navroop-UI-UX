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
 * response and a null job to the same `null`, and `getActiveJob`/`getLatestJob` are
 * already scoped by `projectId`, so the existence check bought nothing.
 *
 * These count the round trips rather than trusting the shape of the source.
 */

const auth = vi.hoisted(() => ({ getSessionUser: vi.fn() }));
const prisma = vi.hoisted(() => ({ project: { findFirst: vi.fn(), findUnique: vi.fn() } }));
const store = vi.hoisted(() => ({ getActiveJob: vi.fn(), getLatestJob: vi.fn() }));

vi.mock('@/lib/auth', () => ({ getSessionUser: auth.getSessionUser }));
vi.mock('@/lib/db', () => ({ prisma }));
vi.mock('@/lib/jobs/store', () => ({
  getActiveJob: store.getActiveJob,
  getLatestJob: store.getLatestJob,
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
    // The whole point: one job read, nothing else.
    expect(store.getActiveJob).toHaveBeenCalledTimes(1);
    expect(store.getLatestJob).toHaveBeenCalledTimes(0);
    expect(prisma.project.findFirst).toHaveBeenCalledTimes(0);
    expect(prisma.project.findUnique).toHaveBeenCalledTimes(0);
  });

  it('falls back to the latest job with two queries and no project query', async () => {
    store.getActiveJob.mockResolvedValue(null);
    store.getLatestJob.mockResolvedValue({ ...RUNNING_JOB, status: 'SUCCEEDED' });
    const response = await get();
    expect(response.status).toBe(200);
    expect(store.getLatestJob).toHaveBeenCalledTimes(1);
    expect(prisma.project.findFirst).toHaveBeenCalledTimes(0);
  });

  it('answers an unknown project with a null job, not a 404, and no project query', async () => {
    store.getActiveJob.mockResolvedValue(null);
    store.getLatestJob.mockResolvedValue(null);
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
    expect(store.getLatestJob).toHaveBeenCalledTimes(0);
  });
});
