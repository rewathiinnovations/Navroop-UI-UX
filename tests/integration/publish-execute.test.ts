import '../setup/env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import type { CreateApplicationInput, DeploymentHealth } from '@/lib/coolify/client';
import { getJob, insertJobRaw, updateJobFields } from '@/lib/jobs/store';
import { runPublishJob, type PublishDeps, type PublishServer } from '@/lib/publish/execute';
import type { PublishAssetFile } from '@/lib/publish/assets';
import type { PushFileEntry } from '@/lib/github/deploy-client';
import { DEFAULT_DEPLOY_BRANCH } from '@/lib/publish/constants';
import { coolifyAppName, deployRepoName, dnsLabel } from '@/lib/publish/naming';
import { PUBLISH_STEPS } from '@/lib/publish/steps';

/**
 * The shipped publish orchestrator, `lib/publish/execute.ts`.
 *
 * What read as the strongest publish coverage in this repo actually tested
 * `lib/publish/runner.ts` — a replica of this loop whose `limit`, `files`, `slug`,
 * `domain`, `deploy`, `poll` and `live` steps were `async () => {}`, and whose
 * create-once guarantee was an in-process `Map` that never existed in production. The
 * replica's only importer was that test, so every step-ordering, resource-persistence
 * and repo-reuse regression in the real path went uncovered: `execute.ts` measured 0%.
 *
 * These cases drive `runPublishJob` itself with the Coolify / GitHub App / Cloudflare
 * clients injected, and assert on rows Postgres actually holds. That is not incidental:
 * the publish sheet and `/admin/jobs` read `GenerationJob.steps` / `resourceIds` and the
 * `Deployment` row, and a browser closed mid-publish leaves nothing else behind.
 */

const prisma = testPrismaClient();

const USER = 'user_publish_execute';
const WS = 'ws_publish_execute';
const SLUG_PREFIX = 'pubx';

/** One project per case: `one_active_job_per_project` is unique and every case runs a job. */
type CaseKey =
  | 'happy'
  | 'kill'
  | 'appfail'
  | 'resume'
  | 'settled'
  | 'unhealthy'
  | 'preview'
  | 'relive'
  | 'scaffold'
  | 'concurrent'
  | 'stalepoll'
  | 'nouuid'
  | 'pin';

const projectId = (key: CaseKey) => `proj_${SLUG_PREFIX}_${key}`;
const serverId = (key: CaseKey) => `srv_${SLUG_PREFIX}_${key}`;
/** `slugFromName` lowercases and hyphenates the project name, so this is what gets claimed. */
const expectedSlug = (key: CaseKey) => `${SLUG_PREFIX}-${key}`;

const SERVER_IP = '203.0.113.77';
const SERVER_API_URL = 'https://coolify.example.test';
const ROOT = 'example.test';

type SeededCase = {
  projectId: string;
  deploymentId: string;
  server: PublishServer;
};

async function cleanup() {
  await prisma.$executeRaw`
    DELETE FROM "GenerationJob" WHERE "projectId" LIKE ${`proj_${SLUG_PREFIX}_%`}
  `.catch(() => undefined);
  // Slug-prefixed as well as project-scoped: a claimed slug is unique per kind, so a row
  // left behind by an earlier run would push this run's claim onto `-2` and silently
  // change every host assertion below.
  await prisma.deployment
    .deleteMany({
      where: {
        OR: [
          { projectId: { startsWith: `proj_${SLUG_PREFIX}_` } },
          { slug: { startsWith: SLUG_PREFIX } },
        ],
      },
    })
    .catch(() => undefined);
  await prisma.project
    .deleteMany({ where: { id: { startsWith: `proj_${SLUG_PREFIX}_` } } })
    .catch(() => undefined);
  await prisma.coolifyServer
    .deleteMany({ where: { id: { startsWith: `srv_${SLUG_PREFIX}_` } } })
    .catch(() => undefined);
}

async function seedCase(input: {
  key: CaseKey;
  kind: 'LIVE' | 'PREVIEW';
  /** Seeds a deployment that is already serving, i.e. a re-publish rather than a first publish. */
  alreadyLive?: {
    slug: string;
    repoFullName: string;
    coolifyAppUuid: string;
    dnsRecordId: string;
  };
}): Promise<SeededCase> {
  const id = projectId(input.key);
  await prisma.project.upsert({
    where: { id },
    create: {
      id,
      name: `${SLUG_PREFIX} ${input.key}`,
      ownerId: USER,
      initialPrompt: 'publish execute probe',
    },
    update: { name: `${SLUG_PREFIX} ${input.key}`, status: 'draft' },
  });
  const server = await prisma.coolifyServer.upsert({
    where: { id: serverId(input.key) },
    create: {
      id: serverId(input.key),
      name: `coolify-${input.key}`,
      apiUrl: SERVER_API_URL,
      apiToken: 'not-a-real-token',
      serverIp: SERVER_IP,
      projectUuid: `project-uuid-${input.key}`,
    },
    update: {},
  });
  const deployment = await prisma.deployment.create({
    data: {
      projectId: id,
      workspaceId: WS,
      serverId: server.id,
      kind: input.kind,
      status: input.alreadyLive ? 'LIVE' : 'QUEUED',
      slug: input.alreadyLive?.slug ?? `pending-${input.key}`,
      repoFullName: input.alreadyLive?.repoFullName ?? null,
      coolifyAppUuid: input.alreadyLive?.coolifyAppUuid ?? null,
      dnsRecordId: input.alreadyLive?.dnsRecordId ?? null,
      publishedById: USER,
      publishedAt: input.alreadyLive ? new Date('2026-08-01T00:00:00.000Z') : null,
      progressStep: 'limit',
    },
  });
  return {
    projectId: id,
    deploymentId: deployment.id,
    server: {
      id: server.id,
      apiUrl: server.apiUrl,
      apiToken: server.apiToken,
      serverIp: server.serverIp,
      projectUuid: server.projectUuid,
    },
  };
}

/** The same rows `startPublishJob` writes before it hands the job to the runner. */
async function queuePublishJob(seeded: SeededCase, kind: 'LIVE' | 'PREVIEW') {
  const deployment = await prisma.deployment.findUniqueOrThrow({
    where: { id: seeded.deploymentId },
  });
  const job = await insertJobRaw({
    projectId: seeded.projectId,
    workspaceId: WS,
    userId: USER,
    kind: 'PUBLISH',
    status: 'QUEUED',
    inputPrompt: kind,
  });
  await updateJobFields(job.id, {
    steps: PUBLISH_STEPS.map((step) => ({
      key: step.key,
      label: step.label,
      status: 'pending' as const,
      startedAt: null,
      finishedAt: null,
      error: null,
    })),
    currentStep: 'limit',
    resourceIds: {
      githubRepo: deployment.repoFullName,
      coolifyAppUuid: deployment.coolifyAppUuid,
      dnsRecordId: deployment.dnsRecordId,
    },
  });
  return job.id;
}

type PublishSpy = {
  deps: PublishDeps;
  calls: string[];
  counts: Record<keyof PublishDeps, number>;
  seen: {
    repoSlug: string | null;
    pushedTo: string | null;
    pushedPaths: string[];
    /** The ref the push wrote. Must be the branch Coolify is told to build (F-253). */
    pushedBranch: string | null;
    pushedFiles: Record<string, PushFileEntry>;
    createApp: CreateApplicationInput | null;
    dnsLabel: string | null;
    dnsIp: string | null;
    domainHost: string | null;
    redirectsFor: string | null;
    deployedUuid: string | null;
    polledDeploymentUuid: string | null;
    /** The commit the loop pinned the application to before deploying (F-264). */
    pinnedSha: string | null;
  };
};

/**
 * A complete `PublishDeps`. Deliberately not `Partial`: `runPublishJob`'s parameter is the
 * full bundle, so adding a provider call to the loop is a compile error here rather than a
 * test that quietly starts talking to a live Coolify.
 */
function publishSpy(
  server: PublishServer,
  options: {
    files?: Record<string, string>;
    /** Project images, keyed by repo path, as `collectPublishAssets` would have resolved them. */
    assets?: Record<string, PublishAssetFile>;
    appUuid?: string;
    dnsRecordId?: string;
    health?: DeploymentHealth;
    /** What `startDeploy` hands back; `null` models Coolify returning no deployment id. */
    deploymentUuid?: string | null;
    /**
     * Successive `deploymentStatus` answers, so a build can be observed still running
     * before it settles. The last entry repeats once the list runs out.
     */
    statuses?: Array<{ health: DeploymentHealth; status: string }>;
    /** Models an org repo that already exists — the F-202 guard decides from its id. */
    existingRepo?: { repoId: string };
    /** Runs inside `upsertDns` before it returns; throwing here fails the `dns` step. */
    onDns?: () => Promise<void>;
    onCreateApp?: () => Promise<void>;
    /** Models Coolify accepting the pin write but not applying it. */
    pinRefusal?: string;
  } = {},
): PublishSpy {
  const calls: string[] = [];
  const counts: Record<keyof PublishDeps, number> = {
    collectFiles: 0,
    collectAssets: 0,
    pickServer: 0,
    rootDomain: 0,
    ensureRepo: 0,
    pushFiles: 0,
    createApp: 0,
    upsertDns: 0,
    addAppDomain: 0,
    applyRedirects: 0,
    pinCommit: 0,
    startDeploy: 0,
    deploymentStatus: 0,
  };
  const seen: PublishSpy['seen'] = {
    repoSlug: null,
    pushedTo: null,
    pushedPaths: [],
    pushedBranch: null,
    pushedFiles: {},
    createApp: null,
    dnsLabel: null,
    dnsIp: null,
    domainHost: null,
    redirectsFor: null,
    deployedUuid: null,
    polledDeploymentUuid: null,
    pinnedSha: null,
  };
  const record = (name: keyof PublishDeps) => {
    calls.push(name);
    counts[name] += 1;
  };

  const deps: PublishDeps = {
    async collectFiles() {
      record('collectFiles');
      return options.files ?? { 'app/page.tsx': 'export default function Page() { return null; }' };
    },
    async collectAssets() {
      record('collectAssets');
      return options.assets ?? {};
    },
    async pickServer() {
      record('pickServer');
      return server;
    },
    async rootDomain() {
      record('rootDomain');
      return ROOT;
    },
    async ensureRepo(repoSlug) {
      record('ensureRepo');
      seen.repoSlug = repoSlug;
      // Default: the repo did not exist and this call created it, as on a first publish.
      return options.existingRepo
        ? {
            fullName: `deploy-org/${repoSlug}`,
            repoId: options.existingRepo.repoId,
            created: false,
          }
        : { fullName: `deploy-org/${repoSlug}`, repoId: `repo-id-${repoSlug}`, created: true };
    },
    async pushFiles(repoFullName, files, _message, _workspaceId, branch) {
      record('pushFiles');
      seen.pushedTo = repoFullName;
      seen.pushedPaths = Object.keys(files).sort();
      seen.pushedFiles = files;
      seen.pushedBranch = branch;
      return 'commit-sha-1';
    },
    async createApp(_auth, input) {
      record('createApp');
      seen.createApp = input;
      if (options.onCreateApp) await options.onCreateApp();
      return { uuid: options.appUuid ?? 'coolify-app-1' };
    },
    async upsertDns(label, ip) {
      record('upsertDns');
      seen.dnsLabel = label;
      seen.dnsIp = ip;
      if (options.onDns) await options.onDns();
      return options.dnsRecordId ?? 'dns-record-1';
    },
    async addAppDomain(_auth, appUuid, host) {
      record('addAppDomain');
      seen.domainHost = host;
      seen.deployedUuid = appUuid;
    },
    async applyRedirects(deploymentId) {
      record('applyRedirects');
      seen.redirectsFor = deploymentId;
    },
    async pinCommit(_auth, _appUuid, sha) {
      record('pinCommit');
      seen.pinnedSha = sha;
      return options.pinRefusal
        ? { ok: false as const, error: options.pinRefusal }
        : { ok: true as const, sha };
    },
    async startDeploy(_auth, appUuid) {
      record('startDeploy');
      seen.deployedUuid = appUuid;
      return {
        deploymentUuid:
          options.deploymentUuid === undefined ? 'coolify-deployment-1' : options.deploymentUuid,
      };
    },
    async deploymentStatus(_auth, deploymentUuid) {
      record('deploymentStatus');
      seen.polledDeploymentUuid = deploymentUuid;
      if (options.statuses?.length) {
        // Repeat the last answer: a build that never settles must time the poll out
        // rather than run off the end of the list.
        const index = Math.min(counts.deploymentStatus - 1, options.statuses.length - 1);
        return options.statuses[index];
      }
      const health = options.health ?? 'healthy';
      return { health, status: health === 'healthy' ? 'finished' : 'failed' };
    },
  };

  return { deps, calls, counts, seen };
}

/**
 * A pushed entry read as text. Since F-262 the commit also carries the project's images,
 * which are `{ base64 }` and have no text form — asserting on one as a string would
 * compare against `undefined` and pass for the wrong reason.
 */
function pushedText(spy: PublishSpy, path: string): string {
  const entry = spy.seen.pushedFiles[path];
  if (typeof entry !== 'string') {
    throw new Error(`${path} was not pushed as text: ${JSON.stringify(entry)}`);
  }
  return entry;
}

function stepStatuses(steps: Array<{ key: string; status: string }> | null | undefined) {
  return Object.fromEntries((steps ?? []).map((step) => [step.key, step.status]));
}

beforeAll(async () => {
  await prisma.workspace.upsert({
    where: { id: WS },
    create: { id: WS, storageBytes: 0 },
    update: {},
  });
  await prisma.user.upsert({
    where: { id: USER },
    create: {
      id: USER,
      email: 'publish-execute@example.com',
      name: 'Publish Execute',
      role: 'MEMBER',
      passwordHash: 'not-a-real-hash',
    },
    update: {},
  });
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await prisma.user.deleteMany({ where: { id: USER } }).catch(() => undefined);
  await prisma.$executeRaw`DELETE FROM "Workspace" WHERE id = ${WS}`.catch(() => undefined);
  await prisma.$disconnect();
});

describe('runPublishJob — the shipped ten-step loop', () => {
  it('runs the steps in order and persists each resource id as it is created', async () => {
    const seeded = await seedCase({ key: 'happy', kind: 'LIVE' });
    const jobId = await queuePublishJob(seeded, 'LIVE');

    // Read Postgres at the instant DNS is being created. "The Coolify uuid is recorded in
    // the job before DNS" only means something if the row already carries it while
    // `upsertDns` is in flight — checking after the run would pass either way.
    let uuidVisibleWhenDnsRan: string | null | undefined;
    let dnsVisibleWhenDnsRan: string | null | undefined;
    const spy = publishSpy(seeded.server, {
      async onDns() {
        const row = await getJob(jobId);
        uuidVisibleWhenDnsRan = row?.resourceIds?.coolifyAppUuid;
        dnsVisibleWhenDnsRan = row?.resourceIds?.dnsRecordId;
      },
    });

    await runPublishJob(jobId, spy.deps);

    expect(spy.calls).toEqual([
      'collectFiles',
      // Immediately after the code, and before anything external: which images the site
      // needs is decided by the file set that is about to become the commit (F-262).
      'collectAssets',
      'pickServer',
      'rootDomain',
      'ensureRepo',
      'pushFiles',
      'createApp',
      'upsertDns',
      'addAppDomain',
      'applyRedirects',
      'pinCommit',
      'startDeploy',
      'deploymentStatus',
    ]);

    expect(uuidVisibleWhenDnsRan).toBe('coolify-app-1');
    // The other half of the ordering claim: DNS is not recorded before it exists.
    expect(dnsVisibleWhenDnsRan).toBeNull();

    const job = await getJob(jobId);
    expect(job?.status).toBe('SUCCEEDED');
    expect(job?.currentStep).toBe('live');
    expect(job?.lastStep).toBe('live');
    expect((job?.steps ?? []).map((step) => step.key)).toEqual(
      PUBLISH_STEPS.map((step) => step.key),
    );
    expect((job?.steps ?? []).map((step) => step.status)).toEqual(
      PUBLISH_STEPS.map(() => 'succeeded'),
    );
    expect(job?.resourceIds).toMatchObject({
      githubRepo: `deploy-org/${expectedSlug('happy')}`,
      coolifyAppUuid: 'coolify-app-1',
      dnsRecordId: 'dns-record-1',
      // The build this job triggered, recorded so a resumed `poll` can still find it.
      coolifyDeploymentUuid: 'coolify-deployment-1',
    });

    const deployment = await prisma.deployment.findUniqueOrThrow({
      where: { id: seeded.deploymentId },
    });
    expect(deployment.slug).toBe(expectedSlug('happy'));
    expect(deployment.status).toBe('LIVE');
    expect(deployment.url).toBe(`https://${expectedSlug('happy')}.${ROOT}`);
    expect(deployment.coolifyAppUuid).toBe('coolify-app-1');
    expect(deployment.dnsRecordId).toBe('dns-record-1');
    expect(deployment.commitSha).toBe('commit-sha-1');
    expect(deployment.repoFullName).toBe(`deploy-org/${expectedSlug('happy')}`);
    expect(deployment.buildLogUrl).toBe(`${SERVER_API_URL}/application/coolify-app-1`);
    expect(deployment.lastRequestId).toBe('coolify-deployment-1');
    expect(deployment.publishedAt).not.toBeNull();
    expect(deployment.lastError).toBeNull();

    // Names are derived once and reused. Drift here is what puts DNS on one host and the
    // Coolify app on another.
    expect(spy.seen.repoSlug).toBe(deployRepoName(expectedSlug('happy'), 'LIVE'));
    expect(spy.seen.pushedTo).toBe(`deploy-org/${expectedSlug('happy')}`);
    expect(spy.seen.dnsLabel).toBe(dnsLabel(expectedSlug('happy'), 'LIVE'));
    expect(spy.seen.dnsIp).toBe(SERVER_IP);
    expect(spy.seen.domainHost).toBe(`${expectedSlug('happy')}.${ROOT}`);
    expect(spy.seen.createApp?.name).toBe(coolifyAppName(expectedSlug('happy'), 'LIVE'));
    expect(spy.seen.createApp?.domain).toBe(`${expectedSlug('happy')}.${ROOT}`);
    expect(spy.seen.createApp?.repoUrl).toBe(
      `https://github.com/deploy-org/${expectedSlug('happy')}`,
    );
    expect(spy.seen.createApp?.projectUuid).toBe('project-uuid-happy');
    // Coolify builds the branch the push wrote. These used to be two independent
    // expressions — `deployment.repoBranch || 'main'` for Coolify, a hardcoded
    // `refs/heads/main` in the push — so a non-default `repoBranch` would have had Coolify
    // deploying a ref nothing ever wrote (F-253).
    expect(spy.seen.pushedBranch).toBe(spy.seen.createApp?.branch);
    expect(spy.seen.pushedBranch).toBe(DEFAULT_DEPLOY_BRANCH);
    expect(spy.seen.deployedUuid).toBe('coolify-app-1');
    // Coolify builds `git_commit_sha` when the application carries one, and a rollback
    // (F-264) leaves it carrying an older release on purpose. Publish therefore re-pins
    // to the commit it just pushed; without this the build after a rollback would ship
    // the release the user had just rejected and report a successful publish.
    expect(spy.seen.pinnedSha).toBe('commit-sha-1');
    // The poll reads the deployment Coolify returned, never the application.
    expect(spy.seen.polledDeploymentUuid).toBe('coolify-deployment-1');

    const project = await prisma.project.findUniqueOrThrow({ where: { id: seeded.projectId } });
    expect(project.status).toBe('published');
  });

  it('a publish killed between Coolify and DNS leaves the Coolify step readable in the job row', async () => {
    const seeded = await seedCase({ key: 'kill', kind: 'LIVE' });
    const jobId = await queuePublishJob(seeded, 'LIVE');

    const spy = publishSpy(seeded.server, {
      async onDns() {
        // Not a retryable shape, so `withProviderRetry` must not call DNS a second time.
        throw new Error('publish process went away');
      },
    });

    await expect(runPublishJob(jobId, spy.deps)).rejects.toThrow('publish process went away');

    expect(spy.counts.createApp).toBe(1);
    expect(spy.counts.upsertDns).toBe(1);
    expect(spy.counts.addAppDomain).toBe(0);
    expect(spy.counts.startDeploy).toBe(0);

    // This is exactly what the reopened tab reads.
    const job = await getJob(jobId);
    expect(job?.status).toBe('FAILED');
    expect(job?.currentStep).toBe('dns');
    expect(stepStatuses(job?.steps)).toMatchObject({
      limit: 'succeeded',
      files: 'succeeded',
      slug: 'succeeded',
      github: 'succeeded',
      app: 'succeeded',
      dns: 'failed',
      domain: 'pending',
      deploy: 'pending',
      poll: 'pending',
      live: 'pending',
    });
    expect(job?.steps?.find((step) => step.key === 'dns')?.error).toBe('publish process went away');
    expect(job?.resourceIds?.coolifyAppUuid).toBe('coolify-app-1');
    expect(job?.resourceIds?.dnsRecordId).toBeNull();
  });

  it('control: a publish that dies inside the Coolify call records no uuid at all', async () => {
    // Pins the previous case to the `app` step's persist rather than to seeding: the same
    // failure on the wire one step earlier must leave `coolifyAppUuid` absent.
    const seeded = await seedCase({ key: 'appfail', kind: 'LIVE' });
    const jobId = await queuePublishJob(seeded, 'LIVE');

    const spy = publishSpy(seeded.server, {
      async onCreateApp() {
        throw new Error('coolify refused the application');
      },
    });

    await expect(runPublishJob(jobId, spy.deps)).rejects.toThrow('coolify refused the application');
    expect(spy.counts.createApp).toBe(1);
    expect(spy.counts.upsertDns).toBe(0);

    const job = await getJob(jobId);
    expect(job?.resourceIds?.coolifyAppUuid).toBeNull();
    // The step before it did persist, so this is a per-step write, not "nothing was saved".
    expect(job?.resourceIds?.githubRepo).toBe(`deploy-org/${expectedSlug('appfail')}`);
    expect(stepStatuses(job?.steps)).toMatchObject({
      github: 'succeeded',
      app: 'failed',
      dns: 'pending',
    });

    const deployment = await prisma.deployment.findUniqueOrThrow({
      where: { id: seeded.deploymentId },
    });
    expect(deployment.status).toBe('FAILED');
    expect(deployment.lastError).toBe('coolify refused the application');
  });

  it('resuming a re-queued job skips succeeded steps and creates each resource once', async () => {
    const seeded = await seedCase({ key: 'resume', kind: 'LIVE' });
    const jobId = await queuePublishJob(seeded, 'LIVE');

    const first = publishSpy(seeded.server, {
      async onDns() {
        throw new Error('publish process went away');
      },
    });
    await expect(runPublishJob(jobId, first.deps)).rejects.toThrow('publish process went away');
    expect(first.counts.ensureRepo).toBe(1);
    expect(first.counts.createApp).toBe(1);

    // Put the row back the way a retry does, then hand the same job to a fresh runner.
    await updateJobFields(jobId, {
      status: 'QUEUED',
      finishedAt: null,
      errorCode: null,
      errorMessage: null,
    });

    const second = publishSpy(seeded.server);
    await runPublishJob(jobId, second.deps);

    // The loop really reached the end on this pass, so the zeroes below are skips rather
    // than a run that never started.
    expect(second.counts.upsertDns).toBe(1);
    expect(second.counts.addAppDomain).toBe(1);
    expect(second.counts.deploymentStatus).toBe(1);
    expect(second.counts.ensureRepo).toBe(0);
    expect(second.counts.pushFiles).toBe(0);
    expect(second.counts.createApp).toBe(0);
    expect(second.counts.pickServer).toBe(0);

    // Create-once across the whole publish, not per attempt.
    expect(first.counts.createApp + second.counts.createApp).toBe(1);
    expect(first.counts.ensureRepo + second.counts.ensureRepo).toBe(1);

    // The job row is what resume reads, and it carries every id.
    const job = await getJob(jobId);
    expect(job?.status).toBe('SUCCEEDED');
    expect(job?.resourceIds).toMatchObject({
      githubRepo: `deploy-org/${expectedSlug('resume')}`,
      coolifyAppUuid: 'coolify-app-1',
      dnsRecordId: 'dns-record-1',
    });
    const deployment = await prisma.deployment.findUniqueOrThrow({
      where: { id: seeded.deploymentId },
    });
    expect(deployment.status).toBe('LIVE');
    expect(deployment.slug).toBe(expectedSlug('resume'));

    // Compensation ran after the first attempt, but it did not tear the Coolify app
    // down (`compensated: []` — the default adapters are not configured in this
    // suite). `compensateAbandonedPublish` must leave `Deployment.coolifyAppUuid`
    // alone unless the app was actually deleted; otherwise the resumed run skips the
    // succeeded `app` step and a LIVE site would have no uuid for purge / orphans.
    expect(deployment.coolifyAppUuid).toBe('coolify-app-1');
    expect(deployment.dnsRecordId).toBe('dns-record-1');
  });

  it('a job that already SUCCEEDED touches no provider when run again', async () => {
    const seeded = await seedCase({ key: 'settled', kind: 'LIVE' });
    const jobId = await queuePublishJob(seeded, 'LIVE');

    const firstRun = publishSpy(seeded.server);
    await runPublishJob(jobId, firstRun.deps);
    expect(firstRun.counts.createApp).toBe(1);

    const replay = publishSpy(seeded.server);
    await runPublishJob(jobId, replay.deps);
    expect(replay.calls).toEqual([]);

    const deployment = await prisma.deployment.findUniqueOrThrow({
      where: { id: seeded.deploymentId },
    });
    expect(deployment.coolifyAppUuid).toBe('coolify-app-1');
    expect(deployment.status).toBe('LIVE');
  });

  it('an unhealthy build fails the job and settles the Deployment row', async () => {
    const seeded = await seedCase({ key: 'unhealthy', kind: 'LIVE' });
    const jobId = await queuePublishJob(seeded, 'LIVE');

    const spy = publishSpy(seeded.server, { health: 'failed' });
    await expect(runPublishJob(jobId, spy.deps)).rejects.toThrow('Coolify build fail: failed');

    const job = await getJob(jobId);
    expect(job?.status).toBe('FAILED');
    expect(job?.errorCode).toBe('provider_error');
    expect(stepStatuses(job?.steps)).toMatchObject({
      deploy: 'succeeded',
      poll: 'failed',
      live: 'pending',
    });

    // `persistProgress` only ever writes QUEUED/BUILDING/LIVE, so without the explicit
    // settle this row would claim BUILDING forever.
    const deployment = await prisma.deployment.findUniqueOrThrow({
      where: { id: seeded.deploymentId },
    });
    expect(deployment.status).toBe('FAILED');
    expect(deployment.lastError).toBe('Coolify build fail: failed');
    expect(deployment.publishedAt).toBeNull();
    expect(deployment.url).toBeNull();

    const project = await prisma.project.findUniqueOrThrow({ where: { id: seeded.projectId } });
    expect(project.status).not.toBe('published');
  });

  it('a PREVIEW publish uses preview-prefixed names and pushes the noindex files', async () => {
    const seeded = await seedCase({ key: 'preview', kind: 'PREVIEW' });
    const jobId = await queuePublishJob(seeded, 'PREVIEW');

    const spy = publishSpy(seeded.server, {
      files: { 'app/page.tsx': 'export default () => null;' },
    });
    await runPublishJob(jobId, spy.deps);

    const slug = expectedSlug('preview');
    expect(spy.seen.repoSlug).toBe(`preview-${slug}`);
    expect(spy.seen.dnsLabel).toBe(`preview-${slug}`);
    expect(spy.seen.domainHost).toBe(`preview-${slug}.${ROOT}`);
    expect(spy.seen.createApp?.name).toBe(`preview-${slug}`);

    // The preview gate is injected into the files pushed to the deploy repo only. If it
    // stops reaching GitHub the preview becomes publicly indexable.
    expect(spy.seen.pushedPaths).toContain('middleware.ts');
    expect(spy.seen.pushedPaths).toContain('app/page.tsx');

    const deployment = await prisma.deployment.findUniqueOrThrow({
      where: { id: seeded.deploymentId },
    });
    expect(deployment.url).toBe(`https://preview-${slug}.${ROOT}`);
    const project = await prisma.project.findUniqueOrThrow({ where: { id: seeded.projectId } });
    expect(project.status).toBe('preview');
  });

  it('re-publishing a live site keeps its slug and creates no new external resource', async () => {
    const slug = `${SLUG_PREFIX}-relive`;
    const seeded = await seedCase({
      key: 'relive',
      kind: 'LIVE',
      alreadyLive: {
        slug,
        repoFullName: 'deploy-org/pubx-relive',
        coolifyAppUuid: 'coolify-app-existing',
        dnsRecordId: 'dns-record-existing',
      },
    });
    const jobId = await queuePublishJob(seeded, 'LIVE');

    const spy = publishSpy(seeded.server, {
      appUuid: 'coolify-app-second',
      dnsRecordId: 'dns-record-second',
      existingRepo: { repoId: 'repo-id-relive' },
    });
    await runPublishJob(jobId, spy.deps);

    // A LIVE slug never changes once assigned, so nothing re-claims it and no new server
    // is chosen. Creating a second Coolify app or DNS record here would strand the first.
    expect(spy.counts.pickServer).toBe(0);
    // The repo IS resolved again: the F-202 guard compares the recorded immutable id
    // against the repo currently behind the name on every publish, so a repo deleted and
    // re-created by someone else refuses instead of being force-pushed over. The resolve
    // is a read — `created: false` — so no external resource is made.
    expect(spy.counts.ensureRepo).toBe(1);
    expect(spy.counts.createApp).toBe(0);
    expect(spy.counts.upsertDns).toBe(0);
    // New code still ships to the existing repo — that is the point of re-publishing.
    expect(spy.counts.pushFiles).toBe(1);
    expect(spy.seen.pushedTo).toBe('deploy-org/pubx-relive');
    expect(spy.seen.deployedUuid).toBe('coolify-app-existing');

    // Pre-feature row (no recorded id) pointing at the repo it already published:
    // the guard adopts the id one time instead of refusing. Raw SQL because the
    // generated client on this machine may predate the `githubRepoId` column.
    const owned = await prisma.$queryRaw<Array<{ githubRepoId: string | null }>>`
      SELECT "githubRepoId" FROM "Deployment" WHERE id = ${seeded.deploymentId}
    `;
    expect(owned[0]?.githubRepoId).toBe('repo-id-relive');

    const deployment = await prisma.deployment.findUniqueOrThrow({
      where: { id: seeded.deploymentId },
    });
    expect(deployment.slug).toBe(slug);
    expect(deployment.status).toBe('LIVE');
    expect(deployment.coolifyAppUuid).toBe('coolify-app-existing');
    expect(deployment.dnsRecordId).toBe('dns-record-existing');
    expect(deployment.commitSha).toBe('commit-sha-1');
  });

  it('pushes a repository Coolify can build, not the generated files on their own', async () => {
    // Checkpoint snapshots are the `<file>` blocks from `Project.lastCode` and nothing
    // else, so a generation that did not happen to emit a package.json produced a repo
    // whose build fails ten minutes later at `poll`. `buildRepoFiles` — what the
    // Connectors push and the ZIP export already ship — is the fix; publish was the one
    // caller that skipped it.
    const seeded = await seedCase({ key: 'scaffold', kind: 'LIVE' });
    const jobId = await queuePublishJob(seeded, 'LIVE');

    const spy = publishSpy(seeded.server, {
      files: {
        'app/page.tsx':
          'export default function Page() { return <img src="/uploads/p/hero.webp" />; }',
        // The deny list has to survive the merge: `collectFiles` is injectable and the
        // commit is built from explicit tree entries, so a `.gitignore` in the tree
        // cannot stop this reaching GitHub.
        '.env.local': 'API_KEY=not-real',
      },
      // The image the page above points at. It has to survive the scaffold merge and the
      // deny-list pass, and it is the one entry in the commit that is not text (F-262).
      assets: { 'public/uploads/p/hero.webp': { base64: 'd2VicA==' } },
    });
    await runPublishJob(jobId, spy.deps);

    for (const path of ['package.json', 'Dockerfile', '.dockerignore', '.gitignore', 'README.md']) {
      expect(spy.seen.pushedPaths).toContain(path);
    }
    // The stack scaffold underneath — without it there is no Next config and no entry
    // point beyond whatever the model happened to write.
    expect(spy.seen.pushedPaths).toContain('next.config.mjs');
    expect(spy.seen.pushedPaths).toContain('tsconfig.json');
    // The generated file still wins over its scaffold counterpart.
    expect(pushedText(spy, 'app/page.tsx')).toContain('/uploads/p/hero.webp');
    expect(spy.seen.pushedPaths).not.toContain('.env.local');
    // Bytes, not text: the transport turns this into a base64 blob rather than an inline
    // tree entry, which is the only way a webp survives a JSON string field.
    expect(spy.seen.pushedFiles['public/uploads/p/hero.webp']).toEqual({ base64: 'd2VicA==' });

    const manifest = JSON.parse(pushedText(spy, 'package.json')) as { name?: string };
    expect(manifest.name).toBe(expectedSlug('scaffold'));
    expect(pushedText(spy, 'Dockerfile')).toContain('FROM node:');
  });

  it('refuses a second runner on a job that is already in flight', async () => {
    // Two tabs, a double click, or two POSTs all reach `runPublishJob` with the *same*
    // job id: `startPublishJob` hands the second caller the in-flight job, `acquireLock`
    // is re-entrant for the same user, and `markJobRunning` accepts an already-RUNNING
    // row. Two runners on one job race a force-push on one branch and can create two
    // Coolify applications for one deployment — the second recorded nowhere.
    const seeded = await seedCase({ key: 'concurrent', kind: 'LIVE' });
    const jobId = await queuePublishJob(seeded, 'LIVE');

    const second = publishSpy(seeded.server, { appUuid: 'coolify-app-second' });
    let secondResultStatus: string | null | undefined;
    // Start the second runner while the first is genuinely mid-flight, holding a fresh
    // heartbeat — running them one after the other would prove nothing.
    const first = publishSpy(seeded.server, {
      async onDns() {
        const job = await runPublishJob(jobId, second.deps);
        secondResultStatus = job?.status;
      },
    });

    await runPublishJob(jobId, first.deps);

    expect(second.calls).toEqual([]);
    // It gets the in-flight job back, not an error and not a second run.
    expect(secondResultStatus).toBe('RUNNING');
    expect(first.counts.createApp).toBe(1);

    const deployment = await prisma.deployment.findUniqueOrThrow({
      where: { id: seeded.deploymentId },
    });
    expect(deployment.status).toBe('LIVE');
    expect(deployment.coolifyAppUuid).toBe('coolify-app-1');
  });

  it('fails a re-publish whose own deployment failed, however healthy the application is', async () => {
    // The poll used to read the application, which on a re-publish is already
    // `running:healthy` from the previous build — so the first poll broke the loop and
    // the job wrote LIVE and a fresh publishedAt over a build that was still running, or
    // had already failed. Polling the deployment this job triggered is the only way to
    // tell those apart.
    const seeded = await seedCase({
      key: 'stalepoll',
      kind: 'LIVE',
      alreadyLive: {
        slug: `${SLUG_PREFIX}-stalepoll`,
        repoFullName: 'deploy-org/pubx-stalepoll',
        coolifyAppUuid: 'coolify-app-existing',
        dnsRecordId: 'dns-record-existing',
      },
    });
    const jobId = await queuePublishJob(seeded, 'LIVE');

    const spy = publishSpy(seeded.server, {
      existingRepo: { repoId: 'repo-id-stalepoll' },
      statuses: [
        { health: 'building', status: 'in_progress' },
        { health: 'failed', status: 'failed' },
      ],
    });

    await expect(runPublishJob(jobId, spy.deps)).rejects.toThrow('Coolify build fail: failed');

    expect(spy.counts.deploymentStatus).toBe(2);
    expect(spy.seen.polledDeploymentUuid).toBe('coolify-deployment-1');

    const job = await getJob(jobId);
    expect(stepStatuses(job?.steps)).toMatchObject({ poll: 'failed', live: 'pending' });

    const deployment = await prisma.deployment.findUniqueOrThrow({
      where: { id: seeded.deploymentId },
    });
    // The previous release is still serving, so the row stays LIVE — but the failure is
    // recorded and nothing re-stamps publishedAt.
    expect(deployment.status).toBe('LIVE');
    expect(deployment.lastError).toBe('Coolify build fail: failed');
    expect(deployment.publishedAt).toEqual(new Date('2026-08-01T00:00:00.000Z'));
  });

  it('refuses to call a build live when Coolify returned no deployment id', async () => {
    const seeded = await seedCase({ key: 'nouuid', kind: 'LIVE' });
    const jobId = await queuePublishJob(seeded, 'LIVE');

    const spy = publishSpy(seeded.server, { deploymentUuid: null });

    await expect(runPublishJob(jobId, spy.deps)).rejects.toThrow('could not be verified');

    // Nothing to poll and nothing to guess from: unverifiable is a failure, not a pass.
    expect(spy.counts.startDeploy).toBe(1);
    expect(spy.counts.deploymentStatus).toBe(0);

    const deployment = await prisma.deployment.findUniqueOrThrow({
      where: { id: seeded.deploymentId },
    });
    expect(deployment.status).toBe('FAILED');
    expect(deployment.publishedAt).toBeNull();
  });

  it('deploys nothing when Coolify will not select the commit that was just pushed', async () => {
    // A rollback (F-264) leaves the application pinned to an older release. If the pin
    // cannot be moved to the commit this publish pushed, Coolify would build the old
    // release and the loop would call it a successful publish of the new one.
    const seeded = await seedCase({ key: 'pinrefused', kind: 'LIVE' });
    const jobId = await queuePublishJob(seeded, 'LIVE');

    const spy = publishSpy(seeded.server, {
      pinRefusal: 'Coolify still reports commit older-sha for this application.',
    });

    await expect(runPublishJob(jobId, spy.deps)).rejects.toThrow('older-sha');

    expect(spy.counts.pinCommit).toBe(1);
    expect(spy.counts.startDeploy).toBe(0);
    expect(spy.counts.deploymentStatus).toBe(0);

    const deployment = await prisma.deployment.findUniqueOrThrow({
      where: { id: seeded.deploymentId },
    });
    expect(deployment.status).toBe('FAILED');
    expect(deployment.publishedAt).toBeNull();
  });

  it('keeps a retry on the server the Coolify app was created on', async () => {
    // `pickCoolifyServer` recomputes the least-loaded server on every call, so re-picking
    // in the `slug` step moved a retry to server B while `resourceIds` still carried the
    // application uuid created on server A: the retry then called server B's API with
    // server A's uuid (a 404 nobody can read) and recorded a `serverId` that no longer
    // says where the app is — which is also how stop and destroy find it.
    const seeded = await seedCase({ key: 'pin', kind: 'LIVE' });
    const firstJob = await queuePublishJob(seeded, 'LIVE');

    const first = publishSpy(seeded.server, {
      async onDns() {
        throw new Error('network went away');
      },
    });
    await expect(runPublishJob(firstJob, first.deps)).rejects.toThrow('network went away');
    // The first attempt did pick, and did create the application on that server.
    expect(first.counts.pickServer).toBe(1);
    expect(first.counts.createApp).toBe(1);

    // Retry: `createOrReuseJob` does not reuse a FAILED job, so this is a fresh job with
    // every step pending — the `slug` step runs again.
    const emptier = await prisma.coolifyServer.create({
      data: {
        id: `srv_${SLUG_PREFIX}_pinb`,
        name: 'coolify-pin-b',
        apiUrl: 'https://coolify-b.example.test',
        apiToken: 'not-a-real-token',
        serverIp: '198.51.100.9',
        projectUuid: 'project-uuid-pin-b',
      },
    });
    const retryJob = await queuePublishJob(seeded, 'LIVE');
    const second = publishSpy({
      id: emptier.id,
      apiUrl: emptier.apiUrl,
      apiToken: emptier.apiToken,
      serverIp: emptier.serverIp,
      projectUuid: emptier.projectUuid,
    });

    await runPublishJob(retryJob, second.deps);

    // Not even asked: an application already exists on server A.
    expect(second.counts.pickServer).toBe(0);
    expect(second.counts.createApp).toBe(0);
    // DNS points at server A's IP, not the emptier server's.
    expect(second.seen.dnsIp).toBe(SERVER_IP);

    const deployment = await prisma.deployment.findUniqueOrThrow({
      where: { id: seeded.deploymentId },
    });
    expect(deployment.serverId).toBe(seeded.server.id);
    expect(deployment.coolifyAppUuid).toBe('coolify-app-1');
    expect(deployment.buildLogUrl).toBe(`${SERVER_API_URL}/application/coolify-app-1`);
  });
});
