import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishDeps, PublishServer } from '@/lib/publish/execute';

/**
 * F-202, driven through `runPublishJob` itself: a slug that matches an existing org repo
 * used to make the `github` step adopt that repo and force-push over it. The loop must
 * now refuse unless the repo's immutable id proves this project created it — failing the
 * job with the named `github` step and the `repo_conflict` code the publish sheet and
 * /admin/jobs read — and must record ownership the moment a repo is created or adopted.
 *
 * The provider modules are mocked only to keep the import graph off the network; the
 * loop runs on the injected `PublishDeps`. `@/lib/publish/files` stays real so the
 * `errorCode` assertion exercises the real classifier.
 */

const db = vi.hoisted(() => ({
  deploymentFindUnique: vi.fn(),
  deploymentUpdate: vi.fn(),
  projectFindFirst: vi.fn(),
  projectUpdate: vi.fn(),
  serverFindUniqueOrThrow: vi.fn(),
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
}));
const jobs = vi.hoisted(() => ({
  claimJobRun: vi.fn(async () => true),
  getJob: vi.fn(),
  updateJobFields: vi.fn(),
}));
const lifecycle = vi.hoisted(() => ({
  failJob: vi.fn(),
  markJobRunning: vi.fn(),
  succeedJob: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    deployment: { findUnique: db.deploymentFindUnique, update: db.deploymentUpdate },
    project: { findFirst: db.projectFindFirst, update: db.projectUpdate },
    coolifyServer: { findUniqueOrThrow: db.serverFindUniqueOrThrow },
    $queryRaw: db.queryRaw,
    $executeRaw: db.executeRaw,
  },
}));
vi.mock('@/lib/jobs/store', () => ({
  // The exclusive run claim: this suite drives one runner, so it always wins.
  claimJobRun: jobs.claimJobRun,
  getJob: jobs.getJob,
  updateJobFields: jobs.updateJobFields,
}));
vi.mock('@/lib/jobs/lifecycle', () => ({
  beginJobHeartbeat: () => ({ stop: () => {} }),
  failJob: lifecycle.failJob,
  markJobRunning: lifecycle.markJobRunning,
  succeedJob: lifecycle.succeedJob,
}));
vi.mock('@/lib/checkpoints/snapshot', () => ({
  SnapshotReadError: class SnapshotReadError extends Error {},
  readSnapshot: vi.fn(),
  captureFileSnapshot: vi.fn(),
}));
vi.mock('@/lib/github/deploy-client', () => ({ ensureDeployRepo: vi.fn(), pushFiles: vi.fn() }));
vi.mock('@/lib/cloudflare/dns', () => ({ upsertARecord: vi.fn() }));
vi.mock('@/lib/coolify/client', () => ({
  addApplicationDomain: vi.fn(),
  createApplication: vi.fn(),
  getCoolifyDeployment: vi.fn(),
  pinApplicationCommit: vi.fn(),
  COOLIFY_STATUS_UNREPORTED: 'unreported',
  triggerDeploy: vi.fn(),
}));
vi.mock('@/lib/coolify/servers', () => ({
  pickCoolifyServer: vi.fn(),
  serverAuth: () => ({ apiUrl: 'https://coolify.test', apiToken: 'stub' }),
}));
vi.mock('@/lib/integrations/store', () => ({ getRootDomain: vi.fn() }));
vi.mock('@/lib/domains/redirects', () => ({ applyPrimaryRedirects: vi.fn() }));
// Dynamic: the loop's provider imports must resolve to the mocks above, which only exist
// once the factories are registered.
const { runPublishJob } = await import('@/lib/publish/execute');

const JOB = 'job_repo_conflict';
const PROJECT = 'proj_guard';
const DEPLOYMENT = 'dep_live';
const SLUG = 'acme';
const REPO_FULL_NAME = `deploy-org/${SLUG}`;

const SERVER: PublishServer = {
  id: 'srv_1',
  apiUrl: 'https://coolify.test',
  apiToken: 'stub',
  serverIp: '203.0.113.10',
  projectUuid: 'coolify-project-1',
};

type Seen = { pushedTo: string | null };

function spyDeps(repo: { repoId: string; created: boolean }): { deps: PublishDeps; seen: Seen } {
  const seen: Seen = { pushedTo: null };
  const deps: PublishDeps = {
    async collectFiles() {
      return { 'app/page.tsx': 'export default () => null;' };
    },
    async collectAssets() {
      return {};
    },
    async pickServer() {
      return SERVER;
    },
    async rootDomain() {
      return 'navroop.test';
    },
    async ensureRepo(repoSlug) {
      return { fullName: `deploy-org/${repoSlug}`, repoId: repo.repoId, created: repo.created };
    },
    async pushFiles(repoFullName) {
      seen.pushedTo = repoFullName;
      return 'commit-sha-1';
    },
    async createApp() {
      return { uuid: 'coolify-app-1' };
    },
    async upsertDns() {
      return 'dns-record-1';
    },
    async addAppDomain() {},
    async applyRedirects() {},
    async pinCommit(_auth, _appUuid, sha) {
      return { ok: true as const, sha };
    },
    async startDeploy() {
      return { deploymentUuid: 'coolify-deployment-1' };
    },
    async deploymentStatus() {
      return { health: 'healthy', status: 'finished' };
    },
  };
  return { deps, seen };
}

/** A first publish whose slug is already claimed — exactly where the collision bites. */
function seedDeployment(row: {
  repoFullName?: string | null;
  commitSha?: string | null;
  publishedAt?: Date | null;
}) {
  db.deploymentFindUnique.mockResolvedValue({
    id: DEPLOYMENT,
    projectId: PROJECT,
    workspaceId: 'default',
    serverId: SERVER.id,
    kind: 'LIVE',
    status: row.publishedAt ? 'LIVE' : 'QUEUED',
    slug: SLUG,
    url: null,
    publishedAt: row.publishedAt ?? null,
    passwordHash: null,
    coolifyAppUuid: null,
    dnsRecordId: null,
    repoFullName: row.repoFullName ?? null,
    repoBranch: 'main',
    commitSha: row.commitSha ?? null,
    buildLogUrl: null,
  });
}

/** The recorded ownership id, as the guard's raw `SELECT "githubRepoId"` returns it. */
function seedRecordedRepoId(githubRepoId: string | null) {
  db.queryRaw.mockResolvedValue([{ githubRepoId }]);
}

function lastPersistedSteps() {
  const calls = jobs.updateJobFields.mock.calls;
  const last = calls[calls.length - 1]?.[1] as
    { steps?: Array<{ key: string; status: string; error: string | null }> } | undefined;
  return last?.steps ?? [];
}

beforeEach(() => {
  vi.clearAllMocks();
  jobs.getJob.mockResolvedValue({
    id: JOB,
    projectId: PROJECT,
    status: 'QUEUED',
    inputPrompt: 'LIVE',
    requestId: 'req-1',
    steps: [],
    resourceIds: {},
  });
  db.projectFindFirst.mockResolvedValue({ id: PROJECT, name: 'Acme', stack: 'NEXTJS' });
  db.serverFindUniqueOrThrow.mockResolvedValue(SERVER);
  db.deploymentUpdate.mockResolvedValue({});
  db.projectUpdate.mockResolvedValue({});
  db.queryRaw.mockResolvedValue([]);
  db.executeRaw.mockResolvedValue(1);
});

describe('runPublishJob — repo ownership guard (F-202)', () => {
  it('refuses an existing repo nothing ties to this project, without pushing a byte', async () => {
    seedDeployment({});
    seedRecordedRepoId(null);
    const { deps, seen } = spyDeps({ repoId: 'foreign-repo-id', created: false });

    await expect(runPublishJob(JOB, deps)).rejects.toThrow(REPO_FULL_NAME);

    expect(seen.pushedTo).toBeNull();
    // No ownership is recorded for a repo we refused.
    expect(db.executeRaw).not.toHaveBeenCalled();

    // The refusal is a named step failure the publish sheet and /admin/jobs read.
    const github = lastPersistedSteps().find((step) => step.key === 'github');
    expect(github?.status).toBe('failed');
    expect(github?.error).toContain('was not created by this project');

    expect(lifecycle.failJob).toHaveBeenCalledWith(JOB, {
      errorCode: 'repo_conflict',
      errorMessage: expect.stringContaining(REPO_FULL_NAME),
    });
    // The Deployment row settles FAILED with the same actionable sentence.
    expect(db.deploymentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          lastError: expect.stringContaining(REPO_FULL_NAME),
        }),
      }),
    );
    expect(lifecycle.succeedJob).not.toHaveBeenCalled();
  });

  it('refuses when the recorded id no longer matches the repo behind the name', async () => {
    seedDeployment({ repoFullName: REPO_FULL_NAME, commitSha: 'old-sha' });
    seedRecordedRepoId('recorded-id');
    const { deps, seen } = spyDeps({ repoId: 'someone-elses-id', created: false });

    await expect(runPublishJob(JOB, deps)).rejects.toThrow(REPO_FULL_NAME);
    expect(seen.pushedTo).toBeNull();
    expect(lifecycle.failJob).toHaveBeenCalledWith(
      JOB,
      expect.objectContaining({ errorCode: 'repo_conflict' }),
    );
  });

  it('proceeds when the recorded id matches the existing repo', async () => {
    seedDeployment({ repoFullName: REPO_FULL_NAME, commitSha: 'old-sha' });
    seedRecordedRepoId('repo-id-1');
    const { deps, seen } = spyDeps({ repoId: 'repo-id-1', created: false });

    await runPublishJob(JOB, deps);

    expect(seen.pushedTo).toBe(REPO_FULL_NAME);
    expect(lifecycle.succeedJob).toHaveBeenCalledWith(JOB, { lastStep: 'live' });
  });

  it('adopts a pre-feature repo this deployment already pushed to, and records its id', async () => {
    seedDeployment({
      repoFullName: REPO_FULL_NAME,
      commitSha: 'old-sha',
      publishedAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    seedRecordedRepoId(null);
    const { deps, seen } = spyDeps({ repoId: 'adopted-id', created: false });

    await runPublishJob(JOB, deps);

    expect(seen.pushedTo).toBe(REPO_FULL_NAME);
    expect(lifecycle.succeedJob).toHaveBeenCalled();
    // The one-time backfill: the adopted id is written before the push.
    expect(db.executeRaw).toHaveBeenCalled();
  });

  it('proceeds with a repo the ensure call just created, recording ownership first', async () => {
    seedDeployment({});
    seedRecordedRepoId(null);
    const { deps, seen } = spyDeps({ repoId: 'fresh-id', created: true });

    await runPublishJob(JOB, deps);

    expect(seen.pushedTo).toBe(REPO_FULL_NAME);
    expect(db.executeRaw).toHaveBeenCalled();
    expect(lifecycle.succeedJob).toHaveBeenCalledWith(JOB, { lastStep: 'live' });
  });
});
