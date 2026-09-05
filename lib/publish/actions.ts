'use server';

import { after } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import type { DeploymentKind } from '@/generated/prisma';
import { DEFAULT_WORKSPACE_ID } from './constants';
import { assertPublishSlot, PublishLimitError } from './limits';
import { getLatestJobByKind, toPublicJob } from '@/lib/jobs';
import { runPublishJob } from './execute';
import type { PreviewPasswordUpdate } from './publish';
import {
  getProjectDeployments,
  PublishConflictError,
  startPublishJob,
  updatePreviewPassword,
} from './publish';
import { destroyDeployment, partialTeardownMessage, stopDeployment } from './cleanup';
import { confirmRepoOverwrite } from './overwrite';
import { ROLLBACK_CONFIRM_PHRASE } from '@/lib/deploy/rollback';
import { planDeploymentRollback, rollbackCommitMessage } from './rollback';
import { readReleaseHistory, settleRollback, startRollback } from './rollback-run';
import { projectHasPublishableFiles, siteFailsToBuild, PUBLISH_FILES_BROKEN } from './files';
import { serializeDeployment } from './serialize';
import { mapPrimaryHosts } from '@/lib/domains/store';
import { getPublishReadiness, peekRootDomain } from '@/lib/integrations/store';
import { publishBlockedMessage } from '@/lib/integrations/messages';
import { isPlaceholderSlug } from './naming';
import { resolveUniqueSlug, urlForSlug } from './slug';
import { log } from '@/lib/logger';
import { holdProjectLock } from '@/lib/projects/lock';
import { lockConflictAction } from '@/lib/projects/lock-http';
import { writeAudit } from '@/lib/audit/log';
import { canMutateOwned as canMutate } from '@/lib/auth/ownership';

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

  const [deployments, filesState, broken, readiness, root] = await Promise.all([
    getProjectDeployments(projectId),
    projectHasPublishableFiles(projectId),
    siteFailsToBuild(projectId),
    getPublishReadiness(DEFAULT_WORKSPACE_ID),
    peekRootDomain(DEFAULT_WORKSPACE_ID),
  ]);
  const missing = readiness.missing;
  const isAdmin = user.role === 'ADMIN';
  // `unavailable` is not "no files" — the Publish button hint must not say
  // "Generate the project first" during a storage outage.
  const hasFiles = filesState.status === 'ready';
  // A broken site does have files, so `hasFiles` stays true and only the hint and
  // `canPublish` change. Saying otherwise would put "Generate the project first" on the
  // button of a project holding a full site — the wrong instruction as well as the wrong
  // reason — and that sentence is what the fallback below produces.
  const filesHint =
    filesState.status === 'unavailable' ? filesState.reason : broken ? PUBLISH_FILES_BROKEN : null;
  const setupMessage = filesHint ?? publishBlockedMessage(missing, isAdmin, readiness.unreadable);
  const canPublish = filesState.status === 'ready' && !broken && missing.length === 0;

  const existingPreview = deployments.find((row) => row.kind === 'PREVIEW')?.slug ?? null;
  const existingLive = deployments.find((row) => row.kind === 'LIVE')?.slug ?? null;
  // A placeholder is "not claimed yet", so the candidate is derived from the project
  // name; a real slug is kept. `isPlaceholderSlug` matches the seeded shape exactly —
  // `startsWith('pending-')` also matched genuine slugs like `pending-order-app`.
  const previewSlug = await resolveUniqueSlug({
    name: project.name,
    kind: 'PREVIEW',
    existingSlug: existingPreview && isPlaceholderSlug(existingPreview) ? null : existingPreview,
  });
  const liveSlug = await resolveUniqueSlug({
    name: project.name,
    kind: 'LIVE',
    existingSlug: existingLive && isPlaceholderSlug(existingLive) ? null : existingLive,
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
      // `resolveUniqueSlug` has already resolved the address this publish will claim, so
      // show that. The old code replaced a `pending-` prefix with the literal `site`,
      // which is both a wrong address and a slug another project can own (F-244).
      previewUrl: root ? urlForSlug(previewSlug, 'PREVIEW', root) : '',
      liveUrl: root ? urlForSlug(liveSlug, 'LIVE', root) : '',
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
  // A site that does not compile must not reach a client's repository. Not a storage fault
  // and not "nothing generated yet", so it gets its own sentence — 409, the same code the
  // integrations gate uses for "this cannot run yet".
  if (await siteFailsToBuild(projectId)) {
    return { ok: false as const, error: PUBLISH_FILES_BROKEN, status: 409 as const };
  }
  if (filesState.status !== 'ready') {
    return { ok: false as const, error: 'Generate the project first', status: 400 as const };
  }

  const readiness = await getPublishReadiness(DEFAULT_WORKSPACE_ID);
  const missing = readiness.missing;
  const setupMessage = publishBlockedMessage(
    missing,
    loaded.user.role === 'ADMIN',
    readiness.unreadable,
  );
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

/**
 * Sets or clears the preview password, then returns.
 *
 * The node-stack path needs a build to carry the new gate, and that build used to be
 * awaited here: a ten-minute Coolify poll inside a server action that no platform lets
 * run that long, with no project lock held, so it could interleave with a generation or
 * another publish and then report "Password update fail" for a publish that was still
 * running (F-232). It now takes the same lock, runs under the same `after()` and is
 * followed through the same job as every other publish — the UI already renders that job's
 * steps.
 */
export async function setPreviewPasswordAction(projectId: string, password: string | null) {
  const loaded = await loadMutableProject(projectId);
  if ('error' in loaded) return { ok: false as const, error: loaded.error, status: loaded.status };

  const hold = await holdProjectLock(projectId, loaded.user.id, 'publish');
  if (!hold.ok) return lockConflictAction(hold);

  let update: PreviewPasswordUpdate;
  try {
    update = await updatePreviewPassword({ projectId, userId: loaded.user.id, password });
  } catch (error) {
    await hold.release();
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : 'Password update fail',
      // A publish of the other kind already running is a retry-later, not a bad request.
      status: error instanceof PublishConflictError ? (409 as const) : (400 as const),
    };
  }

  // Static stacks are gated by Traefik on the application itself: nothing to build, so the
  // change is already in force and the lock is not needed past this point.
  const finish = update.finish;
  if (!finish) {
    await hold.release();
    return getPublishState(projectId);
  }

  const run = async () => {
    try {
      await finish();
    } finally {
      await hold.release();
    }
  };
  const report = (error: unknown) => {
    log.warn('publish.preview_password_background_failed', {
      projectId,
      jobId: update.jobId,
      error: error instanceof Error ? error.message : String(error),
    });
  };
  try {
    after(() => run().catch(report));
  } catch {
    void run().catch(report);
  }

  return getPublishState(projectId);
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
  const outcome = await stopDeployment(id);
  if (!outcome.stopped) {
    // Nothing was written, so the deployment is exactly as the user left it: still
    // running, still serving its custom domains. Saying that is the difference between
    // "retry this" and a row that claims LIVE under an error toast (F-223).
    return {
      ok: false as const,
      error: `Coolify would not stop this deployment (${outcome.reason}). It is still running and its custom domains are still attached — try again once Coolify is reachable.`,
      status: 502 as const,
    };
  }
  const updated = outcome.deployment;
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

/**
 * The releases this deployment could be rolled back to (F-264).
 *
 * Owner-gated even though it only reads: the payload is the commit history of a
 * private deploy repository, and a member who cannot publish the project has no
 * business enumerating it.
 */
export async function listDeploymentReleasesAction(id: string) {
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
  const history = await readReleaseHistory(row);
  if (!history.ok) return { ok: false as const, error: history.error, status: 502 as const };
  return {
    ok: true as const,
    data: { releases: history.releases, confirmPhrase: ROLLBACK_CONFIRM_PHRASE },
  };
}

/**
 * Deploy a previous release of a published site.
 *
 * The pin-and-prove sequence and the release-list membership check both live in
 * `./rollback.ts`; this is the gate, the project lock, the audit entry and the
 * hand-off of the build watch to `after()`. What it must never do is report
 * success for a request that only redeployed the current release — see
 * `executeDeploymentRollback`.
 */
export async function rollbackDeploymentAction(
  id: string,
  targetSha: string,
  confirmation: string,
) {
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

  const history = await readReleaseHistory(row);
  if (!history.ok) {
    return {
      ok: false as const,
      error: `${history.error} Nothing was deployed.`,
      status: 502 as const,
    };
  }
  const plan = planDeploymentRollback({
    deployment: row,
    releases: history.releases,
    targetSha: typeof targetSha === 'string' ? targetSha : '',
    confirmation: typeof confirmation === 'string' ? confirmation : '',
  });
  if (!plan.ok) return { ok: false as const, error: plan.error, status: plan.status };
  // `planDeploymentRollback` refuses a row without one, so this is a narrowing, not a check.
  const coolifyAppUuid = row.coolifyAppUuid as string;

  const hold = await holdProjectLock(row.projectId, user.id, 'publish');
  if (!hold.ok) return lockConflictAction(hold);

  let started;
  try {
    started = await startRollback({
      deployment: { id: row.id, serverId: row.serverId, coolifyAppUuid },
      target: plan.target,
    });
  } catch (error) {
    await hold.release();
    throw error;
  }
  if (!started.ok) {
    // Nothing was deployed and the row was not touched, so the lock goes straight
    // back: there is no build for anyone to wait on.
    await hold.release();
    return { ok: false as const, error: started.error, status: started.status };
  }

  const watch = async () => {
    try {
      await settleRollback({
        deploymentId: row.id,
        serverId: row.serverId,
        coolifyDeploymentUuid: started.deploymentUuid,
        target: plan.target,
      });
    } finally {
      await hold.release();
    }
  };
  try {
    after(() =>
      watch().catch((error) => {
        log.warn('publish.rollback_watch_failed', {
          deploymentId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }),
    );
  } catch {
    void watch().catch((error) => {
      log.warn('publish.rollback_watch_failed', {
        deploymentId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'deployment.rollback',
    targetType: 'deployment',
    targetId: row.id,
    before: { commitSha: row.commitSha },
    after: {
      slug: row.slug,
      kind: row.kind,
      commitSha: started.sha,
      coolifyDeploymentUuid: started.deploymentUuid,
    },
  });

  return {
    ok: true as const,
    data: {
      id: row.id,
      sha: started.sha,
      buildLogUrl: started.buildLogUrl,
      message: `Deploying ${rollbackCommitMessage(plan.target)}. The site will switch over when the build finishes.`,
    },
  };
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
