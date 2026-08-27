'use server';

import { Prisma } from '@/generated/prisma';
import { prisma } from '@/lib/db';
import { getSessionUser, type SessionUser } from '@/lib/auth';
import {
  createProjectSchema,
  nameFromPrompt,
  parseWithZod,
  updateProjectSchema,
} from '@/lib/projects/schema';
import { offeredModel, ProviderNotConfiguredError } from '@/lib/ai/providers';
import { applyCreateProjectPlanFlow, peekActor } from '@/lib/projects/plan';
import { buildProjectListQuery, type ListProjectsQuery } from '@/lib/projects/list-sql';
import { isStaleClientError } from '@/lib/projects/list-fallback';
import { createCheckpointAfterGeneration } from '@/lib/checkpoints/actions';
import { CHECKPOINT_NOT_SAVED_NOTICE } from '@/lib/checkpoints/labels';
import { extractMemoriesAfterGeneration } from '@/lib/memory/extract';
import {
  countVisualEditsFromSource,
  maybeSettleFollowups,
  recordGenerationKept,
  recordVisualEditRate,
} from '@/lib/signals/collect';
import { decideUrlImportFlow } from '@/lib/import/pipeline';
import { upsertImportSource } from '@/lib/import/persist';
import { asCreditActionErr } from '@/lib/plans/http';
import { withLimit } from '@/lib/plans/limits';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { bumpContentVersion } from '@/lib/projects/lock';
import { incrementUsageCount } from '@/lib/templates/usage';
import { writeAudit } from '@/lib/audit/log';
import { log, logError } from '@/lib/logger';
import { capturePreviewAfterGeneration } from '@/lib/preview/after-generation';

export type ActionOk<T> = { ok: true; data: T };
export type ActionErr = {
  ok: false;
  error: string;
  status: number;
  details?: unknown;
};
export type ActionResult<T> = ActionOk<T> | ActionErr;

const ownerSelect = { id: true, name: true, email: true, role: true } as const;
const listOwnerSelect = { name: true, avatarUrl: true } as const;

const LIST_SORTS = new Set(['updatedAt', 'name', 'createdAt']);

/**
 * F-314: the project list is bounded in the UI, so the query is bounded too.
 * Both list paths use it, and both order newest-first, so the cap keeps the
 * same rows.
 */
const LIST_TAKE = 200;

type PublishBadge = 'draft' | 'preview' | 'live';

function unauthorized(): ActionErr {
  return { ok: false, error: 'Sign in required', status: 401 };
}

function notFound(): ActionErr {
  return { ok: false, error: 'Project not found', status: 404 };
}

function forbidden(): ActionErr {
  return { ok: false, error: 'Forbidden', status: 403 };
}

function canMutate(user: SessionUser, ownerId: string) {
  return user.id === ownerId || user.role === 'ADMIN';
}

/**
 * Runs post-generation follow-up work without blocking the response, and without losing the
 * failure.
 *
 * Detached is deliberate: the generation already succeeded and none of this may fail the
 * request. `void promise` was not — a rejection became an unhandled rejection with no project
 * and no task name, which is how `maybeSettleFollowups` could fail to settle job state with
 * nothing to show for it. A synchronous throw inside the task is caught here too.
 */
function detachAfterGeneration(projectId: string, task: string, work: () => Promise<unknown>) {
  void (async () => {
    try {
      await work();
    } catch (error) {
      logError('projects.after_generation_failed', error, { projectId, task });
    }
  })();
}

// Both say "nothing was saved" because that is exactly what the compensation below makes
// true, and both are retryable: the row is gone, so a second attempt starts clean.
const PLAN_FAILED_ON_CREATE = 'We could not plan this project, so nothing was saved. Try again.';
const IMPORT_SOURCE_FAILED =
  'We could not record the page to import, so nothing was saved. Try again.';

/**
 * Removes a project whose creation could not be completed.
 *
 * The delete used to be `.catch(() => undefined)`, so a failed cleanup was invisible and
 * the orphan it was supposed to remove stayed in the list, counting against the project
 * ceiling, with nothing anywhere saying why (F-808).
 */
async function discardIncompleteProject(projectId: string, reason: string) {
  try {
    await prisma.project.delete({ where: { id: projectId } });
  } catch (error) {
    logError('projects.create_compensation_failed', error, { projectId, reason });
  }
}

async function requireUser() {
  const user = await getSessionUser();
  if (!user) return { user: null, err: unauthorized() as ActionErr };
  return { user, err: null };
}

function copyName(name: string) {
  const next = `${name} (copy)`;
  return next.length > 100 ? next.slice(0, 100) : next;
}

/** Single insert path for dashboard, persist-client, and post-auth pending-prompt. */
export async function createProject(input: {
  name?: string;
  initialPrompt: string;
  skipPlanning?: boolean;
  deferPlanning?: boolean;
  stack?: string;
  designDirection?: string;
  importMode?: string;
  templateId?: string;
}) {
  const stored = peekActor();
  const actor = stored ? { user: stored, err: null as ActionErr | null } : await requireUser();
  if (!actor.user) return actor.err ?? unauthorized();
  const user = actor.user;

  const parsed = parseWithZod(createProjectSchema, input);
  if (!parsed.ok) return parsed;

  const flow = decideUrlImportFlow({
    initialPrompt: parsed.data.initialPrompt,
    skipPlanning: parsed.data.skipPlanning === true,
    importMode: parsed.data.importMode,
  });
  const skipPlanning = flow.skipPlanning;
  // A prompt-derived name is provisional: `applyCreateProjectPlanFlow` replaces it with the
  // plan's subject when the plan lands, because at this point no plan exists yet and the raw
  // prompt is all there is. A name the user typed is not provisional — it is passed as `null`
  // so the rename has nothing to match on and can never overwrite it.
  const explicitName =
    typeof parsed.data.name === 'string' && parsed.data.name.trim()
      ? parsed.data.name.trim()
      : null;
  const name = explicitName ?? nameFromPrompt(parsed.data.initialPrompt);
  const provisionalName = explicitName ? null : name;
  // The ceiling is enforced at the insert, not before it (F-307): `checkLimit` counted and
  // returned, and the `create` was a separate statement, so two concurrent creates at the
  // project ceiling both counted `limit - 1` and both inserted. `withLimit` re-counts
  // inside the transaction that does the insert, under an advisory lock keyed on the limit.
  const reserved = await withLimit(WORKSPACE_ROW_ID, 'projects', 1, (tx) =>
    tx.project.create({
      data: {
        name,
        initialPrompt: parsed.data.initialPrompt,
        ownerId: user.id,
        status: 'draft',
        generationStatus: flow.isUrlImport ? 'generating' : 'idle',
        progressMessage: flow.isUrlImport ? 'Capturing page…' : null,
        phase: skipPlanning ? 'BUILDING' : 'PLANNING',
        stack: parsed.data.stack,
        designDirection: parsed.data.designDirection,
      },
      include: { owner: { select: ownerSelect } },
    }),
  );
  if (!reserved.ok) return asCreditActionErr(reserved);
  const project = reserved.data;

  // Everything below runs outside the insert's transaction, and it has to: the plan flow
  // calls the AI provider, so wrapping it in `prisma.$transaction` would hold the
  // project-limit advisory lock that `withLimit` takes for the whole multi-second
  // generation and serialise every concurrent create in the workspace. The row is
  // therefore compensated on failure instead of rolled back — for *every* failure, not
  // just `ProviderNotConfiguredError` (F-808). Before this, a provider 429 that exhausted
  // failover, a Zod rejection of the model's plan JSON or a `createOrReuseJob` failure all
  // re-threw with the row committed, leaving an "Untitled project" corpse in PLANNING with
  // no plan, counting against the workspace's project ceiling.
  if (flow.isUrlImport) {
    try {
      await upsertImportSource({
        projectId: project.id,
        sourceUrl: flow.sourceUrl,
        mode: flow.importMode,
      });
    } catch (error) {
      // An import project with no `ImportSource` row cannot capture or resume: the import
      // route reads that row for the URL and the mode. The project is unusable, not merely
      // incomplete.
      logError('projects.create_import_source_failed', error, { projectId: project.id });
      await discardIncompleteProject(project.id, 'import_source_failed');
      return { ok: false as const, error: IMPORT_SOURCE_FAILED, status: 502 as const };
    }
  }

  let plan;
  // The name the plan settled on, when it landed inside this call. Null on the deferred path,
  // where the rename happens after the response has already been sent: the browser is in the
  // workspace by then, so the settled name is delivered through `nameAwaitingPlan` on
  // `getProject` instead — see the note on that flag. It used to say "the workspace's own poll
  // picks it up", which was not true of any poll that existed: the workspace read the row once
  // on mount and never again, so the header wore the truncated prompt slice for the whole
  // session while the dashboard and the database showed the plan's name.
  let planName: string | null = null;
  const deferPlanning = parsed.data.deferPlanning === true && !flow.isUrlImport && !skipPlanning;
  if (deferPlanning) {
    // The row exists; the browser can land in the workspace now. The plan
    // generates detached — useProjectPlan polls during PLANNING and renders
    // it the moment it lands, and a failed PLAN job surfaces through the
    // normal chat recovery panel. This path keeps its row on failure on
    // purpose: the user is already in the workspace and the recovery panel
    // offers Try again there.
    plan = null;
    detachAfterGeneration(project.id, 'initial-plan', () =>
      applyCreateProjectPlanFlow({
        projectId: project.id,
        userId: user.id,
        initialPrompt: parsed.data.initialPrompt,
        skipPlanning,
        provisionalName,
      }),
    );
  } else {
    try {
      const planned = await applyCreateProjectPlanFlow({
        projectId: project.id,
        userId: user.id,
        initialPrompt: parsed.data.initialPrompt,
        skipPlanning,
        provisionalName,
      });
      plan = planned.plan;
      planName = planned.name;
    } catch (error) {
      // The caller never reached the workspace, so there is no recovery panel to carry
      // this: the row has no plan, no job the user can see, and no way back to it except
      // as a corpse in the project list. Remove it and say what happened.
      await discardIncompleteProject(project.id, 'plan_failed');
      if (error instanceof ProviderNotConfiguredError) {
        // Nothing about this project can ever run until an admin adds a key, so failing
        // fast at the dashboard beats navigating into a dead workspace.
        return { ok: false as const, error: error.message, status: 503 as const };
      }
      logError('projects.create_plan_failed', error, { projectId: project.id });
      return { ok: false as const, error: PLAN_FAILED_ON_CREATE, status: 502 as const };
    }
  }

  if (parsed.data.templateId) {
    // A usage counter is bookkeeping: the project exists and works, so this must not throw
    // the create away after the plan has already been paid for and written (F-808).
    try {
      await incrementUsageCount(parsed.data.templateId);
    } catch (error) {
      logError('projects.template_usage_increment_failed', error, {
        projectId: project.id,
        templateId: parsed.data.templateId,
      });
    }
  }

  // `project` is the row as inserted, so its `name` is the provisional one even when the plan
  // has already renamed it in the database. Serving that stale value would show the dashboard
  // and the audit row a name that no longer exists.
  const named = planName ? { ...project, name: planName } : project;

  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'project.create',
    targetType: 'project',
    targetId: project.id,
    after: { name: named.name, stack: project.stack },
  });

  return {
    ok: true as const,
    data: {
      id: project.id,
      initialPrompt: project.initialPrompt,
      name: named.name,
      phase: project.phase,
      stack: project.stack,
      designDirection: project.designDirection,
      urlImport: flow.isUrlImport,
      importMode: flow.isUrlImport ? flow.importMode : undefined,
      plan,
      project: named,
    },
  };
}

export async function listProjects(query: {
  search?: string;
  sort?: string;
  mine?: boolean;
  starred?: boolean;
}) {
  const { user, err } = await requireUser();
  if (!user) return err;

  const sort = LIST_SORTS.has(query.sort || '') ? query.sort! : 'updatedAt';
  const search = query.search?.trim();

  try {
    const rows = await prisma.project.findMany({
      where: {
        deletedAt: null,
        ...(query.mine === true ? { ownerId: user.id } : {}),
        ...(query.mine === false ? { ownerId: { not: user.id } } : {}),
        ...(query.starred ? { stars: { some: { userId: user.id } } } : {}),
        // Name *and* prompt, because `/projects` now searches through this one path. Its
        // search box used to call `/api/search` instead, which matched the prompt body but
        // returned rows with no thumbnail, no owner and no honouring of mine/starred.
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' as const } },
                { initialPrompt: { contains: search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: sort === 'name' ? { name: 'asc' } : { [sort]: 'desc' },
      // F-314: the dashboard used to load every non-deleted project in the workspace on
      // every visit. The UI is bounded, so the query is too. Paired with
      // `@@index([deletedAt, updatedAt])` on Project.
      take: LIST_TAKE,
      select: {
        id: true,
        name: true,
        thumbnailUrl: true,
        status: true,
        phase: true,
        createdAt: true,
        updatedAt: true,
        ownerId: true,
        owner: { select: listOwnerSelect },
        stars: { where: { userId: user.id }, select: { id: true } },
      },
    });

    const projects = await withPublishBadges(
      rows.map(({ stars, ...project }) => ({
        ...project,
        starred: stars.length > 0,
      })),
    );

    return { ok: true as const, data: { projects } };
  } catch (error) {
    // F-804: only a stale Prisma client takes the fallback. Every other failure —
    // pool exhaustion, permissions, a genuine schema break — used to be reported
    // to the user as a successful list, so a real outage looked like an empty
    // workspace.
    if (!isStaleClientError(error)) {
      logError('projects.list_failed', error, { userId: user.id, sort });
      return { ok: false as const, error: 'Could not load projects', status: 500 };
    }

    logError('projects.list_stale_client', error, { userId: user.id, sort });
    try {
      const projects = await listProjectsFromSql({
        userId: user.id,
        sort,
        search,
        mine: query.mine,
        starred: query.starred === true,
      });
      return { ok: true as const, data: { projects } };
    } catch (fallbackError) {
      logError('projects.list_fallback_failed', fallbackError, { userId: user.id, sort });
      const message =
        fallbackError instanceof Error ? fallbackError.message : 'Could not load projects';
      return { ok: false as const, error: message, status: 500 };
    }
  }
}

type ListProjectRow = {
  id: string;
  name: string;
  thumbnailUrl: string | null;
  status: string;
  phase: 'PLANNING' | 'BUILDING' | 'COMPLETE' | null;
  createdAt: Date;
  updatedAt: Date;
  ownerId: string;
  ownerName: string | null;
  ownerAvatarUrl: string | null;
  starred: boolean;
};

/**
 * F-804: the publish badge used to be computed only on the raw-SQL fallback, so
 * a project card showed Live/Preview **only when the primary query had failed**
 * — a rendering difference nobody could reproduce without breaking the
 * database. Both paths run through here, so one list shape reaches the UI.
 *
 * A failure to read deployments degrades the badge, not the list: the rows
 * themselves are already correct, and the badge falls back to the project's own
 * status in `ProjectCard`. It is logged so the degradation is not silent.
 */
async function withPublishBadges<T extends { id: string }>(
  rows: T[],
): Promise<
  Array<T & { liveUrl: string | null; previewUrl: string | null; publishBadge: PublishBadge }>
> {
  const undecorated = rows.map((row) => ({
    ...row,
    liveUrl: null as string | null,
    previewUrl: null as string | null,
    publishBadge: 'draft' as PublishBadge,
  }));
  if (undecorated.length === 0) return undecorated;

  try {
    const deployments = await prisma.deployment.findMany({
      where: { projectId: { in: undecorated.map((row) => row.id) }, status: 'LIVE' },
      select: { projectId: true, kind: true, url: true },
    });
    const byProject = new Map<string, { liveUrl: string | null; previewUrl: string | null }>();
    for (const row of deployments) {
      const current = byProject.get(row.projectId) ?? { liveUrl: null, previewUrl: null };
      if (row.kind === 'LIVE') current.liveUrl = row.url;
      if (row.kind === 'PREVIEW') current.previewUrl = row.url;
      byProject.set(row.projectId, current);
    }
    return undecorated.map((project) => {
      const urls = byProject.get(project.id);
      return {
        ...project,
        liveUrl: urls?.liveUrl ?? null,
        previewUrl: urls?.previewUrl ?? null,
        publishBadge: urls?.liveUrl ? 'live' : urls?.previewUrl ? 'preview' : 'draft',
      };
    });
  } catch (error) {
    logError('projects.list_badges_failed', error, { count: undecorated.length });
    return undecorated;
  }
}

async function listProjectsFromSql(query: ListProjectsQuery) {
  const { sql, values } = buildProjectListQuery({ ...query, limit: LIST_TAKE });
  const rows = await prisma.$queryRawUnsafe<ListProjectRow[]>(sql, ...values);

  return await withPublishBadges(
    rows.map((row) => ({
      id: row.id,
      name: row.name,
      thumbnailUrl: row.thumbnailUrl,
      status: row.status,
      phase: row.phase,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ownerId: row.ownerId,
      owner: { name: row.ownerName, avatarUrl: row.ownerAvatarUrl },
      starred: Boolean(row.starred),
    })),
  );
}

/**
 * The detail read used to be `include` with no `select`, so it returned every scalar on
 * `Project` — the lock holder and lock expiry, `previewUrl`, `progressMessage`,
 * `generationStatus`, `contentVersion`, `activeJobId`, the GitHub repo fields — while
 * `listProjects` next to it curated ten columns. Any signed-in member could read all of
 * it for any project, and every column added to the model published itself here (F-809).
 *
 * This list is what the two consumers actually render: the workspace
 * (`GenerationWorkspace` name/updatedAt/style/model/lastCode/importSource) and
 * `useProjectPlan` (`phase`), plus the curated list columns so the two reads agree.
 *
 * `lastCode` stays: `GET /api/projects/[id]/files` already serves the same bytes to the
 * same audience — any signed-in member, deliberately, so a member opening a teammate's
 * project is not shown an empty studio — so withholding it here would break preview
 * restore without narrowing what is reachable.
 */
const projectDetailSelect = {
  id: true,
  name: true,
  // Read, never returned. `nameAwaitingPlan` below has to ask whether the row is still
  // wearing the name the prompt produced, and that question cannot be answered without the
  // prompt. It is stripped from the payload before it leaves `getProject`, because this list
  // is curated (F-809) and no client renders the prompt from here.
  initialPrompt: true,
  status: true,
  phase: true,
  stack: true,
  thumbnailUrl: true,
  style: true,
  model: true,
  lastCode: true,
  createdAt: true,
  updatedAt: true,
  ownerId: true,
  owner: { select: ownerSelect },
  importSource: { select: { sourceUrl: true, mode: true } },
} as const;

export async function getProject(id: string) {
  const { user, err } = await requireUser();
  if (!user) return err;

  const project = await prisma.project.findFirst({
    where: { id, deletedAt: null },
    select: projectDetailSelect,
  });

  if (!project) return { ok: true as const, data: null };

  const { initialPrompt, ...detail } = project;

  /**
   * True while this row is still wearing the provisional prompt-derived name and the plan
   * that would replace it has not landed yet.
   *
   * `deferPlanning` — what the dashboard sends — answers the create before any plan exists,
   * so the browser opens the workspace, reads this row once, and gets the raw prompt slice
   * (`Build a landing page for "Chai Point", a`). `renameFromPlan` writes `Chai Point` onto
   * the row seconds later, after that read. This flag is how the open workspace knows the
   * name it is showing is not final, so it can read once more instead of showing the slice
   * for the rest of the session.
   *
   * All three conditions matter. `PLANNING` is the only phase in which a first plan is still
   * in flight, so a URL import (inserted BUILDING) and a skip-planning create never arm it.
   * No `lastCode` separates a first plan from a follow-up plan on a finished site, which
   * `renameFromPlan` is never called for. And comparing against `nameFromPrompt` is what
   * keeps a name the *user* typed out of this: an explicit name is passed to the plan flow as
   * `null` and can never be overwritten, so it must never be reported as provisional either.
   */
  const nameAwaitingPlan =
    project.phase === 'PLANNING' &&
    !project.lastCode &&
    project.name === nameFromPrompt(initialPrompt);

  // The workspace seeds its model state from this row and then sends that value as
  // `model` on every generation, where a requested model is pushed to the FRONT of the
  // provider chain. So a row holding an id the product no longer offers — a legacy
  // vendor id from before DeepSeek, say — outranked `ai.primaryModel` from
  // Admin → Configuration for the life of the project, silently (F-004). Serving it as
  // `null` makes it "no explicit choice" again, so the chain resumes at the configured
  // primary. A value that is still offered is left alone: choosing Pro on a project
  // whose admin primary is Flash is a preference, not drift.
  const model = offeredModel(project.model) ?? null;
  if (project.model && !model) {
    log.warn('project.model_no_longer_offered', { projectId: project.id, stored: project.model });
  }
  return { ok: true as const, data: { ...detail, model, nameAwaitingPlan } };
}

export async function updateProject(id: string, input: { name?: string; status?: string }) {
  const { user, err } = await requireUser();
  if (!user) return err;

  const parsed = parseWithZod(updateProjectSchema, input);
  if (!parsed.ok) return parsed;

  const existing = await prisma.project.findFirst({
    where: { id, deletedAt: null },
    select: { ownerId: true },
  });
  if (!existing) return notFound();
  if (!canMutate(user, existing.ownerId)) return forbidden();

  const project = await prisma.project.update({
    where: { id },
    data: {
      ...(typeof parsed.data.name === 'string' ? { name: parsed.data.name } : {}),
      ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    },
    // Explicit, like the detail read (F-809), and deliberately narrower than it: the one
    // caller re-reads through `getProject`, so returning `lastCode` here would fetch an
    // 85KB column on every rename for a value nobody looks at.
    select: {
      id: true,
      name: true,
      status: true,
      phase: true,
      updatedAt: true,
      ownerId: true,
      owner: { select: ownerSelect },
    },
  });

  return { ok: true as const, data: project };
}

export async function deleteProject(id: string) {
  const { user, err } = await requireUser();
  if (!user) return err;

  const existing = await prisma.project.findFirst({
    where: { id, deletedAt: null },
    select: { ownerId: true },
  });
  if (!existing) return notFound();
  if (!canMutate(user, existing.ownerId)) return forbidden();

  const project = await prisma.project.update({
    where: { id },
    data: { deletedAt: new Date() },
    include: { owner: { select: ownerSelect } },
  });

  // What the user is told beyond "deleted". Empty on the happy path; a sentence when the
  // sites this project was serving are still up, because the project disappearing from the
  // dashboard while its Coolify applications keep running and keep billing is exactly the
  // state nobody could see before (F-806).
  let warning: string | null = null;
  try {
    // Dynamic on purpose: `publish/cleanup` reaches Coolify, Cloudflare and GitHub at
    // import time, and every project action would otherwise pay for that module graph.
    const { stopProjectDeployments, stoppedPartiallyMessage } =
      await import('@/lib/publish/cleanup');
    const outcome = await stopProjectDeployments(id);
    if (outcome.failed.length > 0) {
      // The rows stay non-STOPPED so the retention purge retries them; recorded here
      // because the user is told the project is deleted while these keep billing.
      log.warn('projects.soft_delete_stop_incomplete', { projectId: id, failed: outcome.failed });
      warning = stoppedPartiallyMessage(outcome.failed);
    }
  } catch (error) {
    // Could not even ask — a disconnected Coolify integration, an unreachable API. That is
    // not "nothing was running": it is "we do not know", and the difference is a live site.
    logError('projects.soft_delete_stop_failed', error, { projectId: id });
    warning =
      'The project was deleted, but its deployments could not be reached to stop them. Anything still running keeps costing money until the teardown succeeds; it is retried automatically.';
  }

  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'project.soft_delete',
    targetType: 'project',
    targetId: id,
    after: warning ? { stopIncomplete: true } : undefined,
  });

  return warning
    ? { ok: true as const, data: project, warning }
    : { ok: true as const, data: project };
}

export async function restoreProject(id: string) {
  const { user, err } = await requireUser();
  if (!user) return err;

  const existing = await prisma.project.findUnique({
    where: { id },
    select: { ownerId: true },
  });
  if (!existing) return notFound();
  if (!canMutate(user, existing.ownerId)) return forbidden();

  const project = await prisma.project.update({
    where: { id },
    data: { deletedAt: null },
    include: { owner: { select: ownerSelect } },
  });

  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'project.restore',
    targetType: 'project',
    targetId: id,
  });

  return { ok: true as const, data: project };
}

/**
 * Duplicate copies the *site*, not just the prompt.
 *
 * It used to read five columns and write six: no `lastCode`, no `ImportSource`, no plan,
 * and the phase fell to the schema default `PLANNING` — so "Duplicate" on a finished
 * project spent a slot from the project ceiling to produce a shell that showed an empty
 * preview and had no plan to approve (F-805, and F-664 for the missing test).
 *
 * `Project.lastCode` is the whole site: `collectPublishFiles` and `collectExportFiles`
 * both fall back to it when a project has no checkpoint, so a copy that carries it is
 * publishable and exportable. The checkpoint *objects* are deliberately not copied —
 * they would double the workspace's stored bytes for files already in `lastCode`.
 * `ProjectAsset` rows are not copied either: they carry `storageKey`s owned by the
 * source, so duplicating the rows would double-count storage and let either project's
 * purge delete the other's objects. The asset URLs inside `lastCode` still resolve.
 *
 * `previewUrl` is not copied: it names the source's own preview build.
 */
export async function duplicateProject(id: string) {
  const { user, err } = await requireUser();
  if (!user) return err;

  const source = await prisma.project.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      name: true,
      initialPrompt: true,
      ownerId: true,
      stack: true,
      designDirection: true,
      lastCode: true,
      thumbnailUrl: true,
      style: true,
      model: true,
      importSource: {
        select: {
          sourceUrl: true,
          mode: true,
          designTokens: true,
          sections: true,
          capturedAt: true,
        },
      },
    },
  });
  if (!source) return notFound();
  if (!canMutate(user, source.ownerId)) return forbidden();

  // The newest plan worth carrying. SUPERSEDED history stays with the original: the copy
  // starts its own version series at 1.
  const sourcePlan = await prisma.projectPlan.findFirst({
    where: { projectId: id, status: { in: ['PENDING', 'APPROVED'] } },
    orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
    select: { content: true, status: true, sourceMessage: true, trigger: true },
  });

  // Evidence, not the source's phase: the copy has no job, so it can never be BUILDING.
  const phase = source.lastCode ? 'COMPLETE' : 'PLANNING';

  // Same enforcement point as `createProject` (F-307). Everything the copy consists of
  // is written in that one transaction, so a failure leaves no half-copied project.
  const reserved = await withLimit(WORKSPACE_ROW_ID, 'projects', 1, async (tx) => {
    const created = await tx.project.create({
      data: {
        name: copyName(source.name),
        initialPrompt: source.initialPrompt,
        ownerId: user.id,
        status: 'draft',
        generationStatus: 'idle',
        phase,
        stack: source.stack,
        designDirection: source.designDirection,
        lastCode: source.lastCode,
        thumbnailUrl: source.thumbnailUrl,
        style: source.style,
        model: source.model,
      },
      include: { owner: { select: ownerSelect } },
    });

    if (source.importSource) {
      await tx.importSource.create({
        data: {
          projectId: created.id,
          sourceUrl: source.importSource.sourceUrl,
          mode: source.importSource.mode,
          designTokens: (source.importSource.designTokens ?? {}) as Prisma.InputJsonValue,
          sections: (source.importSource.sections ?? []) as Prisma.InputJsonValue,
          capturedAt: source.importSource.capturedAt,
        },
      });
    }

    if (sourcePlan) {
      await tx.projectPlan.create({
        data: {
          projectId: created.id,
          version: 1,
          content: (sourcePlan.content ?? {}) as Prisma.InputJsonValue,
          status: sourcePlan.status,
          sourceMessage: sourcePlan.sourceMessage,
          trigger: sourcePlan.trigger,
        },
      });
    }

    return created;
  });
  if (!reserved.ok) return asCreditActionErr(reserved);
  const project = reserved.data;

  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'project.duplicate',
    targetType: 'project',
    targetId: project.id,
    before: { projectId: source.id, name: source.name },
    after: { projectId: project.id, name: project.name, phase },
  });

  return { ok: true as const, data: project };
}

export type GenerationPersistInput = {
  style?: string | null;
  previewUrl?: string | null;
  thumbnailUrl?: string | null;
  lastCode?: string | null;
  generationStatus?: string | null;
  progressMessage?: string | null;
  sourceMessage?: string | null;
  source?: string | null;
  model?: string | null;
};

/**
 * No `sandboxId`. The column went with `20260819010000_drop_sandbox_columns`, but
 * this input kept accepting it and spreading it into `prisma.project.update`, and
 * the client always sent it — as `null`, which is present, not absent. So every
 * persist threw `PrismaClientValidationError: Unknown argument 'sandboxId'`, the
 * PATCH answered 500, and the client's stream reader died on the FIRST progress
 * frame. The server went on streaming for eleven minutes and 96k output tokens
 * while the workspace showed an empty pane and "Building your project…" — a
 * generation that looked hung and then lost its files. Adding a field here that
 * `Project` does not have is not a typo, it is an outage.
 */

export async function persistProjectGeneration(id: string, input: GenerationPersistInput) {
  const stored = peekActor();
  const actor = stored ? { user: stored, err: null as ActionErr | null } : await requireUser();
  if (!actor.user) return actor.err ?? unauthorized();
  const user = actor.user;

  const existing = await prisma.project.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, phase: true, ownerId: true },
  });
  if (!existing) return notFound();
  // Unlike its siblings this one used to resolve an actor and never use it, so any
  // signed-in member could PATCH another member's project and replace `lastCode` —
  // the source of truth the preview renders from — force phase COMPLETE, repoint
  // `previewUrl`, and kick off a billable preview build on someone else's project.
  // The `peekActor()` branch is unaffected: the stored actor is the user the
  // generation was started for, so it is the owner on that path too.
  if (!canMutate(user, existing.ownerId)) return forbidden();

  // Annotated, not inferred. A spread into an inline `data` object is structurally
  // checked against `ProjectUpdateInput` only loosely once optional spreads are
  // involved, which is how `sandboxId` survived a migration that dropped the column
  // and turned every persist into a 500. Naming the type here makes a field that
  // `Project` does not have a compile error instead of a runtime outage.
  const data: Prisma.ProjectUpdateInput = {
    ...(input.style !== undefined ? { style: input.style } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.previewUrl !== undefined ? { previewUrl: input.previewUrl } : {}),
    ...(input.thumbnailUrl !== undefined ? { thumbnailUrl: input.thumbnailUrl } : {}),
    ...(input.lastCode !== undefined ? { lastCode: input.lastCode } : {}),
    ...(input.generationStatus !== undefined && input.generationStatus
      ? { generationStatus: input.generationStatus }
      : {}),
    ...(input.progressMessage !== undefined ? { progressMessage: input.progressMessage } : {}),
    // COMPLETE means a finished site (lastCode / checkpoint). Gating this on
    // phase === BUILDING stranded projects: a build that ran after "Start
    // over" (which resets to PLANNING) persisted its site and stayed in
    // PLANNING forever, with the preview panel telling the user nothing was
    // built. Site evidence in this persist is the gate, not the prior phase.
    ...(existing.phase !== 'COMPLETE' &&
    input.generationStatus === 'ready' &&
    (input.lastCode || existing.phase === 'BUILDING')
      ? { phase: 'COMPLETE' as const }
      : {}),
  };

  const project = await prisma.project.update({
    where: { id },
    data,
    include: { owner: { select: ownerSelect } },
  });

  let previewNotice: string | null = null;
  if (input.generationStatus === 'ready') {
    await bumpContentVersion(id);
    try {
      const checkpoint = await createCheckpointAfterGeneration(id, {
        previousPhase: existing.phase,
        sourceMessage: input.sourceMessage,
      });
      if (checkpoint?.id) {
        const captured = await capturePreviewAfterGeneration(
          async () => {
            const { buildPreviewForProject } = await import('@/lib/preview/production');
            return buildPreviewForProject(id, checkpoint.id);
          },
          {
            projectId: id,
            checkpointId: checkpoint.id,
            checkpointCreatedAt: checkpoint.createdAt,
            findExisting: async () => {
              const { previewBuildTable } = await import('@/lib/preview/db');
              return previewBuildTable().findFirst({
                where: {
                  projectId: id,
                  checkpointId: checkpoint.id,
                  status: { in: ['READY', 'BUILDING'] },
                },
                orderBy: { createdAt: 'desc' },
              });
            },
          },
        );
        previewNotice = captured.notice;
        if (captured.error) {
          logError('projects.preview_after_generation_failed', captured.error, { projectId: id });
        } else if (captured.notice) {
          logError('projects.preview_after_generation_failed', new Error(captured.notice), {
            projectId: id,
          });
        }
      }
    } catch (error) {
      // The generation itself succeeded — the files are in `lastCode`. What failed is
      // the snapshot, which export, publish and restore all read, so the user has to be
      // told rather than shown a clean completion (F-807). The notice channel already
      // carries into chat; `logError` (not `console.error`) is what reaches Sentry.
      logError('projects.checkpoint_after_generation_failed', error, { projectId: id });
      previewNotice = CHECKPOINT_NOT_SAVED_NOTICE;
    }
    detachAfterGeneration(id, 'visual_edit_rate', () =>
      recordVisualEditRate(id, countVisualEditsFromSource(input.source, input.sourceMessage)),
    );
    detachAfterGeneration(id, 'settle_followups', () => maybeSettleFollowups(id));
    // The `revert_rate` population used to gain a row only when a restore rejected a
    // generation, or 30 minutes after a project stopped being touched. Pairing the kept
    // case here is what stops an actively iterated project reading as all-rejected
    // (F-818); a later restore flips this row to 0.
    detachAfterGeneration(id, 'revert_rate_kept', () => recordGenerationKept(id));
    detachAfterGeneration(id, 'extract_memories', () =>
      extractMemoriesAfterGeneration(id, { sourceMessage: input.sourceMessage, userId: user.id }),
    );
  }

  return { ok: true as const, data: project, previewNotice };
}
