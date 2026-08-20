import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PublishFiles from '@/lib/publish/files';
import type * as CoolifyClient from '@/lib/coolify/client';
import type { PublishDeps, PublishServer } from '@/lib/publish/execute';

/**
 * Images the generated site points at have to travel with it (F-262).
 *
 * A `ProjectAsset` — uploaded, AI-generated, stock, or rehosted from an imported page —
 * lives in object storage and is served by *this* app at `/uploads/…`. The generated
 * markup carries that exact URL, because the asset manifest the model reads
 * (`lib/assets/manifest.ts`) hands it the row's `url` verbatim. Publish collected only
 * the checkpoint snapshot, so every one of those `<img src>`s 404'd on the deployed
 * site while the publish job reported success.
 *
 * The two failure modes are deliberately not the same thing. Storage distinguishes
 * "genuinely absent" (`get` → null) from "could not look" (`get` throws — credentials,
 * throttling, network), and neither may be swallowed: a publish that quietly drops an
 * image ships a site with a hole in it and calls it done.
 */

const db = vi.hoisted(() => ({
  deploymentFindUnique: vi.fn(),
  deploymentUpdate: vi.fn(),
  projectFindFirst: vi.fn(),
  projectUpdate: vi.fn(),
  serverFindUniqueOrThrow: vi.fn(),
  assetFindMany: vi.fn(),
}));
const storage = vi.hoisted(() => ({ get: vi.fn() }));
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
    projectAsset: { findMany: db.assetFindMany },
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 1),
  },
}));
// `upload` is here for the checkpoint snapshot store, which sits in the publish import
// graph and destructures it at module scope; only `get` is exercised.
vi.mock('@/lib/storage', () => ({ get: storage.get, upload: vi.fn() }));
vi.mock('@/lib/jobs/store', () => ({
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
  // Only the snapshot reader is stubbed. `publishJobErrorCode` stays real: the code a
  // failed asset is filed under is part of what these cases assert.
  const actual = await importOriginal<typeof PublishFiles>();
  return { ...actual, collectPublishFiles: vi.fn() };
});
vi.mock('@/lib/github/deploy-client', () => ({ ensureDeployRepo: vi.fn(), pushFiles: vi.fn() }));
vi.mock('@/lib/cloudflare/dns', () => ({ upsertARecord: vi.fn() }));
vi.mock('@/lib/coolify/client', async (importOriginal) => {
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

const { runPublishJob } = await import('@/lib/publish/execute');
const { collectPublishAssets, publishAssetPath, PublishAssetError } =
  await import('@/lib/publish/assets');

const JOB = 'job_publish_assets';
const PROJECT = 'proj_assets';
const DEPLOYMENT = 'dep_live_assets';
const APP_UUID = 'coolify-app-assets';
const ROOT = 'navroop.test';
const SLUG = 'gallery';

/** What `lib/storage` hands out for a local-driver object, and what the manifest shows the model. */
const ASSET_URL = '/uploads/projects/proj_assets/assets/hero.webp';
const ASSET_KEY = 'projects/proj_assets/assets/hero.webp';
const ASSET_BYTES = Buffer.from('webp-bytes');
const ASSET_BASE64 = ASSET_BYTES.toString('base64');

/** A page that points at the asset exactly the way the manifest told the model to. */
const PAGE = `export default () => <img src="${ASSET_URL}" alt="Hero" />;`;

const SERVER: PublishServer = {
  id: 'srv_assets',
  apiUrl: 'https://coolify.test',
  apiToken: 'stub',
  serverIp: '203.0.113.20',
  projectUuid: 'coolify-project-assets',
};

type Seen = { pushed: Record<string, unknown>; pushes: number };

function spyDeps(): { deps: PublishDeps; seen: Seen } {
  const seen: Seen = { pushed: {}, pushes: 0 };
  const deps: PublishDeps = {
    async collectFiles() {
      return { 'app/page.tsx': PAGE };
    },
    // The real collector, driven by the mocked storage and asset rows: what these cases
    // are about is whether publish ships what it reads, so stubbing it out would leave
    // the assembly untested.
    collectAssets: collectPublishAssets,
    async pickServer() {
      return SERVER;
    },
    async rootDomain() {
      return ROOT;
    },
    async ensureRepo() {
      return { fullName: `deploy-org/${SLUG}`, repoId: 'repo-id-assets', created: false };
    },
    async pushFiles(_repoFullName, files) {
      seen.pushes += 1;
      seen.pushed = files;
      return 'commit-sha-assets';
    },
    async createApp() {
      return { uuid: APP_UUID };
    },
    async upsertDns() {
      return 'dns-record-assets';
    },
    async addAppDomain() {},
    async applyRedirects() {},
    async pinCommit(_auth, _appUuid, sha) {
      return { ok: true as const, sha };
    },
    async startDeploy() {
      return { deploymentUuid: 'coolify-deployment-assets' };
    },
    async deploymentStatus() {
      return { health: 'healthy', status: 'finished' };
    },
  };
  return { deps, seen };
}

beforeEach(() => {
  vi.clearAllMocks();
  jobs.getJob.mockResolvedValue({
    id: JOB,
    projectId: PROJECT,
    status: 'QUEUED',
    inputPrompt: 'LIVE',
    requestId: 'req-assets',
    steps: [],
    resourceIds: {
      githubRepo: `deploy-org/${SLUG}`,
      coolifyAppUuid: APP_UUID,
      dnsRecordId: 'dns-record-assets',
    },
  });
  db.projectFindFirst.mockResolvedValue({ id: PROJECT, name: 'Gallery', stack: 'NEXTJS' });
  db.serverFindUniqueOrThrow.mockResolvedValue(SERVER);
  db.deploymentUpdate.mockResolvedValue({});
  db.projectUpdate.mockResolvedValue({});
  db.deploymentFindUnique.mockResolvedValue({
    id: DEPLOYMENT,
    projectId: PROJECT,
    workspaceId: 'default',
    serverId: SERVER.id,
    kind: 'LIVE',
    status: 'LIVE',
    slug: SLUG,
    url: `https://${SLUG}.${ROOT}`,
    publishedAt: new Date('2026-08-01T00:00:00.000Z'),
    passwordHash: null,
    coolifyAppUuid: APP_UUID,
    dnsRecordId: 'dns-record-assets',
    repoFullName: `deploy-org/${SLUG}`,
    repoBranch: 'main',
    buildLogUrl: null,
  });
  db.assetFindMany.mockResolvedValue([{ url: ASSET_URL, storageKey: ASSET_KEY }]);
  storage.get.mockResolvedValue(ASSET_BYTES);
});

describe('runPublishJob — project assets', () => {
  it('ships the asset at the path the generated markup points at', async () => {
    const { deps, seen } = spyDeps();

    await runPublishJob(JOB, deps);

    // NEXTJS serves `public/` at the web root, so this is the file that answers
    // `/uploads/projects/proj_assets/assets/hero.webp` on the deployed site.
    expect(seen.pushed['public/uploads/projects/proj_assets/assets/hero.webp']).toEqual({
      base64: ASSET_BASE64,
    });
    // The page that references it still ships as text, unchanged.
    expect(seen.pushed['app/page.tsx']).toBe(PAGE);
    expect(storage.get).toHaveBeenCalledWith(ASSET_KEY);
    expect(lifecycle.succeedJob).toHaveBeenCalledWith(JOB, { lastStep: 'live' });
  });

  it('fails the publish when a referenced asset cannot be read, rather than shipping a hole', async () => {
    // Not "absent": a permission or network failure means we could not look. Skipping it
    // would deploy a site with a broken image under a green publish job.
    storage.get.mockRejectedValue(new Error('AccessDenied'));
    const { deps, seen } = spyDeps();

    await expect(runPublishJob(JOB, deps)).rejects.toThrow(/hero\.webp/);

    expect(seen.pushes).toBe(0);
    expect(lifecycle.succeedJob).not.toHaveBeenCalled();
    expect(lifecycle.failJob).toHaveBeenCalledWith(JOB, {
      errorCode: 'asset_unpublishable',
      errorMessage: expect.stringContaining(ASSET_URL),
    });
  });

  it('fails the publish when a referenced asset is gone from storage', async () => {
    storage.get.mockResolvedValue(null);
    const { deps, seen } = spyDeps();

    await expect(runPublishJob(JOB, deps)).rejects.toThrow(/no longer in storage/);

    expect(seen.pushes).toBe(0);
    expect(lifecycle.failJob).toHaveBeenCalledWith(JOB, {
      errorCode: 'asset_unpublishable',
      errorMessage: expect.stringContaining(ASSET_URL),
    });
  });
});

describe('collectPublishAssets', () => {
  const files = { 'app/page.tsx': PAGE };

  it('includes only assets the published files reference', async () => {
    db.assetFindMany.mockResolvedValue([
      { url: ASSET_URL, storageKey: ASSET_KEY },
      // Uploaded months ago and never placed. Shipping the whole library would bloat
      // every commit and count against the push size guards for nothing.
      { url: '/uploads/projects/proj_assets/assets/unused.webp', storageKey: 'unused.webp' },
    ]);

    await expect(
      collectPublishAssets({ projectId: PROJECT, stack: 'NEXTJS', files }),
    ).resolves.toEqual({
      'public/uploads/projects/proj_assets/assets/hero.webp': { base64: ASSET_BASE64 },
    });
    expect(storage.get).toHaveBeenCalledTimes(1);
  });

  it('puts the asset at the repo root for a stack whose repo root is the web root', async () => {
    // STATIC_HTML's Dockerfile copies `.` into the nginx html root, so a `public/`
    // prefix would become part of the URL instead of being stripped from it.
    await expect(
      collectPublishAssets({ projectId: PROJECT, stack: 'STATIC_HTML', files }),
    ).resolves.toEqual({
      'uploads/projects/proj_assets/assets/hero.webp': { base64: ASSET_BASE64 },
    });
  });

  it('leaves an absolute asset URL alone — the deployed site fetches it from the bucket', async () => {
    const remote = 'https://cdn.example.test/projects/proj_assets/assets/hero.webp';
    db.assetFindMany.mockResolvedValue([{ url: remote, storageKey: ASSET_KEY }]);

    await expect(
      collectPublishAssets({
        projectId: PROJECT,
        stack: 'NEXTJS',
        files: { 'app/page.tsx': `<img src="${remote}" />` },
      }),
    ).resolves.toEqual({});
    expect(storage.get).not.toHaveBeenCalled();
  });

  it('reads nothing when the project has no assets', async () => {
    db.assetFindMany.mockResolvedValue([]);
    await expect(
      collectPublishAssets({ projectId: PROJECT, stack: 'NEXTJS', files }),
    ).resolves.toEqual({});
    expect(storage.get).not.toHaveBeenCalled();
  });

  it('names the asset and the reason when storage could not be read', async () => {
    const cause = new Error('ThrottlingException');
    storage.get.mockRejectedValue(cause);

    const failure = await collectPublishAssets({
      projectId: PROJECT,
      stack: 'NEXTJS',
      files,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PublishAssetError);
    const error = failure as InstanceType<typeof PublishAssetError>;
    expect(error.reason).toBe('unreadable');
    expect(error.message).toContain(ASSET_URL);
    expect(error.message).toContain('ThrottlingException');
    expect(error.cause).toBe(cause);
  });

  it('distinguishes an object that is genuinely gone', async () => {
    storage.get.mockResolvedValue(null);

    const failure = await collectPublishAssets({
      projectId: PROJECT,
      stack: 'NEXTJS',
      files,
    }).catch((error: unknown) => error);

    expect((failure as InstanceType<typeof PublishAssetError>).reason).toBe('missing');
  });
});

describe('publishAssetPath', () => {
  it('maps an app-relative URL under the stack public directory', () => {
    expect(publishAssetPath('public', '/uploads/a/b.webp')).toBe('public/uploads/a/b.webp');
    expect(publishAssetPath('', '/uploads/a/b.webp')).toBe('uploads/a/b.webp');
  });

  it('drops the query and fragment a rewritten src may carry', () => {
    expect(publishAssetPath('public', '/uploads/a/b.webp?v=2#x')).toBe('public/uploads/a/b.webp');
  });

  it('refuses a protocol-relative URL, which is remote despite the leading slash', () => {
    expect(publishAssetPath('public', '//cdn.example.test/b.webp')).toBeNull();
  });

  it('refuses a traversal, so an asset row can never place a file outside the tree', () => {
    expect(publishAssetPath('public', '/uploads/../../etc/passwd')).toBeNull();
  });

  it('refuses a data URL and an empty path', () => {
    expect(publishAssetPath('public', 'data:image/webp;base64,AAA')).toBeNull();
    expect(publishAssetPath('public', '/')).toBeNull();
  });
});
