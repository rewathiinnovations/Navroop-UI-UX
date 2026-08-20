import { randomUUID } from 'node:crypto';
import type { Deployment, DeploymentKind } from '@/generated/prisma';
import { prisma } from '@/lib/db';
import { getApplicationEnvVar, setApplicationEnvVars, setBasicAuth } from '@/lib/coolify/client';
import { pickCoolifyServer, serverAuth } from '@/lib/coolify/servers';
import { getPublishReadiness } from '@/lib/integrations/store';
import { publishBlockedMessage } from '@/lib/integrations/messages';
import { getStack } from '@/lib/stacks';
import { createOrReuseJob, getActiveJob } from '@/lib/jobs';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { log } from '@/lib/logger';
import { trackStart } from '@/lib/observability/track';
import { DEFAULT_WORKSPACE_ID, PREVIEW_BASIC_USER, PREVIEW_PASSWORD_ENV } from './constants';
import { assertPublishSlot, reservePublishSlot } from './limits';
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

/**
 * A publish of the *other* kind is already in flight. 409, not a failure: the caller
 * can retry once that build finishes.
 */
export class PublishConflictError extends Error {
  readonly status = 409 as const;
  constructor(message: string) {
    super(message);
    this.name = 'PublishConflictError';
  }
}

async function assertIntegrationsReady(workspaceId: string) {
  const readiness = await getPublishReadiness(workspaceId);
  const missing = readiness.missing;
  const message = publishBlockedMessage(missing, true, readiness.unreadable);
  if (message) throw new PublishSetupError(message, missing);
}

export type PublishInput = {
  projectId: string;
  kind: DeploymentKind;
  userId: string;
};

export type PublishStartResult = {
  jobId: string;
  /** Null when this kind has no Deployment row yet — never another id in its place. */
  deploymentId: string | null;
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
    // `inputPrompt` carries the kind of a PUBLISH job. Only the job for the *same* kind
    // may be re-joined: the check used to stop at `kind === 'PUBLISH'`, so clicking
    // "Go live" during a preview build returned the preview job, a second runner was put
    // on it, and the live publish never started while the UI followed the preview's
    // steps to completion (F-239).
    const activeKind =
      active.kind === 'PUBLISH' &&
      (active.inputPrompt === 'LIVE' || active.inputPrompt === 'PREVIEW')
        ? active.inputPrompt
        : null;
    if (activeKind === input.kind) {
      const existing = await prisma.deployment.findUnique({
        where: { projectId_kind: { projectId: input.projectId, kind: input.kind } },
      });
      // No row for this kind yet: say so. `active.id` was a job id in the slot a
      // Deployment id belongs in — type-correct and wrong, so any caller that trusted
      // it addressed a row that does not exist.
      return { jobId: active.id, deploymentId: existing?.id ?? null };
    }
    if (activeKind) {
      throw new PublishConflictError(
        `A ${activeKind.toLowerCase()} publish is still running for this project. Wait for it to finish, then publish again.`,
      );
    }
    throw new Error('Wait for the current build to finish');
  }

  const existing = await prisma.deployment.findUnique({
    where: { projectId_kind: { projectId: input.projectId, kind: input.kind } },
  });

  const restart = {
    status: existing?.status === 'LIVE' ? ('LIVE' as const) : ('QUEUED' as const),
    progressStep: 'limit',
    lastError: null,
    lastRequestId: requestId,
    publishedById: input.userId,
  };

  // Which write takes a slot: `currentForLimit` counts non-STOPPED deployments, so the
  // insert and the revival of a STOPPED row each increase the count, while a re-publish of
  // a row that is already running does not. `assertPublishSlot` above is the pre-flight
  // that gives the user a 402 before any work starts; the ceiling itself has to hold at
  // the write, or two concurrent publishes at the ceiling both pass the count and both
  // insert, over-committing the Coolify server past what the plan sells (F-307).
  let deployment: Deployment;
  if (!existing) {
    // Outside the reservation on purpose: picking a server has no business holding the
    // limit lock.
    const server = await pickCoolifyServer();
    const placeholderSlug = `pending-${requestId.slice(0, 8)}`;
    deployment = await reservePublishSlot(workspaceId, input.kind, (tx) =>
      tx.deployment.create({
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
      }),
    );
  } else if (existing.status === 'STOPPED') {
    deployment = await reservePublishSlot(workspaceId, input.kind, (tx) =>
      tx.deployment.update({ where: { id: existing.id }, data: restart }),
    );
  } else {
    deployment = await prisma.deployment.update({
      where: { id: existing.id },
      data: restart,
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
  // Re-joining an in-flight job of the same kind can come back without a row (nothing
  // has been created for this kind yet), and the runner may have created one since.
  return started.deploymentId
    ? prisma.deployment.findUniqueOrThrow({ where: { id: started.deploymentId } })
    : prisma.deployment.findUniqueOrThrow({
        where: { projectId_kind: { projectId: input.projectId, kind: input.kind } },
      });
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

/**
 * What a preview-password change left to do once the request can safely return.
 *
 * Setting a password on a node stack needs a build: the gate is injected into the deploy
 * repo and the value it compares against is an env var on the Coolify application, so
 * neither reaches the running container until the next publish. That publish used to be
 * awaited *inside* the server action, which polls Coolify for up to ten minutes — past
 * every platform request timeout, after which the user was told "Password update fail"
 * for a publish that was still running, and with no project lock held the whole time
 * (F-232). So the request starts the job and hands `finish` back; the caller runs it in
 * the background under the same lock every other publish entry point takes, and the UI
 * follows the job's steps exactly as it does for a normal publish.
 */
export type PreviewPasswordUpdate = {
  /** The PREVIEW deployment row as it stands after the password write. */
  deployment: Deployment;
  /** The PUBLISH job that carries the new gate into a build; null for static stacks. */
  jobId: string | null;
  /**
   * Runs that build. Node stacks only. Rejects with the build's error after putting the
   * hash *and* the Coolify env var back, so the row and the application never disagree
   * about which password is in force.
   */
  finish: (() => Promise<void>) | null;
};

export async function updatePreviewPassword(input: {
  projectId: string;
  userId: string;
  password: string | null;
}): Promise<PreviewPasswordUpdate> {
  const deployment = await prisma.deployment.findUnique({
    where: { projectId_kind: { projectId: input.projectId, kind: 'PREVIEW' } },
    include: { server: true, project: { select: { stack: true } } },
  });
  if (!deployment?.coolifyAppUuid) {
    throw new Error('Publish a preview first');
  }
  const appUuid = deployment.coolifyAppUuid;
  const stack = getStack(deployment.project.stack);
  const auth = serverAuth(deployment.server);
  const previousHash = deployment.passwordHash;

  // Node stacks only, and before anything is written: the plaintext lives on the Coolify
  // application and nowhere else, so this read is the only way a failed change can be
  // undone. Letting the failure out here is deliberate — nothing has been written yet, so
  // the user retries one operation rather than being left with a row and an application
  // that disagree (F-231). A Coolify this unreachable would fail the publish anyway.
  const previousPlaintext =
    stack.deployType === 'static'
      ? null
      : ((await getApplicationEnvVar(auth, appUuid, PREVIEW_PASSWORD_ENV)) ?? '');

  // Dynamic on purpose: `@/lib/password` pulls bcrypt (a native addon) at module scope,
  // and this is the only path in the publish graph that hashes anything. A static import
  // would load it for every publish, every job runner and every `getPublishState`.
  const { hashPassword } = await import('@/lib/password');
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  await prisma.deployment.update({
    where: { id: deployment.id },
    data: { passwordHash },
  });

  if (stack.deployType === 'static') {
    // Traefik enforces the gate on the application itself, so there is nothing to build.
    await setBasicAuth(
      auth,
      appUuid,
      input.password ? { username: PREVIEW_BASIC_USER, password: input.password } : null,
    );
    return { deployment: await reloadDeployment(deployment.id), jobId: null, finish: null };
  }

  // Node stacks gate in middleware, which reads PREVIEW_PASSWORD from the container.
  // The env var has to be written before the build: Coolify applies it on deploy, so the
  // injected middleware and the value it compares against land together. Clearing writes
  // an empty string so a removed password does not linger on the app.
  const rollback = async () => {
    // Both writes go back together. Restoring only the hash left the abandoned plaintext
    // on the application, where the next successful publish would have deployed a gate
    // accepting a password the product had already told the user was not set (F-231).
    try {
      await prisma.deployment.update({
        where: { id: deployment.id },
        data: { passwordHash: previousHash },
      });
    } catch (error) {
      log.error('publish.preview_password_rollback_failed', {
        deploymentId: deployment.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await setApplicationEnvVars(auth, appUuid, {
        [PREVIEW_PASSWORD_ENV]: previousPlaintext ?? '',
      });
    } catch (error) {
      log.error('publish.preview_password_env_rollback_failed', {
        deploymentId: deployment.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  let started: PublishStartResult;
  try {
    await setApplicationEnvVars(auth, appUuid, { [PREVIEW_PASSWORD_ENV]: input.password ?? '' });
    started = await startPublishJob({
      projectId: input.projectId,
      kind: 'PREVIEW',
      userId: input.userId,
    });
  } catch (error) {
    await rollback();
    throw error;
  }

  const finish = async () => {
    try {
      const finished = await runPublishJob(started.jobId);
      // A runner declines when a publish is already in flight on this job (the `claimJobRun`
      // guard), and it returns rather than throws. The middleware carrying the new gate was
      // therefore never built, so this is the same failure as a build that broke.
      if (finished?.status !== 'SUCCEEDED') {
        throw new Error(
          'A publish is already running for this project. Wait for it to finish, then set the preview password again.',
        );
      }
    } catch (error) {
      await rollback();
      throw error;
    }
  };

  return { deployment: await reloadDeployment(deployment.id), jobId: started.jobId, finish };
}

function reloadDeployment(id: string) {
  return prisma.deployment.findUniqueOrThrow({ where: { id } });
}
