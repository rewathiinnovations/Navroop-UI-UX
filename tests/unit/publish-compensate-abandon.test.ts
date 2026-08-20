import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What an *abandoned* publish leaves behind on the `Deployment` row.
 *
 * `runPublishJob`'s catch is the only thing that settles the row, and an abandon —
 * instance restart, SIGTERM drain, stale heartbeat — never runs it. Compensation is the
 * one writer that does run, and its status write used to be gated on `result.rolledBack`.
 * A re-publish rolls nothing back by design (its Coolify app and DNS record were already
 * serving), so exactly the case that needed settling was the case that got skipped: the
 * site stayed up and the product said "Building" forever, in the publish sheet, on
 * /deployments, on the project badge, and in the live-slot count.
 *
 * So the row is settled on every abandon. What it settles *to* is the state the row had
 * before the job started: LIVE for a re-publish, FAILED for a first publish.
 */

const db = vi.hoisted(() => ({
  deploymentFindUnique: vi.fn(),
  deploymentFindFirst: vi.fn(),
  deploymentUpdate: vi.fn(),
}));
const store = vi.hoisted(() => ({ getJob: vi.fn(), updateJobFields: vi.fn() }));
const compensate = vi.hoisted(() => ({ compensateJobResources: vi.fn() }));

vi.mock('@/lib/db', () => ({
  prisma: {
    deployment: {
      findUnique: db.deploymentFindUnique,
      findFirst: db.deploymentFindFirst,
      update: db.deploymentUpdate,
    },
  },
}));
vi.mock('@/lib/jobs/store', () => ({
  getJob: store.getJob,
  updateJobFields: store.updateJobFields,
}));
vi.mock('@/lib/jobs/compensate', () => ({
  compensateJobResources: compensate.compensateJobResources,
}));

// Dynamic: `compensate-publish` reads `prisma` and the job store at module scope through
// its own imports, so it must load after the factories above are registered.
const { compensateAbandonedPublish } = await import('@/lib/jobs/compensate-publish');

const JOB_ID = 'job_abandoned_publish';
const DEPLOYMENT_ID = 'dep_1';

function seedJob(overrides: Record<string, unknown> = {}) {
  store.getJob.mockResolvedValue({
    id: JOB_ID,
    kind: 'PUBLISH',
    projectId: 'proj_1',
    inputPrompt: 'LIVE',
    errorMessage: 'This instance was restarted',
    steps: [],
    resourceIds: { githubRepo: 'deploy-org/acme', coolifyAppUuid: 'app-1', dnsRecordId: 'dns-1' },
    ...overrides,
  });
}

/** A deployment that is already serving — the row a re-publish starts from. */
function seedLiveDeployment() {
  db.deploymentFindUnique.mockResolvedValue({
    id: DEPLOYMENT_ID,
    status: 'BUILDING',
    publishedAt: new Date('2026-08-01T00:00:00.000Z'),
    repoFullName: 'deploy-org/acme',
    coolifyAppUuid: 'app-1',
    dnsRecordId: 'dns-1',
  });
}

/** A deployment that has never served — the row a first publish starts from. */
function seedFirstDeployment() {
  db.deploymentFindUnique.mockResolvedValue({
    id: DEPLOYMENT_ID,
    status: 'BUILDING',
    publishedAt: null,
    repoFullName: null,
    coolifyAppUuid: null,
    dnsRecordId: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  seedJob();
  seedFirstDeployment();
  db.deploymentUpdate.mockResolvedValue({});
  store.updateJobFields.mockResolvedValue(undefined);
  compensate.compensateJobResources.mockResolvedValue({ rolledBack: false, compensated: [] });
});

describe('compensateAbandonedPublish — settling the Deployment row', () => {
  it('restores an abandoned re-publish to LIVE and names the interrupted attempt', async () => {
    seedLiveDeployment();

    await expect(compensateAbandonedPublish(JOB_ID)).resolves.toBe('kept_live');

    expect(db.deploymentUpdate).toHaveBeenCalledWith({
      where: { id: DEPLOYMENT_ID },
      data: {
        status: 'LIVE',
        lastError: 'This instance was restarted',
      },
    });
  });

  it('fails an abandoned first publish even though there was nothing to roll back', async () => {
    // `rolledBack: false` with no successful deployment is the "nothing was created yet"
    // abandon. The row is still sitting on BUILDING and nobody else will move it.
    await expect(compensateAbandonedPublish(JOB_ID)).resolves.toBe('kept_live');

    expect(db.deploymentUpdate).toHaveBeenCalledWith({
      where: { id: DEPLOYMENT_ID },
      data: {
        status: 'FAILED',
        lastError: 'This instance was restarted',
      },
    });
  });

  it('falls back to a plain reason when the abandon recorded no message', async () => {
    seedJob({ errorMessage: null });

    await compensateAbandonedPublish(JOB_ID);

    expect(db.deploymentUpdate.mock.calls[0][0].data.lastError).toBe('Publish did not finish');
  });

  it('clears the ids of the resources it actually tore down', async () => {
    compensate.compensateJobResources.mockResolvedValue({
      rolledBack: true,
      compensated: ['coolify', 'dns'],
    });

    await expect(compensateAbandonedPublish(JOB_ID)).resolves.toBe('rolled_back');

    expect(db.deploymentUpdate).toHaveBeenCalledWith({
      where: { id: DEPLOYMENT_ID },
      data: {
        status: 'FAILED',
        lastError: 'This instance was restarted',
        coolifyAppUuid: null,
        dnsRecordId: null,
      },
    });
  });

  it('leaves the resource ids of a LIVE row alone when nothing was torn down', async () => {
    // The resumed run skips the succeeded `app` step, so blanking `coolifyAppUuid` here
    // would leave a live site with no uuid for purge or the orphan cron to find.
    seedLiveDeployment();

    await compensateAbandonedPublish(JOB_ID);

    expect(db.deploymentUpdate.mock.calls[0][0].data).not.toHaveProperty('coolifyAppUuid');
    expect(db.deploymentUpdate.mock.calls[0][0].data).not.toHaveProperty('dnsRecordId');
  });

  it('writes nothing a second time for a job that was already compensated', async () => {
    seedJob({ resourceIds: { compensation: 'kept_live' } });

    await expect(compensateAbandonedPublish(JOB_ID)).resolves.toBe('kept_live');

    expect(compensate.compensateJobResources).not.toHaveBeenCalled();
    expect(db.deploymentUpdate).not.toHaveBeenCalled();
  });

  it('writes no status when there is no Deployment row left to settle', async () => {
    db.deploymentFindUnique.mockResolvedValue(null);

    await compensateAbandonedPublish(JOB_ID);

    expect(db.deploymentUpdate).not.toHaveBeenCalled();
  });
});
