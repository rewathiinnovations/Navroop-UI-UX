import { z } from 'zod';

export const skillInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(4000),
});

export const createSkillSchema = skillInputSchema;
export const updateSkillSchema = skillInputSchema.partial().extend({
  id: z.string().min(1),
});
export const skillIdSchema = z.object({
  id: z.string().min(1),
});

export type SkillInput = z.infer<typeof skillInputSchema>;

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
