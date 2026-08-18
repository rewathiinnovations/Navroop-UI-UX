import '../setup/env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import type { CreateApplicationInput, DeploymentHealth } from '@/lib/coolify/client';
import { compensateAbandonedPublish } from '@/lib/jobs/compensate-publish';
import { getJob, insertJobRaw, updateJobFields } from '@/lib/jobs/store';
import type { CompensateAdapters } from '@/lib/jobs/compensate';
import { runPublishJob, type PublishDeps, type PublishServer } from '@/lib/publish/execute';
import { PUBLISH_STEPS } from '@/lib/publish/steps';

/**
 * First-time publish abandon must leave `Deployment.coolifyAppUuid` and
 * `job.resourceIds.coolifyAppUuid` in agreement. The shipped loop skips a
 * succeeded `app` step, so nulling only the Deployment column (the old
 * compensate path) permanently hides the Coolify app from cleanup, health,
 * and "open the live site".
 *
 * Run: node ./node_modules/vitest/vitest.mjs run tests/integration/publish-compensate-resume.test.ts
 */

const prisma = testPrismaClient();

const USER = 'user_publish_compensate';
const WS = 'ws_publish_compensate';
const SLUG_PREFIX = 'pubc';

type CaseKey = 'alive' | 'torn' | 'relive';

const projectId = (key: CaseKey) => `proj_${SLUG_PREFIX}_${key}`;
const serverId = (key: CaseKey) => `srv_${SLUG_PREFIX}_${key}`;
const expectedSlug = (key: CaseKey) => `${SLUG_PREFIX}-${key}`;

const SERVER_IP = '203.0.113.88';
const SERVER_API_URL = 'https://coolify.example.test';
const ROOT = 'example.test';
const KEPT_APP = 'coolify-app-kept';
const NEW_APP = 'coolify-app-recreated';

type SeededCase = {
  projectId: string;
  deploymentId: string;
  server: PublishServer;
};

async function cleanup() {
  await prisma.$executeRaw`
    DELETE FROM "GenerationJob" WHERE "projectId" LIKE ${`proj_${SLUG_PREFIX}_%`}
  `.catch(() => undefined);
  await prisma.deployment
    .deleteMany({
      where: {
        OR: [{ projectId: { startsWith: `proj_${SLUG_PREFIX}_` } }, { slug: { startsWith: SLUG_PREFIX } }],
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
      initialPrompt: 'publish compensate resume probe',
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

async function queuePublishJob(seeded: SeededCase, kind: 'LIVE' | 'PREVIEW') {
  const deployment = await prisma.deployment.findUniqueOrThrow({ where: { id: seeded.deploymentId } });
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

function publishSpy(
  server: PublishServer,
  options: {
    appUuid?: string;
    dnsRecordId?: string;
    health?: DeploymentHealth;
    onDns?: () => Promise<void>;
  } = {},
) {
  const counts = { createApp: 0, upsertDns: 0 };
  const seen = { createApp: null as CreateApplicationInput | null };
  const deps: PublishDeps = {
    async collectFiles() {
      return { 'app/page.tsx': 'export default function Page() { return null; }' };
    },
    async pickServer() {
      return server;
    },
    async rootDomain() {
      return ROOT;
    },
    async ensureRepo(repoSlug) {
      return `deploy-org/${repoSlug}`;
    },
    async pushFiles() {
      return 'commit-sha-1';
    },
    async createApp(_auth, input) {
      counts.createApp += 1;
      seen.createApp = input;
      return { uuid: options.appUuid ?? KEPT_APP };
    },
    async upsertDns() {
      counts.upsertDns += 1;
      if (options.onDns) await options.onDns();
      return options.dnsRecordId ?? 'dns-record-1';
    },
    async setAppDomain() {},
    async startDeploy() {
      return { deploymentUuid: 'coolify-deployment-1' };
    },
    async deployHealth() {
      const health = options.health ?? 'healthy';
      return { health, status: health === 'healthy' ? 'running:healthy' : 'exited' };
    },
  };
  return { deps, counts, seen };
}

function recordingAdapters(): CompensateAdapters & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    async deleteCoolifyApp(uuid) {
      deleted.push(`coolify:${uuid}`);
    },
    async deleteDnsRecord(id) {
      deleted.push(`dns:${id}`);
    },
    async archiveDeployRepo(name) {
      deleted.push(`repo:${name}`);
    },
  };
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
      email: 'publish-compensate@example.com',
      name: 'Publish Compensate',
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

describe('compensateAbandonedPublish — Deployment uuid stays aligned with the job', () => {
  it('leaves Deployment.coolifyAppUuid in place when the Coolify app is still running, then resume keeps them equal', async () => {
    const seeded = await seedCase({ key: 'alive', kind: 'LIVE' });
    const jobId = await queuePublishJob(seeded, 'LIVE');

    const first = publishSpy(seeded.server, {
      appUuid: KEPT_APP,
      async onDns() {
        throw new Error('publish process went away');
      },
    });
    await expect(runPublishJob(jobId, first.deps)).rejects.toThrow('publish process went away');
    expect(first.counts.createApp).toBe(1);

    // Control: the old compensate path nulled only the Deployment column here.
    // `failJob` already ran `compensateAbandonedPublish` (no Coolify client in
    // this suite — the app is still "running"). Under that old behaviour this
    // expect is `null !== 'coolify-app-kept'`.
    const afterCompensate = await getJob(jobId);
    const deploymentAfterCompensate = await prisma.deployment.findUniqueOrThrow({
      where: { id: seeded.deploymentId },
    });
    expect(afterCompensate?.resourceIds?.coolifyAppUuid).toBe(KEPT_APP);
    expect(deploymentAfterCompensate.coolifyAppUuid).toBe(afterCompensate?.resourceIds?.coolifyAppUuid);
    expect(deploymentAfterCompensate.coolifyAppUuid).toBe(KEPT_APP);

    await updateJobFields(jobId, {
      status: 'QUEUED',
      finishedAt: null,
      errorCode: null,
      errorMessage: null,
    });

    const second = publishSpy(seeded.server, { appUuid: NEW_APP });
    await runPublishJob(jobId, second.deps);
    expect(second.counts.createApp).toBe(0);
    expect(second.counts.upsertDns).toBe(1);

    const job = await getJob(jobId);
    const deployment = await prisma.deployment.findUniqueOrThrow({ where: { id: seeded.deploymentId } });
    expect(job?.status).toBe('SUCCEEDED');
    expect(deployment.status).toBe('LIVE');
    expect(deployment.coolifyAppUuid).toBe(job?.resourceIds?.coolifyAppUuid);
    expect(deployment.coolifyAppUuid).toBe(KEPT_APP);
    expect(deployment.slug).toBe(expectedSlug('alive'));
  });

  it('clears both uuids and reopens the app step when the Coolify app was genuinely torn down', async () => {
    const seeded = await seedCase({ key: 'torn', kind: 'LIVE' });
    const jobId = await queuePublishJob(seeded, 'LIVE');

    const first = publishSpy(seeded.server, {
      appUuid: KEPT_APP,
      async onDns() {
        throw new Error('publish process went away');
      },
    });
    await expect(runPublishJob(jobId, first.deps)).rejects.toThrow('publish process went away');

    // `failJob` already compensated with the default (no-op) adapters and stamped
    // `compensation`. Clear that stamp so this case can exercise a real teardown.
    const failed = await getJob(jobId);
    await updateJobFields(jobId, {
      resourceIds: {
        ...(failed?.resourceIds ?? {}),
        compensation: null,
      },
    });

    const adapters = recordingAdapters();
    await compensateAbandonedPublish(jobId, { adapters });
    expect(adapters.deleted).toContain(`coolify:${KEPT_APP}`);

    const afterTeardown = await getJob(jobId);
    const deploymentAfterTeardown = await prisma.deployment.findUniqueOrThrow({
      where: { id: seeded.deploymentId },
    });
    expect(afterTeardown?.resourceIds?.coolifyAppUuid).toBeNull();
    expect(deploymentAfterTeardown.coolifyAppUuid).toBeNull();
    expect(afterTeardown?.steps?.find((step) => step.key === 'app')?.status).not.toBe('succeeded');

    await updateJobFields(jobId, {
      status: 'QUEUED',
      finishedAt: null,
      errorCode: null,
      errorMessage: null,
    });

    const second = publishSpy(seeded.server, { appUuid: NEW_APP });
    await runPublishJob(jobId, second.deps);
    expect(second.counts.createApp).toBe(1);

    const job = await getJob(jobId);
    const deployment = await prisma.deployment.findUniqueOrThrow({ where: { id: seeded.deploymentId } });
    expect(job?.status).toBe('SUCCEEDED');
    expect(deployment.coolifyAppUuid).toBe(job?.resourceIds?.coolifyAppUuid);
    expect(deployment.coolifyAppUuid).toBe(NEW_APP);
  });

  it('does not tear down a live site on re-publish abandon', async () => {
    const slug = `${SLUG_PREFIX}-relive`;
    const seeded = await seedCase({
      key: 'relive',
      kind: 'LIVE',
      alreadyLive: {
        slug,
        repoFullName: 'deploy-org/pubc-relive',
        coolifyAppUuid: 'coolify-app-live',
        dnsRecordId: 'dns-record-live',
      },
    });
    const job = await insertJobRaw({
      projectId: seeded.projectId,
      workspaceId: WS,
      userId: USER,
      kind: 'PUBLISH',
      status: 'RUNNING',
      inputPrompt: 'LIVE',
    });
    await updateJobFields(job.id, {
      resourceIds: {
        githubRepo: 'deploy-org/pubc-relive',
        coolifyAppUuid: 'coolify-app-live',
        dnsRecordId: 'dns-record-live',
      },
    });

    const adapters = recordingAdapters();
    const compensation = await compensateAbandonedPublish(job.id, { adapters });
    expect(compensation).toBe('kept_live');
    expect(adapters.deleted).toEqual([]);

    const deployment = await prisma.deployment.findUniqueOrThrow({ where: { id: seeded.deploymentId } });
    const after = await getJob(job.id);
    expect(deployment.coolifyAppUuid).toBe('coolify-app-live');
    expect(after?.resourceIds?.coolifyAppUuid).toBe('coolify-app-live');
    expect(deployment.status).toBe('LIVE');
  });
});
