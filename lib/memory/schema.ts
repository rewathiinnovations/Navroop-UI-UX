import { z } from 'zod';
import { MEMORY_CATEGORIES, MEMORY_SCOPES } from './types';

export const memoryContentSchema = z
  .string()
  .trim()
  .min(1, 'Content must be at least 1 character')
  .max(500, 'Content must be at most 500 characters');

export const memoryCategorySchema = z.enum(MEMORY_CATEGORIES);
export const memoryScopeSchema = z.enum(MEMORY_SCOPES);

export const createMemoryInputSchema = z
  .object({
    scope: memoryScopeSchema,
    projectId: z.string().trim().min(1).optional().nullable(),
    category: memoryCategorySchema,
    content: memoryContentSchema,
  })
  .superRefine((value, ctx) => {
    if (value.scope === 'PROJECT' && !value.projectId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'projectId is required for PROJECT memory',
        path: ['projectId'],
      });
    }
    if (value.scope === 'WORKSPACE' && value.projectId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'projectId must be empty for WORKSPACE memory',
        path: ['projectId'],
      });
    }
  });

export const updateMemoryInputSchema = z.object({
  id: z.string().trim().min(1),
  content: memoryContentSchema,
});

export const memoryIdSchema = z.object({
  id: z.string().trim().min(1),
});

export const listMemoriesInputSchema = z.object({
  scope: memoryScopeSchema,
  projectId: z.string().trim().min(1).optional().nullable(),
});

export type CreateMemoryInput = z.infer<typeof createMemoryInputSchema>;
export type UpdateMemoryInput = z.infer<typeof updateMemoryInputSchema>;

export function parseWithZod<T>(schema: z.ZodType<T>, data: unknown) {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false as const,
      error: parsed.error.issues[0]?.message ?? 'Validation failed',
      status: 400 as const,
      details: parsed.error.issues,
    };
  }
  return { ok: true as const, data: parsed.data };
}
