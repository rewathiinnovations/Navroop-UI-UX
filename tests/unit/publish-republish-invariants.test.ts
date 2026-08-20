import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PublishFiles from '@/lib/publish/files';
import type * as CoolifyClient from '@/lib/coolify/client';
import type { PublishDeps, PublishServer } from '@/lib/publish/execute';

/**
 * What a *re-publish* of a PREVIEW must do, driven through `runPublishJob` itself.
 *
 * Two production bugs met in this loop:
 *
 * 1. The `domain` step called an overwriting PATCH, so every re-publish stripped the
 *    verified custom domains off the Coolify application. It must merge and then re-apply
 *    the primary/alias 301s.
 * 2. The `files` step hardcoded `password: null` into `injectPreviewFiles`, so a node-stack
 *    preview shipped a middleware with the Basic-Auth branch removed while
 *    `serializeDeployment` reported `hasPassword: true` from the stored hash. The gate now
 *    follows `Deployment.passwordHash`, which is the only thing a re-publish can see.
 *
 * The old unit coverage could not catch (2): it called `injectPreviewFiles` directly with a
 * password the sole production caller never passed. These cases go through the real caller,
 * so the assertion is about what actually reaches the deploy repo.
 *
 * The provider modules are mocked only to keep the import graph off the network — the loop
 * runs on the injected `PublishDeps`, which is what the assertions read.
 */

const db = vi.hoisted(() => ({
  deploymentFindUnique: vi.fn(),
  deploymentUpdate: vi.fn(),
  projectFindFirst: vi.fn(),
  projectUpdate: vi.fn(),
  serverFindUniqueOrThrow: vi.fn(),
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
    // The repo-ownership guard reads/writes `Deployment.githubRepoId` with raw SQL. No
    // recorded id here: the seeded row is a pre-feature LIVE preview, so the guard takes
    // the adopt path (repoFullName matches and publishedAt is set).
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 1),
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
vi.mock('@/lib/publish/files', async (importOriginal) => {
  // Only the reader is stubbed: the never-publish filter is real, because what reaches
  // the deploy repo is exactly what these cases assert on.
  const actual = await importOriginal<typeof PublishFiles>();
  return {
    ...actual,
    collectPublishFiles: vi.fn(),
    publishJobErrorCode: () => 'provider_error',
  };
});
vi.mock('@/lib/github/deploy-client', () => ({ ensureDeployRepo: vi.fn(), pushFiles: vi.fn() }));
vi.mock('@/lib/cloudflare/dns', () => ({ upsertARecord: vi.fn() }));
vi.mock('@/lib/coolify/client', async (importOriginal) => {
  // Partial: the sentinel the poll reads (`COOLIFY_STATUS_UNREPORTED`) has to be the
  // real one, or the poll test would assert against a value it made up itself.
  const actual = await importOriginal<typeof CoolifyClient>();
  return {
    ...actual,
    addApplicationDomain: vi.fn(),
    createApplication: vi.fn(),
    getCoolifyDeployment: vi.fn(),
    triggerDeploy: vi.fn(),
  };
});
vi.mock('@/lib/coolify/servers', () => ({
  pickCoolifyServer: vi.fn(),
  serverAuth: () => ({ apiUrl: 'https://coolify.test', apiToken: 'stub' }),
}));
vi.mock('@/lib/integrations/store', () => ({ getRootDomain: vi.fn() }));
vi.mock('@/lib/domains/redirects', () => ({ applyPrimaryRedirects: vi.fn() }));
// Dynamic: the loop's provider imports must resolve to the mocks above, which only exist
// once the factories are registered.
const { runPublishJob } = await import('@/lib/publish/execute');
const { COOLIFY_STATUS_UNREPORTED } = await import('@/lib/coolify/client');
const { PUBLISH_UNREPORTED_STATUS_READS } = await import('@/lib/publish/constants');

const JOB = 'job_republish';
const PROJECT = 'proj_1';
const DEPLOYMENT = 'dep_preview';
const APP_UUID = 'coolify-app-existing';
const ROOT = 'navroop.test';
const SLUG = 'shop';

const SERVER: PublishServer = {
  id: 'srv_1',
  apiUrl: 'https://coolify.test',
  apiToken: 'stub',
  serverIp: '203.0.113.10',
  projectUuid: 'coolify-project-1',
};

type Seen = {
  pushed: Record<string, string>;
  addedHost: string | null;
  addedTo: string | null;
  redirectsFor: string | null;
  order: string[];
};

function spyDeps(): { deps: PublishDeps; seen: Seen } {
  const seen: Seen = { pushed: {}, addedHost: null, addedTo: null, redirectsFor: null, order: [] };
  const deps: PublishDeps = {
    async collectFiles() {
      return { 'app/page.tsx': 'export default () => null;' };
    },
    async pickServer() {
      return SERVER;
    },
    async rootDomain() {
      return ROOT;
    },
    async ensureRepo() {
      return { fullName: `deploy-org/preview-${SLUG}`, repoId: 'repo-id-existing', created: false };
    },
    async pushFiles(_repoFullName, files) {
      seen.pushed = files;
      return 'commit-sha-1';
    },
    async createApp() {
      return { uuid: APP_UUID };
    },
    async upsertDns() {
      return 'dns-record-existing';
    },
    async addAppDomain(_auth, appUuid, host) {
      seen.order.push('addAppDomain');
      seen.addedTo = appUuid;
      seen.addedHost = host;
    },
    async applyRedirects(deploymentId) {
      seen.order.push('applyRedirects');
      seen.redirectsFor = deploymentId;
    },
    // Deliberately not pushed onto `seen.order`: that list is the domain/redirect
    // ordering invariant this file owns. The pin-before-deploy ordering is asserted
    // in tests/integration/publish-execute.test.ts.
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

/** A preview that is already live, i.e. exactly the row `updatePreviewPassword` re-publishes. */
function seedLivePreview(passwordHash: string | null) {
  db.deploymentFindUnique.mockResolvedValue({
    id: DEPLOYMENT,
    projectId: PROJECT,
    workspaceId: 'default',
    serverId: SERVER.id,
    kind: 'PREVIEW',
    status: 'LIVE',
    slug: SLUG,
    url: `https://preview-${SLUG}.${ROOT}`,
    publishedAt: new Date('2026-08-01T00:00:00.000Z'),
    passwordHash,
    coolifyAppUuid: APP_UUID,
    dnsRecordId: 'dns-record-existing',
    repoFullName: `deploy-org/preview-${SLUG}`,
    repoBranch: 'main',
    buildLogUrl: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  jobs.getJob.mockResolvedValue({
    id: JOB,
    projectId: PROJECT,
    status: 'QUEUED',
    inputPrompt: 'PREVIEW',
    requestId: 'req-1',
    steps: [],
    // A re-publish starts from the persisted resources, so app/dns short-circuit and the
    // loop reaches the domain step against the existing application.
    resourceIds: {
      githubRepo: `deploy-org/preview-${SLUG}`,
      coolifyAppUuid: APP_UUID,
      dnsRecordId: 'dns-record-existing',
    },
  });
  db.projectFindFirst.mockResolvedValue({ id: PROJECT, name: 'Shop', stack: 'NEXTJS' });
  db.serverFindUniqueOrThrow.mockResolvedValue(SERVER);
  db.deploymentUpdate.mockResolvedValue({});
  db.projectUpdate.mockResolvedValue({});
  seedLivePreview(null);
});

describe('runPublishJob — domain step', () => {
  it('merges the publish host and re-applies the primary redirects', async () => {
    const { deps, seen } = spyDeps();

    await runPublishJob(JOB, deps);

    expect(seen.addedTo).toBe(APP_UUID);
    expect(seen.addedHost).toBe(`preview-${SLUG}.${ROOT}`);
    // Order matters: the redirect set is authoritative, so it has to be written last.
    expect(seen.order).toEqual(['addAppDomain', 'applyRedirects']);
    expect(seen.redirectsFor).toBe(DEPLOYMENT);
    expect(lifecycle.succeedJob).toHaveBeenCalledWith(JOB, { lastStep: 'live' });
  });
});

describe('runPublishJob — preview password gate', () => {
  it('embeds the Basic-Auth gate when the deployment carries a password hash', async () => {
    seedLivePreview('$2b$12$notarealhashnotarealhashnotarealhashnotarealhashnotar');
    const { deps, seen } = spyDeps();

    await runPublishJob(JOB, deps);

    const middleware = seen.pushed['middleware.ts'];
    expect(middleware).toContain('PREVIEW_PASSWORD');
    expect(middleware).toContain('unauthorized()');
    // Fail closed: no env var on the app means no gate, and serving the preview open is
    // exactly the hole this branch exists to close.
    expect(middleware).toContain('if (!expected) return unauthorized();');
    // The hash never travels to the deploy repo; the plaintext lives on the Coolify app.
    expect(JSON.stringify(seen.pushed)).not.toContain('$2b$12$');
  });

  it('ships no gate when no password is set, but still blocks indexing', async () => {
    const { deps, seen } = spyDeps();

    await runPublishJob(JOB, deps);

    const middleware = seen.pushed['middleware.ts'];
    expect(middleware).toContain('X-Robots-Tag');
    expect(middleware).not.toContain('PREVIEW_PASSWORD');
    expect(middleware).not.toContain('unauthorized()');
  });
});

/**
 * A build whose status Coolify never named.
 *
 * `getCoolifyDeployment` used to read `String(row.status ?? row.fqdn ?? '')`, so a
 * response without `status` was answered from the application's hostname list — a host
 * containing `error` read as `failed`, anything else read as `building`. The client now
 * returns the `COOLIFY_STATUS_UNREPORTED` sentinel instead of inventing a status, and
 * this is the other half: the poll has to act on it. Reading it as a queue state means
 * ten minutes of polling and then "did not finish this build within 10 minutes" for a
 * site that may well be up (F-218).
 */
describe('runPublishJob — poll with no status from Coolify', () => {
  it('gives up after a bounded number of unreported reads and says why', async () => {
    vi.useFakeTimers();
    try {
      const { deps } = spyDeps();
      let reads = 0;
      deps.deploymentStatus = async () => {
        reads += 1;
        return { health: 'building' as const, status: COOLIFY_STATUS_UNREPORTED };
      };

      // The assertion is attached before the timers run so the rejection is never
      // unhandled: `runPublishJob` fails the job and then rethrows.
      const settled = expect(runPublishJob(JOB, deps)).rejects.toThrow(
        /Coolify did not report a status/,
      );
      await vi.runAllTimersAsync();
      await settled;

      // Bounded: the ten-minute deadline would have allowed 120 reads.
      expect(reads).toBe(PUBLISH_UNREPORTED_STATUS_READS);
      expect(lifecycle.succeedJob).not.toHaveBeenCalled();
      expect(lifecycle.failJob).toHaveBeenCalledWith(
        JOB,
        expect.objectContaining({
          errorMessage: expect.stringContaining('Coolify did not report a status'),
        }),
      );
      // Not the timeout sentence — that one tells the user to wait for a build Coolify
      // is not talking about.
      const [, fields] = lifecycle.failJob.mock.calls[0] as [string, { errorMessage: string }];
      expect(fields.errorMessage).not.toContain('within 10 minutes');
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries on when a later read does name a status', async () => {
    vi.useFakeTimers();
    try {
      const { deps } = spyDeps();
      let reads = 0;
      deps.deploymentStatus = async () => {
        reads += 1;
        return reads === 1
          ? { health: 'building' as const, status: COOLIFY_STATUS_UNREPORTED }
          : { health: 'healthy' as const, status: 'finished' };
      };

      const run = runPublishJob(JOB, deps);
      await vi.runAllTimersAsync();
      await run;

      expect(lifecycle.succeedJob).toHaveBeenCalledWith(JOB, { lastStep: 'live' });
      expect(lifecycle.failJob).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
