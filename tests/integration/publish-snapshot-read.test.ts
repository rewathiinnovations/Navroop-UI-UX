import '../setup/env';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testPrismaClient } from '../setup/db';
import { SnapshotReadError } from '@/lib/checkpoints/snapshot';
import { getJob, insertJobRaw, updateJobFields } from '@/lib/jobs/store';
import { recoveryCauseLine } from '@/lib/jobs/copy';
import { runPublishJob, type PublishDeps, type PublishServer } from '@/lib/publish/execute';
import { PUBLISH_STEPS } from '@/lib/publish/steps';

/**
 * A publish job whose file step cannot read the checkpoint snapshot.
 *
 * The recovery panel shows `recoveryCauseLine(errorCode)`, and the failed `files`
 * step / Deployment.lastError show the thrown message. Before this, both said
 * "This project has no files to publish" (or "The AI service did not respond")
 * whenever storage failed — which is how a storage outage read as an empty
 * project.
 *
 * Drives `runPublishJob` through `PublishDeps`. `collectFiles` throws the real
 * `SnapshotReadError`; no object store is contacted.
 */

const prisma = testPrismaClient();

const USER = 'user_publish_snapread';
const WS = 'ws_publish_snapread';
const PROJECT = 'proj_pubsnap_files';
const SERVER = 'srv_pubsnap_files';
const SNAPSHOT_KEY = 'snapshots/proj_pubsnap_files/cp_latest.json.gz';

async function cleanup() {
  await prisma.$executeRaw`
    DELETE FROM "GenerationJob" WHERE "projectId" = ${PROJECT}
  `.catch(() => undefined);
  await prisma.deployment.deleteMany({ where: { projectId: PROJECT } }).catch(() => undefined);
  await prisma.project.deleteMany({ where: { id: PROJECT } }).catch(() => undefined);
  await prisma.coolifyServer.deleteMany({ where: { id: SERVER } }).catch(() => undefined);
}

function refusingDeps(server: PublishServer): PublishDeps {
  const unused = async () => {
    throw new Error('publish must stop at the files step');
  };
  return {
    async collectFiles() {
      throw new SnapshotReadError(SNAPSHOT_KEY, new Error('Access Denied'));
    },
    async pickServer() {
      return server;
    },
    rootDomain: unused as PublishDeps['rootDomain'],
    ensureRepo: unused as PublishDeps['ensureRepo'],
    pushFiles: unused as PublishDeps['pushFiles'],
    createApp: unused as PublishDeps['createApp'],
    upsertDns: unused as PublishDeps['upsertDns'],
    setAppDomain: unused as PublishDeps['setAppDomain'],
    startDeploy: unused as PublishDeps['startDeploy'],
    deployHealth: unused as PublishDeps['deployHealth'],
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
      email: 'publish-snapread@example.com',
      name: 'Publish Snapshot Read',
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

describe('runPublishJob — snapshot read failure', () => {
  it('fails the files step with a storage code, not "no files to publish"', async () => {
    await prisma.project.create({
      data: {
        id: PROJECT,
        name: 'pubsnap files',
        ownerId: USER,
        initialPrompt: 'snapshot read probe',
      },
    });
    const server = await prisma.coolifyServer.create({
      data: {
        id: SERVER,
        name: 'coolify-pubsnap',
        apiUrl: 'https://coolify.example.test',
        apiToken: 'not-a-real-token',
        serverIp: '203.0.113.88',
        projectUuid: 'project-uuid-pubsnap',
      },
    });
    const deployment = await prisma.deployment.create({
      data: {
        projectId: PROJECT,
        workspaceId: WS,
        serverId: server.id,
        kind: 'LIVE',
        status: 'QUEUED',
        slug: 'pending-pubsnap',
        publishedById: USER,
        progressStep: 'limit',
      },
    });
    const job = await insertJobRaw({
      projectId: PROJECT,
      workspaceId: WS,
      userId: USER,
      kind: 'PUBLISH',
      status: 'QUEUED',
      inputPrompt: 'LIVE',
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
    });

    const deps = refusingDeps({
      id: server.id,
      apiUrl: server.apiUrl,
      apiToken: server.apiToken,
      serverIp: server.serverIp,
      projectUuid: server.projectUuid,
    });

    await expect(runPublishJob(job.id, deps)).rejects.toBeInstanceOf(SnapshotReadError);

    const failed = await getJob(job.id);
    expect(failed?.status).toBe('FAILED');
    expect(failed?.errorCode).toBe('snapshot_unreadable');
    expect(failed?.errorMessage).toMatch(/Could not read checkpoint snapshot/i);
    expect(failed?.errorMessage).not.toMatch(/no files to publish/i);
    expect(failed?.currentStep).toBe('files');

    const filesStep = failed?.steps?.find((step) => step.key === 'files');
    expect(filesStep?.status).toBe('failed');
    expect(filesStep?.error).toMatch(/Could not read checkpoint snapshot/i);
    expect(filesStep?.error).not.toMatch(/no files to publish/i);

    const cause = recoveryCauseLine(failed?.errorCode);
    expect(cause).not.toBe('');
    expect(cause.toLowerCase()).toContain('storage');
    expect(cause.toLowerCase()).not.toContain('deleted');
    expect(cause.toLowerCase()).not.toContain('no files');
    expect(cause.toLowerCase()).not.toMatch(/build (failed|did not)/);

    const row = await prisma.deployment.findUniqueOrThrow({ where: { id: deployment.id } });
    expect(row.status).toBe('FAILED');
    expect(row.lastError).toMatch(/Could not read checkpoint snapshot/i);
    expect(row.lastError).not.toMatch(/no files to publish/i);
  });
});
