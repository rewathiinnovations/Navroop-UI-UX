import { z } from 'zod';

export const updateProfileSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name must be at least 1 character')
    .max(100, 'Name must be at most 100 characters')
    .optional(),
  avatarUrl: z
    .union([
      z.string().trim().url('Enter a valid URL'),
      z.string().trim().regex(/^\/uploads\//, 'Enter a valid URL'),
      z.string().startsWith('data:'),
      z.literal(''),
      z.null(),
    ])
    .optional()
    .transform((value) => (value ? value : null)),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
});

export type UpdateProfileInput = z.input<typeof updateProfileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

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
