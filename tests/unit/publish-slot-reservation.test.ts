import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PlansLimits from '@/lib/plans/limits';

/**
 * Where the live/preview slot ceiling is actually enforced.
 *
 * `assertPublishSlot` counts non-STOPPED deployments and then returns, and the row that
 * consumes the slot is written afterwards — two statements, so two concurrent publishes at
 * the ceiling both counted `limit - 1`, both passed, and both inserted. That over-commits
 * the Coolify server past the plan's `maxLiveSites` / `maxPreviewSites`, which is the
 * whole point of the number (F-307). `withLimit` re-counts and writes inside one
 * transaction under an advisory lock keyed on the limit, so the reservation and the write
 * cannot interleave; its atomicity is proven in tests/integration/plan-limit-writes.test.ts.
 *
 * This suite pins the seam: the write that takes a slot goes through `withLimit`, a
 * refusal produces a `PublishLimitError` and no job, and a re-publish of a deployment that
 * is already running takes no new slot.
 *
 * Goes red if the insert (or the revival of a STOPPED row, which `currentForLimit` counts
 * the same way) is ever written outside a reservation again.
 */

const db = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  deploymentFindUnique: vi.fn(),
  deploymentCreate: vi.fn(),
  deploymentUpdate: vi.fn(),
  txCreate: vi.fn(),
  txUpdate: vi.fn(),
  executeRaw: vi.fn(),
}));
const limits = vi.hoisted(() => ({ withLimit: vi.fn(), checkLimit: vi.fn() }));
const jobs = vi.hoisted(() => ({ createOrReuseJob: vi.fn(), getActiveJob: vi.fn() }));

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findFirst: db.projectFindFirst },
    deployment: {
      findUnique: db.deploymentFindUnique,
      create: db.deploymentCreate,
      update: db.deploymentUpdate,
    },
    $executeRaw: db.executeRaw,
  },
}));
vi.mock('@/lib/plans/limits', async (importOriginal) => {
  // Partial: `LimitKind` and the denial copy stay real, only the two entry points the
  // publish path calls are observed.
  const actual = await importOriginal<typeof PlansLimits>();
  return { ...actual, withLimit: limits.withLimit, checkLimit: limits.checkLimit };
});
vi.mock('@/lib/jobs', () => ({
  createOrReuseJob: jobs.createOrReuseJob,
  getActiveJob: jobs.getActiveJob,
}));
vi.mock('@/lib/integrations/store', () => ({
  getPublishReadiness: vi.fn(async () => ({ missing: [], unreadable: [] })),
}));
vi.mock('@/lib/coolify/servers', () => ({
  pickCoolifyServer: vi.fn(async () => ({ id: 'srv_1' })),
  serverAuth: () => ({ apiUrl: 'https://coolify.test', apiToken: 'stub' }),
}));
vi.mock('@/lib/coolify/client', () => ({
  setApplicationEnvVars: vi.fn(),
  setBasicAuth: vi.fn(),
}));
vi.mock('@/lib/publish/execute', () => ({ runPublishJob: vi.fn() }));
vi.mock('@/lib/observability/track', () => ({ trackStart: vi.fn() }));

// Dynamic: `publish.ts` resolves prisma, the limits and the job store at module scope, so
// it must load after the factories above are registered.
const { startPublishJob } = await import('@/lib/publish/publish');
const { PublishLimitError } = await import('@/lib/publish/limits');

const PROJECT = 'proj_1';
const DEPLOYMENT = 'dep_1';
const tx = { deployment: { create: db.txCreate, update: db.txUpdate } };

function liveRow(status: 'LIVE' | 'STOPPED') {
  return {
    id: DEPLOYMENT,
    projectId: PROJECT,
    kind: 'LIVE',
    status,
    slug: 'acme',
    repoFullName: null,
    coolifyAppUuid: null,
    dnsRecordId: null,
    publishedAt: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.projectFindFirst.mockResolvedValue({ id: PROJECT, name: 'Acme', stack: 'NEXTJS' });
  db.deploymentFindUnique.mockResolvedValue(null);
  db.deploymentCreate.mockResolvedValue(liveRow('LIVE'));
  db.deploymentUpdate.mockResolvedValue(liveRow('LIVE'));
  db.txCreate.mockResolvedValue(liveRow('LIVE'));
  db.txUpdate.mockResolvedValue(liveRow('LIVE'));
  db.executeRaw.mockResolvedValue(1);
  limits.checkLimit.mockResolvedValue({ ok: true, current: 0, limit: 5 });
  limits.withLimit.mockImplementation(
    async (
      _workspaceId: string,
      _kind: string,
      _upcoming: number,
      create: (client: typeof tx) => Promise<unknown>,
    ) => ({ ok: true, data: await create(tx) }),
  );
  jobs.getActiveJob.mockResolvedValue(null);
  jobs.createOrReuseJob.mockResolvedValue({ id: 'job_1', publishedAt: null });
});

describe('startPublishJob slot reservation', () => {
  it('creates the first deployment inside a liveSites reservation', async () => {
    const result = await startPublishJob({ projectId: PROJECT, kind: 'LIVE', userId: 'user_1' });

    expect(result).toEqual({ jobId: 'job_1', deploymentId: DEPLOYMENT });
    expect(limits.withLimit).toHaveBeenCalledWith('default', 'liveSites', 1, expect.any(Function));
    // The insert ran on the transaction client the reservation handed out, not on the
    // ambient prisma client next to the count.
    expect(db.txCreate).toHaveBeenCalledTimes(1);
    expect(db.deploymentCreate).not.toHaveBeenCalled();
  });

  it('reserves a previewSites slot for a preview', async () => {
    await startPublishJob({ projectId: PROJECT, kind: 'PREVIEW', userId: 'user_1' });

    expect(limits.withLimit).toHaveBeenCalledWith(
      'default',
      'previewSites',
      1,
      expect.any(Function),
    );
  });

  it('refuses the publish when the reservation is denied, and starts no job', async () => {
    limits.withLimit.mockResolvedValue({
      ok: false,
      current: 1,
      limit: 1,
      reason: 'liveSites',
      message: 'Live site limit reached',
    });

    await expect(
      startPublishJob({ projectId: PROJECT, kind: 'LIVE', userId: 'user_1' }),
    ).rejects.toBeInstanceOf(PublishLimitError);

    expect(jobs.createOrReuseJob).not.toHaveBeenCalled();
    expect(db.txCreate).not.toHaveBeenCalled();
  });

  it('carries the plan numbers on the refusal so the caller can render a 402', async () => {
    limits.withLimit.mockResolvedValue({
      ok: false,
      current: 2,
      limit: 2,
      reason: 'liveSites',
      message: 'Live site limit reached',
    });

    const error = await startPublishJob({
      projectId: PROJECT,
      kind: 'LIVE',
      userId: 'user_1',
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PublishLimitError);
    expect(error).toMatchObject({
      status: 402,
      reason: 'liveSites',
      used: 2,
      limit: 2,
      message: 'Live site limit reached',
    });
  });

  it('reviving a STOPPED deployment takes a slot too', async () => {
    db.deploymentFindUnique.mockResolvedValue(liveRow('STOPPED'));

    await startPublishJob({ projectId: PROJECT, kind: 'LIVE', userId: 'user_1' });

    // `currentForLimit` counts every non-STOPPED row, so flipping STOPPED back to QUEUED
    // increases the count exactly as an insert does.
    expect(limits.withLimit).toHaveBeenCalledWith('default', 'liveSites', 1, expect.any(Function));
    expect(db.txUpdate).toHaveBeenCalledTimes(1);
    expect(db.deploymentUpdate).not.toHaveBeenCalled();
  });

  it('re-publishing a running deployment takes no new slot', async () => {
    db.deploymentFindUnique.mockResolvedValue(liveRow('LIVE'));

    await startPublishJob({ projectId: PROJECT, kind: 'LIVE', userId: 'user_1' });

    // The row is already counted, so a reservation here would refuse the re-publish of
    // the very last allowed site.
    expect(limits.withLimit).not.toHaveBeenCalled();
    expect(db.deploymentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: DEPLOYMENT } }),
    );
  });
});
