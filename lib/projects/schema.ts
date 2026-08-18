import { z } from 'zod';
import { DEFAULT_DESIGN_DIRECTION, DESIGN_DIRECTION_IDS } from '@/lib/design/directions';
import { DEFAULT_IMPORT_MODE, IMPORT_MODES } from '@/lib/import/mode';
import { DEFAULT_STACK, STACK_IDS } from '@/lib/stacks';

export const PROJECT_STATUSES = ['draft', 'published'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const projectStatusSchema = z.enum(PROJECT_STATUSES);

const optionalName = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).max(100).optional(),
);

/**
 * `stack` is part of the create contract (one of 6). Zod defaults to NEXTJS.
 * Invalid values are rejected — never coerced to React.
 */
export const createProjectSchema = z.object({
  name: optionalName,
  initialPrompt: z.string().trim().min(1, 'initialPrompt is required'),
  skipPlanning: z.boolean().optional().default(false),
  stack: z.enum(STACK_IDS).default(DEFAULT_STACK),
  designDirection: z.enum(DESIGN_DIRECTION_IDS).default(DEFAULT_DESIGN_DIRECTION),
  importMode: z.enum(IMPORT_MODES).default(DEFAULT_IMPORT_MODE),
  templateId: z.string().trim().min(1).optional(),
});

export const refinePlanSchema = z.object({
  feedback: z.string().trim().min(1, 'feedback is required').max(2000),
});

export const followUpPlanSchema = z.object({
  message: z.string().trim().min(1, 'message is required').max(2000),
});

export const updateProjectSchema = z
  .object({
    name: optionalName,
    status: projectStatusSchema.optional(),
  })
  .refine((value) => value.name !== undefined || value.status !== undefined, {
    message: 'Provide name and/or status',
  });

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export function isProductStatus(value: unknown): value is ProjectStatus {
  return typeof value === 'string' && PROJECT_STATUSES.includes(value as ProjectStatus);
}

export function nameFromPrompt(prompt: string) {
  const cleaned = prompt.replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'Untitled project';
  return cleaned.length > 40 ? cleaned.slice(0, 40) : cleaned;
}

export function parseWithZod<T>(schema: z.ZodType<T>, data: unknown) {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false as const,
      error: 'Validation failed',
      status: 400 as const,
      details: parsed.error.issues,
    };
  }
  return { ok: true as const, data: parsed.data };
}
