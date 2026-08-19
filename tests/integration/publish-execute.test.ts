import '../setup/env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import type { CreateApplicationInput, DeploymentHealth } from '@/lib/coolify/client';
import { getJob, insertJobRaw, updateJobFields } from '@/lib/jobs/store';
import { runPublishJob, type PublishDeps, type PublishServer } from '@/lib/publish/execute';
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
  'happy' | 'kill' | 'appfail' | 'resume' | 'settled' | 'unhealthy' | 'preview' | 'relive';

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
    createApp: CreateApplicationInput | null;
    dnsLabel: string | null;
    dnsIp: string | null;
    domainHost: string | null;
    redirectsFor: string | null;
    deployedUuid: string | null;
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
    appUuid?: string;
    dnsRecordId?: string;
    health?: DeploymentHealth;
    /** Runs inside `upsertDns` before it returns; throwing here fails the `dns` step. */
    onDns?: () => Promise<void>;
    onCreateApp?: () => Promise<void>;
  } = {},
): PublishSpy {
  const calls: string[] = [];
  const counts: Record<keyof PublishDeps, number> = {
    collectFiles: 0,
    pickServer: 0,
    rootDomain: 0,
    ensureRepo: 0,
    pushFiles: 0,
    createApp: 0,
    upsertDns: 0,
    addAppDomain: 0,
    applyRedirects: 0,
    startDeploy: 0,
    deployHealth: 0,
  };
  const seen: PublishSpy['seen'] = {
    repoSlug: null,
    pushedTo: null,
    pushedPaths: [],
    createApp: null,
    dnsLabel: null,
    dnsIp: null,
    domainHost: null,
    redirectsFor: null,
    deployedUuid: null,
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
      return `deploy-org/${repoSlug}`;
    },
    async pushFiles(repoFullName, files) {
      record('pushFiles');
      seen.pushedTo = repoFullName;
      seen.pushedPaths = Object.keys(files).sort();
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
    async startDeploy(_auth, appUuid) {
      record('startDeploy');
      seen.deployedUuid = appUuid;
      return { deploymentUuid: 'coolify-deployment-1' };
    },
    async deployHealth() {
      record('deployHealth');
      const health = options.health ?? 'healthy';
      return { health, status: health === 'healthy' ? 'running:healthy' : 'exited' };
    },
  };

  return { deps, calls, counts, seen };
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
      'pickServer',
      'rootDomain',
      'ensureRepo',
      'pushFiles',
      'createApp',
      'upsertDns',
      'addAppDomain',
      'applyRedirects',
      'startDeploy',
      'deployHealth',
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
    expect(spy.seen.deployedUuid).toBe('coolify-app-1');

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
    expect(second.counts.deployHealth).toBe(1);
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
    await expect(runPublishJob(jobId, spy.deps)).rejects.toThrow('Coolify build fail: exited');

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
    expect(deployment.lastError).toBe('Coolify build fail: exited');
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
    });
    await runPublishJob(jobId, spy.deps);

    // A LIVE slug never changes once assigned, so nothing re-claims it and no new server
    // is chosen. Creating a second Coolify app or DNS record here would strand the first.
    expect(spy.counts.pickServer).toBe(0);
    expect(spy.counts.ensureRepo).toBe(0);
    expect(spy.counts.createApp).toBe(0);
    expect(spy.counts.upsertDns).toBe(0);
    // New code still ships to the existing repo — that is the point of re-publishing.
    expect(spy.counts.pushFiles).toBe(1);
    expect(spy.seen.pushedTo).toBe('deploy-org/pubx-relive');
    expect(spy.seen.deployedUuid).toBe('coolify-app-existing');

    const deployment = await prisma.deployment.findUniqueOrThrow({
      where: { id: seeded.deploymentId },
    });
    expect(deployment.slug).toBe(slug);
    expect(deployment.status).toBe('LIVE');
    expect(deployment.coolifyAppUuid).toBe('coolify-app-existing');
    expect(deployment.dnsRecordId).toBe('dns-record-existing');
    expect(deployment.commitSha).toBe('commit-sha-1');
  });
});
