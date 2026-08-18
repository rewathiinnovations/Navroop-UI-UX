import { randomUUID } from 'node:crypto';
import type { DeploymentKind } from '@/generated/prisma';
import { prisma } from '@/lib/db';
import { setBasicAuth } from '@/lib/coolify/client';
import { pickCoolifyServer, serverAuth } from '@/lib/coolify/servers';
import { getMissingIntegrations } from '@/lib/integrations/store';
import { publishBlockedMessage } from '@/lib/integrations/messages';
import { getStack } from '@/lib/stacks';
import { createOrReuseJob, getActiveJob } from '@/lib/jobs';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { log } from '@/lib/logger';
import { trackStart } from '@/lib/observability/track';
import {
  DEFAULT_WORKSPACE_ID,
  PREVIEW_BASIC_USER,
} from './constants';
import { assertPublishSlot } from './limits';
import { publishIdempotencyKey } from './naming';
import { runPublishJob } from './execute';
import { PUBLISH_STEPS } from './steps';

/**
 * Publishing consumes a live/preview slot, not credits.
 * checkLimit runs first for new slots; credits are never charged here.
 */

export class PublishSetupError extends Error {
  missing: string[];
  constructor(message: string, missing: string[]) {
    super(message);
    this.name = 'PublishSetupError';
    this.missing = missing;
  }
}

async function assertIntegrationsReady(workspaceId: string) {
  const missing = await getMissingIntegrations(workspaceId);
  const message = publishBlockedMessage(missing, true);
  if (message) throw new PublishSetupError(message, missing);
}

export type PublishInput = {
  projectId: string;
  kind: DeploymentKind;
  userId: string;
  password?: string | null;
};

export type PublishStartResult = {
  jobId: string;
  deploymentId: string;
};

/**
 * Creates a PUBLISH job and returns immediately with the job id.
 * A runner (`runPublishJob`) executes the ten steps and persists after each.
 * Deployment.status is derived from the job.
 */
export async function publishProject(input: PublishInput): Promise<PublishStartResult> {
  return startPublishJob(input);
}

export async function startPublishJob(input: PublishInput): Promise<PublishStartResult> {
  const requestId = randomUUID();
  const workspaceId = DEFAULT_WORKSPACE_ID;
  trackStart('publish.start', { action: 'publish', workspaceId, stack: input.kind });

  const project = await prisma.project.findFirst({
    where: { id: input.projectId, deletedAt: null },
    select: { id: true, name: true, stack: true },
  });
  if (!project) {
    throw new Error('Project not found');
  }

  await assertIntegrationsReady(workspaceId);
  await assertPublishSlot({ workspaceId, projectId: input.projectId, kind: input.kind });

  const active = await getActiveJob(input.projectId);
  if (active && (active.status === 'QUEUED' || active.status === 'RUNNING')) {
    if (active.kind === 'PUBLISH') {
      const existing = await prisma.deployment.findUnique({
        where: { projectId_kind: { projectId: input.projectId, kind: input.kind } },
      });
      return { jobId: active.id, deploymentId: existing?.id || active.id };
    }
    throw new Error('Wait for the current build to finish');
  }

  let deployment = await prisma.deployment.findUnique({
    where: { projectId_kind: { projectId: input.projectId, kind: input.kind } },
  });

  if (!deployment) {
    const placeholderSlug = `pending-${requestId.slice(0, 8)}`;
    const server = await pickCoolifyServer();
    deployment = await prisma.deployment.create({
      data: {
        projectId: input.projectId,
        workspaceId,
        serverId: server.id,
        kind: input.kind,
        status: 'QUEUED',
        slug: placeholderSlug,
        publishedById: input.userId,
        lastRequestId: requestId,
        progressStep: 'limit',
      },
    });
  } else {
    deployment = await prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        status: deployment.status === 'LIVE' ? 'LIVE' : 'QUEUED',
        progressStep: 'limit',
        lastError: null,
        lastRequestId: requestId,
        publishedById: input.userId,
      },
    });
  }

  const steps = PUBLISH_STEPS.map((step) => ({
    key: step.key,
    label: step.label,
    status: 'pending' as const,
    startedAt: null,
    finishedAt: null,
    error: null,
  }));

  const job = await createOrReuseJob({
    projectId: input.projectId,
    workspaceId: workspaceId || WORKSPACE_ROW_ID,
    userId: input.userId,
    kind: 'PUBLISH',
    inputPrompt: input.kind,
    requestId,
    idempotencyKey: publishIdempotencyKey(
      input.projectId,
      input.kind,
      `${deployment.id}:${deployment.publishedAt?.toISOString() || 'first'}`,
    ),
  });

  await prisma.$executeRaw`
    UPDATE "GenerationJob"
    SET
      steps = ${JSON.stringify(steps)}::jsonb,
      "currentStep" = 'limit',
      "resourceIds" = ${JSON.stringify({
        githubRepo: deployment.repoFullName,
        coolifyAppUuid: deployment.coolifyAppUuid,
        dnsRecordId: deployment.dnsRecordId,
      })}::jsonb,
      "updatedAt" = NOW()
    WHERE id = ${job.id}
  `;

  log.info('publish.job_created', { jobId: job.id, deploymentId: deployment.id, kind: input.kind });
  return { jobId: job.id, deploymentId: deployment.id };
}

export async function publishProjectAndWait(input: PublishInput) {
  const started = await startPublishJob(input);
  await runPublishJob(started.jobId);
  return prisma.deployment.findUniqueOrThrow({ where: { id: started.deploymentId } });
}

export async function getProjectDeployments(projectId: string) {
  return prisma.deployment.findMany({
    where: { projectId },
    include: {
      publishedBy: { select: { id: true, name: true, email: true } },
      server: { select: { id: true, name: true, serverIp: true } },
    },
    orderBy: { kind: 'asc' },
  });
}

export async function updatePreviewPassword(input: {
  projectId: string;
  userId: string;
  password: string | null;
}) {
  const deployment = await prisma.deployment.findUnique({
    where: { projectId_kind: { projectId: input.projectId, kind: 'PREVIEW' } },
    include: { server: true, project: { select: { stack: true } } },
  });
  if (!deployment?.coolifyAppUuid) {
    throw new Error('Publish a preview first');
  }
  const { hashPassword } = await import('@/lib/password');
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  await prisma.deployment.update({
    where: { id: deployment.id },
    data: { passwordHash },
  });

  const stack = getStack(deployment.project.stack);
  const auth = serverAuth(deployment.server);
  if (stack.deployType === 'static') {
    await setBasicAuth(
      auth,
      deployment.coolifyAppUuid,
      input.password ? { username: PREVIEW_BASIC_USER, password: input.password } : null,
    );
  } else {
    const started = await startPublishJob({
      projectId: input.projectId,
      kind: 'PREVIEW',
      userId: input.userId,
      password: input.password,
    });
    await runPublishJob(started.jobId);
  }

  return prisma.deployment.findUniqueOrThrow({ where: { id: deployment.id } });
}
