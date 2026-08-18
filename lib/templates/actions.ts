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
import { canManageTemplates, memberCannotAdmin } from './auth';
import { createProjectFromTemplate } from './create';
import { createFromTemplateSchema, parseWithZod, saveTemplateSchema, adminTemplateSchema } from './schema';
import { buildTemplatePromptFromProject } from './summary';
import {
  deleteTemplateRow,
  findTemplateById,
  insertTemplate,
  listTemplateRows,
  uniqueSlug,
  updateTemplateRow,
} from './store';
import { toPublic } from './public';
import { captureThumbnailFromUrl, storeThumbnailBuffer } from './thumbnails';
import type { TemplateSort } from './types';
import { isVisibleToWorkspace } from './visibility';
import { writeAudit } from '@/lib/audit/log';

type ActionErr = { ok: false; error: string; status: number; details?: unknown };
type ActionOk<T> = { ok: true; data: T };

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
  return { ok: true as const, data: { templates: visible.map(toPublic) } };
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
  return { ok: true as const, data: { template: toPublic(row) } };
}

export async function createFromTemplate(id: string, input: { prompt?: string; name?: string }) {
  const { user, err } = await requireUser();
  if (!user) return err;

  const parsed = parseWithZod(createFromTemplateSchema, input);
  if (!parsed.ok) return parsed;

  const row = await findTemplateById(id);
  if (!row || !isVisibleToWorkspace(row, WORKSPACE_ROW_ID)) return notFound();

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
      plans: {
        orderBy: { version: 'desc' },
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
      return { ok: true as const, data: { template: toPublic(updated ?? created) } };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not capture thumbnail';
      return {
        ok: true as const,
        data: {
          template: toPublic(created),
          thumbnailWarning: message,
        },
      };
    }
  }

  return { ok: true as const, data: { template: toPublic(created) } };
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
  return { ok: true as const, data: { templates: rows.map(toPublic) } };
}

export async function adminCreateTemplate(input: unknown) {
  const { user, error, status } = await requireAdmin();
  if (!user) return { ok: false as const, error, status };
  const parsed = parseWithZod(adminTemplateSchema, input);
  if (!parsed.ok) return parsed;
  const data = parsed.data;
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
  return { ok: true as const, data: { template: toPublic(created) } };
}

export async function adminUpdateTemplate(id: string, input: unknown) {
  const { user, error, status } = await requireAdmin();
  if (!user) return { ok: false as const, error, status };
  const parsed = parseWithZod(adminTemplateSchema.partial(), input);
  if (!parsed.ok) return parsed;
  const existing = await findTemplateById(id);
  if (!existing) return notFound();
  const data = parsed.data;
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
  return { ok: true as const, data: { template: toPublic(updated ?? existing) } };
}

export async function adminDeleteTemplate(id: string) {
  const { user, error, status } = await requireAdmin();
  if (!user) return { ok: false as const, error, status };
  const existing = await findTemplateById(id);
  if (!existing) return notFound();
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
  return createFromTemplate(id, {});
}

export async function adminUploadThumbnail(id: string, buffer: Buffer) {
  const { user, error, status } = await requireAdmin();
  if (!user) return { ok: false as const, error, status };
  const existing = await findTemplateById(id);
  if (!existing) return notFound();
  const key = await storeThumbnailBuffer(id, buffer);
  const updated = await updateTemplateRow(id, { thumbnailKey: key });
  return { ok: true as const, data: { template: toPublic(updated ?? existing) } };
}

export async function adminGenerateThumbnails() {
  const { user, error, status } = await requireAdmin();
  if (!user) return { ok: false as const, error, status };

  const limit = await checkLimit(WORKSPACE_ROW_ID, 'projects', 1);
  if (!limit.ok) return asCreditActionErr(limit);

  const rows = await listTemplateRows({
    workspaceId: WORKSPACE_ROW_ID,
    includeInactive: true,
    sort: 'newest',
  });
  const targets = rows.filter((row) => row.isBuiltIn && !row.thumbnailKey);
  const results: Array<{ id: string; slug: string; ok: boolean; error?: string }> = [];

  for (const row of targets) {
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

      const previewUrl = created.data.project.previewUrl;
      if (!previewUrl) {
        await deleteProject(created.data.id);
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
        const { publishProjectAndWait } = await import('@/lib/publish/publish');
        const published = await publishProjectAndWait({
          projectId: created.data.id,
          kind: 'PREVIEW',
          userId: user.id,
        });
        const captureUrl = published.url || previewUrl;
        const { withRecordedJob } = await import('@/lib/jobs/wrap');
        const key = await withRecordedJob(
          {
            projectId: created.data.id,
            userId: user.id,
            kind: 'TEMPLATE_THUMBNAIL',
            inputPrompt: row.slug,
          },
          async () => captureThumbnailFromUrl(captureUrl, row.id, user.id),
        );
        await updateTemplateRow(row.id, { thumbnailKey: key, previewUrl: captureUrl });
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

      await deleteProject(created.data.id);
    } catch (error) {
      results.push({
        id: row.id,
        slug: row.slug,
        ok: false,
        error: error instanceof Error ? error.message : 'Could not generate thumbnail',
      });
    }
  }

  if (targets.length === 0) {
    return {
      ok: true as const,
      data: {
        results,
        message: 'Every built-in template already has a thumbnail.',
      },
    };
  }

  return { ok: true as const, data: { results } };
}
