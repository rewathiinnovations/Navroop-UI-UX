import { asCreditActionErr } from '@/lib/plans/http';
import { checkLimit } from '@/lib/plans/limits';
import type { LimitCheckResult } from '@/lib/plans/types';
import type { createProject } from '@/lib/projects/actions';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { incrementUsageCount } from './usage';

export type CreateFromTemplateInput = {
  templateId: string;
  prompt: string;
  stack: string;
  designDirection: string;
  name?: string;
};

export type CreateFromTemplateDeps = {
  checkLimit: (
    workspaceId: string,
    kind: 'projects',
    upcoming: number,
  ) => Promise<LimitCheckResult>;
  createProject: typeof createProject;
  incrementUsageCount: (templateId: string) => Promise<number>;
};

/**
 * `createProject` lives in a `'use server'` module that pulls in the whole Auth.js
 * graph, so it is resolved on first use rather than at module load. A static import
 * would drag `next-auth` into every consumer of this file — including anything that
 * imports `@/lib/templates`, which re-exports it for a handful of pure helpers.
 */
async function defaultDeps(): Promise<CreateFromTemplateDeps> {
  const { createProject } = await import('@/lib/projects/actions');
  return { checkLimit, createProject, incrementUsageCount };
}

/**
 * Creates a normal project (plan mode stays on) and increments usageCount.
 * Project-count limit is checked before insert.
 */
export async function createProjectFromTemplate(
  input: CreateFromTemplateInput,
  injected?: CreateFromTemplateDeps,
) {
  const deps = injected ?? (await defaultDeps());
  const limit = await deps.checkLimit(WORKSPACE_ROW_ID, 'projects', 1);
  if (!limit.ok) return asCreditActionErr(limit);

  const created = await deps.createProject({
    name: input.name,
    initialPrompt: input.prompt,
    stack: input.stack,
    designDirection: input.designDirection,
    templateId: input.templateId,
  });
  if (!created || !created.ok) {
    return created ?? { ok: false as const, error: 'Sign in required', status: 401 };
  }

  return created;
}
