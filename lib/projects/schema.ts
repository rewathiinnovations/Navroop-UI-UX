import { z } from 'zod';
import { DEFAULT_DESIGN_DIRECTION, DESIGN_DIRECTION_IDS } from '@/lib/design/directions';
import { DEFAULT_IMPORT_MODE, IMPORT_MODES } from '@/lib/import/mode';
import { httpUrl } from '@/lib/schema/url';
import { DEFAULT_STACK, STACK_IDS } from '@/lib/stacks';

export const PROJECT_STATUSES = ['draft', 'published'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const projectStatusSchema = z.enum(PROJECT_STATUSES);

const optionalName = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).max(100).optional(),
);

/**
 * `stack` is part of the create contract (one of `STACK_IDS`, currently three).
 * Invalid values are rejected — never coerced to React.
 */
export const createProjectSchema = z.object({
  name: optionalName,
  initialPrompt: z.string().trim().min(1, 'initialPrompt is required'),
  skipPlanning: z.boolean().optional().default(false),
  /** Create the row and return at once; the initial plan generates detached.
   *  The dashboard uses this so submit lands in the workspace instantly. */
  deferPlanning: z.boolean().optional().default(false),
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

export const GENERATION_STATUSES = ['idle', 'generating', 'applying', 'ready', 'error'] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

/**
 * `Project.lastCode` is `@db.Text`, so Postgres imposes no ceiling: before this
 * schema a single PATCH could store an arbitrarily large blob as the project's
 * site content. 4 MB is an order of magnitude above the largest generated site
 * observed (a full multi-page Next.js app serialises to a few hundred KB), so
 * it bounds the write without truncating real work.
 */
export const LAST_CODE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The generation persist contract for `PATCH /api/projects/[id]` and the create
 * route's follow-up write. Every field used to be `body.X as string | null`
 * (F-743), so `{"lastCode": {"a": 1}}` reached `prisma.project.update` and came
 * back as a 500 rather than a 400 naming the field.
 *
 * `thumbnailUrl` also accepts a `data:image/*` URI: the workspace sends the
 * screenshot it took of an imported site here (`screenshot` in
 * `lib/projects/http.ts`), and that is a data URL when nothing stored it. No
 * server-side capture produces one — the checkpoint thumbnail that used to was
 * unreachable and is gone (F-151).
 */
export const generationPersistSchema = z
  .object({
    style: z.string().max(200).nullable(),
    previewUrl: httpUrl(2048).nullable(),
    thumbnailUrl: z
      .union([
        httpUrl(2048),
        z
          .string()
          .trim()
          .regex(/^\/uploads\/[\w./-]+$/, 'Enter a valid URL')
          .max(2048),
        z
          .string()
          .regex(/^data:image\/(png|jpeg|webp|avif);base64,[A-Za-z0-9+/=]+$/)
          .max(3_000_000),
      ])
      .nullable(),
    lastCode: z.string().max(LAST_CODE_MAX_BYTES).nullable(),
    generationStatus: z.enum(GENERATION_STATUSES),
    progressMessage: z.string().max(2000).nullable(),
    sourceMessage: z.string().max(12000),
    source: z.string().max(200),
  })
  .partial();

export type GenerationPersistFields = z.infer<typeof generationPersistSchema>;

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
