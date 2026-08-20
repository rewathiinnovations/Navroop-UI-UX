'use server';

import { after } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import type { DeploymentKind } from '@/generated/prisma';
import { DEFAULT_WORKSPACE_ID } from './constants';
import { assertPublishSlot, PublishLimitError } from './limits';
import { getLatestJobByKind, toPublicJob } from '@/lib/jobs';
import { runPublishJob } from './execute';
import { getProjectDeployments, startPublishJob, updatePreviewPassword } from './publish';
import { destroyDeployment, partialTeardownMessage, stopDeployment } from './cleanup';
import { confirmRepoOverwrite } from './overwrite';
import { projectHasPublishableFiles } from './files';
import { serializeDeployment } from './serialize';
import { mapPrimaryHosts } from '@/lib/domains/store';
import { getMissingIntegrations, peekRootDomain } from '@/lib/integrations/store';
import { publishBlockedMessage } from '@/lib/integrations/messages';
import { resolveUniqueSlug, urlForSlug } from './slug';
import { log } from '@/lib/logger';
import { holdProjectLock } from '@/lib/projects/lock';
import { lockConflictAction } from '@/lib/projects/lock-http';
import { writeAudit } from '@/lib/audit/log';

function canMutate(user: { id: string; role: string }, ownerId: string) {
  return user.id === ownerId || user.role === 'ADMIN';
}

async function loadMutableProject(projectId: string) {
  const user = await getSessionUser();
  if (!user) return { error: 'Sign in required' as const, status: 401 as const };
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, name: true, ownerId: true, lastCode: true },
  });
  if (!project) return { error: 'Project not found' as const, status: 404 as const };
  if (!canMutate(user, project.ownerId))
    return { error: 'Forbidden' as const, status: 403 as const };
  return { user, project };
}

export async function getPublishState(projectId: string) {
  const user = await getSessionUser();
  if (!user) return { ok: false as const, error: 'Sign in required', status: 401 as const };
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!project) return { ok: false as const, error: 'Project not found', status: 404 as const };

  const [deployments, filesState, missing, root] = await Promise.all([
    getProjectDeployments(projectId),
    projectHasPublishableFiles(projectId),
    getMissingIntegrations(DEFAULT_WORKSPACE_ID),
    peekRootDomain(DEFAULT_WORKSPACE_ID),
  ]);
  const isAdmin = user.role === 'ADMIN';
  // `unavailable` is not "no files" — the Publish button hint must not say
  // "Generate the project first" during a storage outage.
  const hasFiles = filesState.status === 'ready';
  const filesHint = filesState.status === 'unavailable' ? filesState.reason : null;
  const setupMessage = filesHint ?? publishBlockedMessage(missing, isAdmin);
  const canPublish = filesState.status === 'ready' && missing.length === 0;

  const existingPreview = deployments.find((row) => row.kind === 'PREVIEW')?.slug ?? null;
  const existingLive = deployments.find((row) => row.kind === 'LIVE')?.slug ?? null;
  const previewSlug = await resolveUniqueSlug({
    name: project.name,
    kind: 'PREVIEW',
    existingSlug: existingPreview?.startsWith('pending-') ? null : existingPreview,
  });
  const liveSlug = await resolveUniqueSlug({
    name: project.name,
    kind: 'LIVE',
    existingSlug: existingLive?.startsWith('pending-') ? null : existingLive,
  });
  const primaries = await mapPrimaryHosts(deployments.map((row) => row.id));
  const publishJob = await getLatestJobByKind(projectId, 'PUBLISH');

  return {
    ok: true as const,
    data: {
      canPublish,
      hasFiles,
      isAdmin,
      missingIntegrations: missing,
      setupMessage,
      job: publishJob ? toPublicJob(publishJob) : null,
      previewUrl: root
        ? urlForSlug(
            previewSlug.startsWith('pending-')
              ? previewSlug.replace(/^pending-/, 'site')
              : previewSlug,
            'PREVIEW',
            root,
          )
        : '',
      liveUrl: root
        ? urlForSlug(
            liveSlug.startsWith('pending-') ? liveSlug.replace(/^pending-/, 'site') : liveSlug,
            'LIVE',
            root,
          )
        : '',
      deployments: deployments.map((row) =>
        serializeDeployment(row, root ?? '', { canonicalHost: primaries.get(row.id) ?? null }),
      ),
    },
  };
}

/**
 * No password parameter: preview protection is set through `setPreviewPasswordAction`,
 * which stores the hash and pushes the plaintext to Coolify. A password accepted here was
 * silently dropped by `startPublishJob`, so the build shipped an unprotected preview.
 */
export async function startPublish(
  projectId: string,
  kind: DeploymentKind,
  options?: { overwrite?: boolean; confirmName?: string },
) {
  const loaded = await loadMutableProject(projectId);
  if ('error' in loaded) return { ok: false as const, error: loaded.error, status: loaded.status };
  const filesState = await projectHasPublishableFiles(projectId);
  if (filesState.status === 'unavailable') {
    return { ok: false as const, error: filesState.reason, status: 503 as const };
  }
  if (filesState.status !== 'ready') {
    return { ok: false as const, error: 'Generate the project first', status: 400 as const };
  }

  const missing = await getMissingIntegrations(DEFAULT_WORKSPACE_ID);
  const setupMessage = publishBlockedMessage(missing, loaded.user.role === 'ADMIN');
  if (setupMessage) {
    return {
      ok: false as const,
      error: setupMessage,
      status: 409 as const,
      missingIntegrations: missing,
    };
  }

  if (options?.overwrite) {
    // F-202 escape hatch: server-side re-validation of the typed repo name. The client
    // boolean alone is never trusted; only a matching name adopts the existing repo.
    const confirmed = await confirmRepoOverwrite({
      projectId,
      kind,
      confirmName: options.confirmName ?? '',
      userId: loaded.user.id,
    });
    if (!confirmed.ok) {
      return { ok: false as const, error: confirmed.error, status: confirmed.status };
    }
  }

  try {
    await assertPublishSlot({ workspaceId: DEFAULT_WORKSPACE_ID, projectId, kind });
  } catch (error) {
    if (error instanceof PublishLimitError) {
      return {
        ok: false as const,
        error: error.message,
        status: 402 as const,
        reason: error.reason,
        used: error.used,
        limit: error.limit,
        message: error.message,
      };
    }
    throw error;
  }

  const hold = await holdProjectLock(projectId, loaded.user.id, 'publish');
  if (!hold.ok) return lockConflictAction(hold);

  // Exactly one of the two branches below runs `run`, so the `finally` is the single
  // place the lock goes back — and it is a no-op when this request re-entered a hold that
  // a generation of the same user is still using (security review NAV-03).
  const run = async () => {
    try {
      const started = await startPublishJob({
        projectId,
        kind,
        userId: loaded.user.id,
      });
      await runPublishJob(started.jobId);
    } finally {
      await hold.release();
    }
  };

  try {
    after(() =>
      run().catch((error) => {
        log.warn('publish.background_failed', {
          projectId,
          kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }),
    );
  } catch {
    void run().catch((error) => {
      log.warn('publish.background_failed', {
        projectId,
        kind,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  await writeAudit({
    actorId: loaded.user.id,
    actorEmail: loaded.user.email,
    action: 'deployment.create',
    targetType: 'project',
    targetId: projectId,
    after: options?.overwrite ? { kind, overwrite: true } : { kind },
  });

  const state = await getPublishState(projectId);
  return state.ok ? { ok: true as const, data: state.data } : state;
}

export async function retryPublish(projectId: string, kind: DeploymentKind) {
  return startPublish(projectId, kind);
}

export async function setPreviewPasswordAction(projectId: string, password: string | null) {
  const loaded = await loadMutableProject(projectId);
  if ('error' in loaded) return { ok: false as const, error: loaded.error, status: loaded.status };
  try {
    await updatePreviewPassword({ projectId, userId: loaded.user.id, password });
    return getPublishState(projectId);
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : 'Password update fail',
      status: 400 as const,
    };
  }
}

export async function listWorkspaceDeployments() {
  const user = await getSessionUser();
  if (!user) return { ok: false as const, error: 'Sign in required', status: 401 as const };
  const rows = await prisma.deployment.findMany({
    include: {
      publishedBy: { select: { id: true, name: true } },
      project: { select: { name: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });
  const root = (await peekRootDomain(DEFAULT_WORKSPACE_ID)) ?? '';
  const primaries = await mapPrimaryHosts(rows.map((row) => row.id));
  return {
    ok: true as const,
    data: {
      deployments: rows.map((row) =>
        serializeDeployment(row, root, { canonicalHost: primaries.get(row.id) ?? null }),
      ),
    },
  };
}

export async function stopDeploymentAction(id: string) {
  const user = await getSessionUser();
  if (!user) return { ok: false as const, error: 'Sign in required', status: 401 as const };
  const row = await prisma.deployment.findUnique({
    where: { id },
    include: { project: { select: { ownerId: true } } },
  });
  if (!row) return { ok: false as const, error: 'Deployment not found', status: 404 as const };
  if (!canMutate(user, row.project.ownerId))
    return { ok: false as const, error: 'Forbidden', status: 403 as const };
  const updated = await stopDeployment(id);
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'deployment.stop',
    targetType: 'deployment',
    targetId: id,
    after: { slug: row.slug, kind: row.kind },
  });
  const root = (await peekRootDomain(DEFAULT_WORKSPACE_ID)) ?? '';
  const primaries = await mapPrimaryHosts([updated.id]);
  return {
    ok: true as const,
    data: serializeDeployment(updated, root, { canonicalHost: primaries.get(updated.id) ?? null }),
  };
}

export async function redeployAction(id: string) {
  const user = await getSessionUser();
  if (!user) return { ok: false as const, error: 'Sign in required', status: 401 as const };
  const row = await prisma.deployment.findUnique({
    where: { id },
    include: { project: { select: { ownerId: true, deletedAt: true } } },
  });
  if (!row || row.project.deletedAt)
    return { ok: false as const, error: 'Deployment not found', status: 404 as const };
  if (!canMutate(user, row.project.ownerId))
    return { ok: false as const, error: 'Forbidden', status: 403 as const };
  return startPublish(row.projectId, row.kind);
}

export async function deleteDeploymentAction(id: string, confirmSlug: string) {
  const user = await getSessionUser();
  if (!user) return { ok: false as const, error: 'Sign in required', status: 401 as const };
  const row = await prisma.deployment.findUnique({
    where: { id },
    include: { project: { select: { ownerId: true } } },
  });
  if (!row) return { ok: false as const, error: 'Deployment not found', status: 404 as const };
  if (!canMutate(user, row.project.ownerId))
    return { ok: false as const, error: 'Forbidden', status: 403 as const };
  if (confirmSlug.trim() !== row.slug) {
    return { ok: false as const, error: 'Type the slug to confirm', status: 422 as const };
  }
  const destroyed = await destroyDeployment(id, { deleteRepo: true });
  // `null` means the row was already gone by the time the teardown read it. Nothing
  // survives, so the list is right to drop it — but do not call that a deletion we did.
  const failures = destroyed?.failures ?? [];
  const rowDeleted = destroyed ? destroyed.rowDeleted : true;
  const message = !destroyed
    ? 'This deployment had already been removed.'
    : rowDeleted
      ? 'Deployment deleted.'
      : partialTeardownMessage(failures);
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'deployment.delete',
    targetType: 'deployment',
    targetId: id,
    // A Path B zone is never deleted from Cloudflare, and this delete just removed the
    // CustomDomain row that pointed at it. The audit entry is the surviving pointer, so an
    // operator can still find (and reclaim) the zone afterwards.
    after: {
      slug: row.slug,
      kind: row.kind,
      keptCloudflareZones: destroyed?.keptCloudflareZones ?? [],
      // A partial teardown leaves provider resources alive with only this entry and the
      // surviving row naming them.
      failures,
      rowDeleted,
    },
  });
  // The caller renders all three: a partial teardown is a warning that must keep the row
  // on screen, not a success that removes it.
  return { ok: true as const, data: { id, rowDeleted, failures, message } };
}
