import { z } from 'zod';
import { httpUrl } from '@/lib/schema/url';

export const updateProfileSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name must be at least 1 character')
    .max(100, 'Name must be at most 100 characters')
    .optional(),
  // No `data:` branch. It accepted an unbounded, MIME-unchecked URI that
  // `listRecentPresence` then re-sent to every workspace member on every
  // 30-second poll (F-742); `uploadAvatar` stores a real file and returns a
  // URL, so nothing in the product ever needed one.
  avatarUrl: z
    .union([
      httpUrl(2048),
      z
        .string()
        .trim()
        .regex(/^\/uploads\/[\w./-]+$/, 'Enter a valid URL')
        .max(2048),
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
