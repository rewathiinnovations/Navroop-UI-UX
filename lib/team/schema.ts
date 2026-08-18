import { z } from 'zod';

export const roleSchema = z.enum(['ADMIN', 'MEMBER']);

export const updateMemberRoleSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  role: roleSchema,
});

export const memberIdSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
});

export type TeamRole = z.infer<typeof roleSchema>;

/**
 * Self-management refusals, shared by the server actions and the table UI.
 * Kept here because `actions.ts` is a 'use server' module and may only export
 * async functions.
 */
export const SELF_ROLE_ERROR = "You can't change your own role. Ask another admin.";
export const SELF_DEACTIVATE_ERROR = "You can't deactivate your own account. Ask another admin.";

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
