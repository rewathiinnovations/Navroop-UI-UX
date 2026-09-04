'use server';

import { getSessionUser, requireAdmin, type SessionUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { asCreditActionErr } from '@/lib/plans/http';
import { checkLimit } from '@/lib/plans/limits';
import type { PlanContent } from '@/lib/projects/plan';
import { createProject, deleteProject } from '@/lib/projects/actions';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { DEFAULT_DESIGN_DIRECTION, isDesignDirectionId } from '@/lib/design/directions';
import { DEFAULT_STACK, isStackId } from '@/lib/stacks';
import {
  BUILTIN_TEMPLATE_DELETE_FORBIDDEN,
  WORKSPACE_TEMPLATE_DELETE_FORBIDDEN,
  canDeleteTemplate,
  canManageTemplates,
  isBuiltInTemplate,
  memberCannotAdmin,
} from './auth';
import { createProjectFromTemplate } from './create';
import {
  createFromTemplateSchema,
  parseWithZod,
  saveTemplateSchema,
  adminTemplateSchema,
} from './schema';
import { buildTemplatePromptFromProject } from './summary';
import {
  deleteTemplateRow,
  findTemplateById,
  findTemplateBySlug,
  insertTemplate,
  listTemplateRows,
  uniqueSlug,
  updateTemplateRow,
} from './store';
import { toPublic } from './public';
import { thumbnailUrlBase } from './thumbnails';
import { captureThumbnailFromUrl, storeThumbnailBuffer } from './thumbnails';
import type { TemplateSort } from './types';
import { isVisibleToWorkspace } from './visibility';
import { writeAudit } from '@/lib/audit/log';
import { withRecordedJob } from '@/lib/jobs/wrap';
import { logError } from '@/lib/logger';
import { publishProjectAndWait } from '@/lib/publish/publish';
import { selectThumbnailTargets, thumbnailBatchMessage } from './thumbnail-batch';

type ActionErr = { ok: false; error: string; status: number; details?: unknown };

function unauthorized(): ActionErr {
  return { ok: false, error: 'Sign in required', status: 401 };
}

function notFound(): ActionErr {
  return { ok: false, error: 'Template not found', status: 404 };
}

function forbidden(): ActionErr {
  return { ok: false, error: 'Forbidden', status: 403 };
}

async function requireUser(): Promise<
  { user: SessionUser; err: null } | { user: null; err: ActionErr }
> {
  const user = await getSessionUser();
  if (!user) return { user: null, err: unauthorized() };
  return { user, err: null };
}

export async function listTemplates(query: {
  category?: string;
  stack?: string;
  sort?: TemplateSort;
  includeInactive?: boolean;
}) {
  const { user, err } = await requireUser();
  if (!user) return err;

  const includeInactive = query.includeInactive === true;
  if (includeInactive && !canManageTemplates(user.role)) return memberCannotAdmin();

  const rows = await listTemplateRows({
    workspaceId: WORKSPACE_ROW_ID,
    includeInactive,
    category: query.category,
    stack: query.stack,
    sort: query.sort,
  });
  const visible = includeInactive
    ? rows
    : rows.filter((row) => isVisibleToWorkspace(row, WORKSPACE_ROW_ID));
  const thumbnailBase = await thumbnailUrlBase();
  return {
    ok: true as const,
    data: { templates: visible.map((row) => toPublic(row, thumbnailBase)) },
  };
}

export async function getTemplate(id: string) {
  const { user, err } = await requireUser();
  if (!user) return err;
  const row = await findTemplateById(id);
  if (!row) return notFound();
  const admin = canManageTemplates(user.role);
  if (!isVisibleToWorkspace(row, WORKSPACE_ROW_ID, { includeInactive: admin })) {
    return notFound();
  }
  return { ok: true as const, data: { template: toPublic(row, await thumbnailUrlBase()) } };
}

/**
 * F-824: `adminTestTemplate` delegated here, and this gate ran without
 * `includeInactive`, so `visibility.ts` rejected any row with
 * `isActive === false`. `adminListTemplates` passes `includeInactive: true`, so
 * the admin table listed inactive templates and offered Test on them —
 * answering "Template not found" for a row the same screen was displaying.
 * Test-before-activate is the natural workflow and it was the one that failed.
 *
 * `getTemplate` already takes the same option; this is that precedent.
 */
async function createFromTemplateRow(
  id: string,
  input: { prompt?: string; name?: string },
  visibility: { includeInactive?: boolean },
) {
  const { user, err } = await requireUser();
  if (!user) return err;

  const parsed = parseWithZod(createFromTemplateSchema, input);
  if (!parsed.ok) return parsed;

  const row = await findTemplateById(id);
  if (!row || !isVisibleToWorkspace(row, WORKSPACE_ROW_ID, visibility)) return notFound();

  const prompt = parsed.data.prompt?.trim() || row.prompt;
  const stack = isStackId(row.stack) ? row.stack : DEFAULT_STACK;
  const designDirection = isDesignDirectionId(row.designDirection)
    ? row.designDirection
    : DEFAULT_DESIGN_DIRECTION;

  return createProjectFromTemplate({
    templateId: row.id,
    prompt,
    stack,
    designDirection,
    name: parsed.data.name,
  });
}

export async function createFromTemplate(id: string, input: { prompt?: string; name?: string }) {
  return await createFromTemplateRow(id, input, {});
}

export async function previewSaveAsTemplate(projectId: string) {
  const { user, err } = await requireUser();
  if (!user) return err;

  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: {
      id: true,
      name: true,
      initialPrompt: true,
      stack: true,
      designDirection: true,
      ownerId: true,
      previewUrl: true,
      // Approved only, and deterministically ordered (F-828). Unfiltered, this took the
      // latest row by version — happily a PENDING plan the user has not accepted, or a
      // SUPERSEDED one they refined away — and fed it to buildTemplatePromptFromProject,
      // so a template every future project is generated from could be seeded from a plan
      // that was rejected. `version` alone is not a total order either (duplicate versions
      // exist), hence the createdAt tiebreak.
      plans: {
        where: { status: 'APPROVED' },
        orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
        take: 1,
        select: { content: true },
      },
    },
  });
  if (!project) return { ok: false as const, error: 'Project not found', status: 404 };
  if (user.id !== project.ownerId && user.role !== 'ADMIN') return forbidden();

  const plan = (project.plans[0]?.content ?? null) as PlanContent | null;
  const prompt = buildTemplatePromptFromProject({
    initialPrompt: project.initialPrompt,
    plan,
    stack: project.stack,
    designDirection: project.designDirection,
  });

  return {
    ok: true as const,
    data: {
      name: project.name,
      description: plan?.summary?.slice(0, 240) || project.initialPrompt.slice(0, 240),
      prompt,
      stack: project.stack,
      designDirection: project.designDirection,
      previewUrl: project.previewUrl,
    },
  };
}

export async function saveProjectAsTemplate(
  projectId: string,
  input: {
    name: string;
    description: string;
    category: string;
    prompt: string;
  },
) {
  const { user, err } = await requireUser();
  if (!user) return err;

  const parsed = parseWithZod(saveTemplateSchema, input);
  if (!parsed.ok) return parsed;

  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: {
      id: true,
      ownerId: true,
      stack: true,
      designDirection: true,
      previewUrl: true,
    },
  });
  if (!project) return { ok: false as const, error: 'Project not found', status: 404 };
  if (user.id !== project.ownerId && user.role !== 'ADMIN') return forbidden();

  const created = await insertTemplate({
    slug: uniqueSlug(parsed.data.name),
    name: parsed.data.name,
    description: parsed.data.description,
    category: parsed.data.category,
    stack: project.stack,
    prompt: parsed.data.prompt,
    designDirection: project.designDirection,
    previewUrl: project.previewUrl,
    isActive: true,
    isBuiltIn: false,
    workspaceId: WORKSPACE_ROW_ID,
    createdById: user.id,
  });
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'template.create',
    targetType: 'template',
    targetId: created.id,
    after: { name: created.name },
  });

  if (project.previewUrl) {
    try {
      const key = await captureThumbnailFromUrl(project.previewUrl, created.id, user.id);
      const updated = await updateTemplateRow(created.id, { thumbnailKey: key });
      return {
        ok: true as const,
        data: { template: toPublic(updated ?? created, await thumbnailUrlBase()) },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not capture thumbnail';
      return {
        ok: true as const,
        data: {
          template: toPublic(created, await thumbnailUrlBase()),
          thumbnailWarning: message,
        },
      };
    }
  }

  return { ok: true as const, data: { template: toPublic(created, await thumbnailUrlBase()) } };
}

export async function deleteTemplate(id: string) {
  const { user, err } = await requireUser();
  if (!user) return err;

  const row = await findTemplateById(id);
  const admin = canManageTemplates(user.role);
  if (!row || !isVisibleToWorkspace(row, WORKSPACE_ROW_ID, { includeInactive: admin })) {
    return notFound();
  }
  if (!canDeleteTemplate(user, row, WORKSPACE_ROW_ID)) {
    if (isBuiltInTemplate(row)) {
      return { ok: false as const, error: BUILTIN_TEMPLATE_DELETE_FORBIDDEN, status: 403 };
    }
    return { ok: false as const, error: WORKSPACE_TEMPLATE_DELETE_FORBIDDEN, status: 403 };
  }

  await deleteTemplateRow(id);
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'template.delete',
    targetType: 'template',
    targetId: id,
    after: { name: row.name },
  });
  return { ok: true as const, data: { id } };
}

export async function adminListTemplates(query: {
  category?: string;
  stack?: string;
  sort?: TemplateSort;
}) {
  const { user, error, status } = await requireAdmin();
  if (!user) return { ok: false as const, error, status };
  const rows = await listTemplateRows({
    workspaceId: WORKSPACE_ROW_ID,
    includeInactive: true,
    category: query.category,
    stack: query.stack,
    sort: query.sort ?? 'newest',
  });
  const thumbnailBase = await thumbnailUrlBase();
  return {
    ok: true as const,
    data: { templates: rows.map((row) => toPublic(row, thumbnailBase)) },
  };
}

export async function adminCreateTemplate(input: unknown) {
  const { user, error, status } = await requireAdmin();
  if (!user) return { ok: false as const, error, status };
  const parsed = parseWithZod(adminTemplateSchema, input);
  if (!parsed.ok) return parsed;
  const data = parsed.data;
  if (await slugTaken(data.slug)) return slugConflict(data.slug as string);
  const created = await insertTemplate({
    slug: data.slug || uniqueSlug(data.name),
    name: data.name,
    description: data.description,
    category: data.category,
    stack: data.stack || DEFAULT_STACK,
    prompt: data.prompt,
    designDirection: data.designDirection || DEFAULT_DESIGN_DIRECTION,
    previewUrl: data.previewUrl || null,
    isActive: data.isActive !== false,
    isBuiltIn: data.isBuiltIn === true,
    workspaceId: data.workspaceId === undefined ? null : data.workspaceId,
    createdById: user.id,
    sortOrder: data.sortOrder ?? 0,
  });
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'template.create',
    targetType: 'template',
    targetId: created.id,
    after: { name: created.name },
  });
  return { ok: true as const, data: { template: toPublic(created, await thumbnailUrlBase()) } };
}

/**
 * Resolve a template for an admin write.
 *
 * `findTemplateById` is `WHERE id = $1` with no workspace predicate, so the three
 * admin write paths used to mutate a row the read paths would refuse to show
 * (F-826). No second workspace exists today — `WORKSPACE_ROW_ID` is one constant
 * row — but the invariant is absolute, the reads all enforce it, and the writes
 * are the ones that would keep working the day a second workspace appears.
 * `includeInactive` because the admin table lists and acts on inactive rows.
 */
async function manageableTemplate(id: string) {
  const row = await findTemplateById(id);
  if (!row || !isVisibleToWorkspace(row, WORKSPACE_ROW_ID, { includeInactive: true })) {
    return { row: null, err: notFound() };
  }
  return { row, err: null };
}

/**
 * `Template.slug` is `@unique` and `insertTemplate`/`updateTemplateRow` are raw
 * SQL with no conflict handling, so an admin typing a slug that already exists
 * got a raw Postgres unique violation thrown out of the server action — a
 * generic failure with no hint that the slug was the problem, while every other
 * validation failure in this module returns a typed result the UI renders
 * (F-827). The schema only validates the slug's shape, never its availability.
 */
async function slugTaken(slug: string | undefined, exceptId?: string) {
  if (!slug) return false;
  const owner = await findTemplateBySlug(slug);
  return Boolean(owner) && owner?.id !== exceptId;
}

function slugConflict(slug: string): ActionErr {
  return {
    ok: false,
    error: `Slug "${slug}" is already in use`,
    status: 409,
    details: { field: 'slug' },
  };
}

/** The columns an update may change, for the audit diff. */
const AUDITED_TEMPLATE_FIELDS = [
  'slug',
  'name',
  'description',
  'category',
  'stack',
  'prompt',
  'designDirection',
  'previewUrl',
  'isActive',
  'isBuiltIn',
  'workspaceId',
  'sortOrder',
] as const;

export async function adminUpdateTemplate(id: string, input: unknown) {
  const { user, error, status } = await requireAdmin();
  if (!user) return { ok: false as const, error, status };
  const parsed = parseWithZod(adminTemplateSchema.partial(), input);
  if (!parsed.ok) return parsed;
  const { row: existing, err } = await manageableTemplate(id);
  if (!existing) return err;
  const data = parsed.data;
  if (await slugTaken(data.slug, id)) return slugConflict(data.slug as string);
  const updated = await updateTemplateRow(id, {
    slug: data.slug,
    name: data.name,
    description: data.description,
    category: data.category,
    stack: data.stack,
    prompt: data.prompt,
    designDirection: data.designDirection,
    previewUrl: data.previewUrl === '' ? null : data.previewUrl,
    isActive: data.isActive,
    isBuiltIn: data.isBuiltIn,
    workspaceId: data.workspaceId,
    sortOrder: data.sortOrder,
  });
  // F-825: create and delete were audited, update was not — and update is the
  // mutation with the widest blast radius, because rewriting a built-in
  // template's prompt changes every project generated from it afterwards.
  // before/after carry only the fields that actually moved, so the diff on
  // /admin/audit reads as the change rather than the whole row.
  const after = updated ?? existing;
  const before: Record<string, unknown> = {};
  const changed: Record<string, unknown> = {};
  for (const field of AUDITED_TEMPLATE_FIELDS) {
    if (data[field] === undefined) continue;
    if (existing[field] === after[field]) continue;
    before[field] = existing[field];
    changed[field] = after[field];
  }
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'template.update',
    targetType: 'template',
    targetId: id,
    before: { name: existing.name, ...before },
    after: { name: after.name, ...changed },
  });
  return { ok: true as const, data: { template: toPublic(after, await thumbnailUrlBase()) } };
}

export async function adminDeleteTemplate(id: string) {
  const { user, error, status } = await requireAdmin();
  if (!user) return { ok: false as const, error, status };
  const { row: existing, err } = await manageableTemplate(id);
  if (!existing) return err;
  await deleteTemplateRow(id);
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'template.delete',
    targetType: 'template',
    targetId: id,
    after: { name: existing.name },
  });
  return { ok: true as const, data: { id } };
}

export async function adminTestTemplate(id: string) {
  const { user, error, status } = await requireAdmin();
  if (!user) return { ok: false as const, error, status };
  // F-824: the admin table lists inactive templates and offers Test on them, so
  // Test has to be able to reach one.
  return await createFromTemplateRow(id, {}, { includeInactive: true });
}

export async function adminUploadThumbnail(id: string, buffer: Buffer) {
  const { user, error, status } = await requireAdmin();
  if (!user) return { ok: false as const, error, status };
  const { row: existing, err } = await manageableTemplate(id);
  if (!existing) return err;
  const key = await storeThumbnailBuffer(id, buffer);
  const updated = await updateTemplateRow(id, { thumbnailKey: key });
  const after = updated ?? existing;
  await writeAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: 'template.thumbnail',
    targetType: 'template',
    targetId: id,
    before: { name: existing.name, thumbnailKey: existing.thumbnailKey },
    after: { name: after.name, thumbnailKey: after.thumbnailKey },
  });
  return { ok: true as const, data: { template: toPublic(after, await thumbnailUrlBase()) } };
}

/**
 * F-823: this looped over *every* built-in template without a thumbnail and, per
 * iteration, created a real project (a full plan flow, an AI call), published a
 * real Coolify preview, captured a screenshot and soft-deleted the project — all
 * sequential, all inside one server action that returned nothing until the last
 * iteration finished. With the ten seeded built-ins that is ten AI plans plus
 * ten deploys in one request, far past any gateway or server-action timeout: the
 * operator saw a failure while the work carried on and the results were lost.
 *
 * Three changes. The batch is bounded (`selectThumbnailTargets`), so one press
 * is one unit of work that returns something readable. `remaining` reports what
 * is left, so an unfinished batch says so instead of looking complete. And the
 * throwaway project is deleted in a `finally`, so a throw anywhere past
 * `createProject` can no longer strand a real "Thumbnail <name>" project until
 * the 30-day purge cron.
 *
 * Stopping is not pressing again. That is the only cancellation with any meaning
 * for a synchronous action — nothing can interrupt an awaited Coolify deploy —
 * and the bound is what makes it a real one: the operator is never more than one
 * template deep. Each unit is still recorded as a `TEMPLATE_THUMBNAIL` job, so
 * `/admin/jobs` sees it.
 */
export async function adminGenerateThumbnails() {
  const { user, error, status } = await requireAdmin();
  if (!user) return { ok: false as const, error, status };

  const rows = await listTemplateRows({
    workspaceId: WORKSPACE_ROW_ID,
    includeInactive: true,
    sort: 'newest',
  });
  const { targets, remaining } = selectThumbnailTargets(rows);

  if (targets.length === 0) {
    return {
      ok: true as const,
      data: {
        results: [],
        remaining: 0,
        message: 'Every built-in template already has a thumbnail.',
      },
    };
  }

  // The limit used to be checked once, for a single project, while the loop
  // created one per template. It is now checked for exactly what this press is
  // about to create.
  const limit = await checkLimit(WORKSPACE_ROW_ID, 'projects', targets.length);
  if (!limit.ok) return asCreditActionErr(limit);

  const results: Array<{ id: string; slug: string; ok: boolean; error?: string }> = [];
  let generated = 0;

  for (const row of targets) {
    let createdId: string | null = null;
    try {
      const created = await createProject({
        name: `Thumbnail ${row.name}`,
        initialPrompt: row.prompt,
        stack: isStackId(row.stack) ? row.stack : DEFAULT_STACK,
        designDirection: isDesignDirectionId(row.designDirection)
          ? row.designDirection
          : DEFAULT_DESIGN_DIRECTION,
      });
      if (!created.ok) {
        results.push({ id: row.id, slug: row.slug, ok: false, error: created.error });
        continue;
      }
      createdId = created.data.id;

      const previewUrl = created.data.project.previewUrl;
      if (!previewUrl) {
        results.push({
          id: row.id,
          slug: row.slug,
          ok: false,
          error:
            'No preview URL is available to capture. Publish a preview for this template first, or upload a thumbnail.',
        });
        continue;
      }

      try {
        const published = await publishProjectAndWait({
          projectId: createdId,
          kind: 'PREVIEW',
          userId: user.id,
        });
        const captureUrl = published.url || previewUrl;
        const key = await withRecordedJob(
          {
            projectId: createdId,
            userId: user.id,
            kind: 'TEMPLATE_THUMBNAIL',
            inputPrompt: row.slug,
          },
          async () => captureThumbnailFromUrl(captureUrl, row.id, user.id),
        );
        await updateTemplateRow(row.id, { thumbnailKey: key, previewUrl: captureUrl });
        generated += 1;
        results.push({ id: row.id, slug: row.slug, ok: true });
      } catch (publishError) {
        const message =
          publishError instanceof Error
            ? publishError.message
            : 'Could not publish a preview to capture a thumbnail.';
        results.push({
          id: row.id,
          slug: row.slug,
          ok: false,
          error: `${message} Upload a thumbnail instead, or connect GitHub, Cloudflare, and Coolify first.`,
        });
      }
    } catch (thumbnailError) {
      results.push({
        id: row.id,
        slug: row.slug,
        ok: false,
        error:
          thumbnailError instanceof Error ? thumbnailError.message : 'Could not generate thumbnail',
      });
    } finally {
      if (createdId) {
        // Losing the throwaway project is a leak, not a result: report the
        // thumbnail outcome either way, but never let the leak pass unrecorded.
        // `deleteProject` reports expected failures by returning `ok: false`
        // rather than throwing, so both shapes have to be looked at.
        const cleanupId = createdId;
        const cleaned = await deleteProject(cleanupId).catch((cleanupError: unknown) => {
          logError('templates.thumbnail_cleanup_failed', cleanupError, {
            templateId: row.id,
            projectId: cleanupId,
          });
          return { ok: false as const, error: 'threw' };
        });
        if (!cleaned.ok) {
          logError(
            'templates.thumbnail_cleanup_failed',
            new Error(cleaned.error || 'deleteProject refused'),
            { templateId: row.id, projectId: cleanupId },
          );
        }
      }
    }
  }

  return {
    ok: true as const,
    data: { results, remaining, message: thumbnailBatchMessage({ generated, remaining }) },
  };
}
