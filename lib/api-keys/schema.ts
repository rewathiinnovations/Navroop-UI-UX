import { z } from 'zod';
import { SETTINGS_API_KEY_PROVIDERS } from '@/lib/api-keys';

export const settingsProviderSchema = z.enum(
  SETTINGS_API_KEY_PROVIDERS.map((provider) => provider.id) as [
    (typeof SETTINGS_API_KEY_PROVIDERS)[number]['id'],
    ...(typeof SETTINGS_API_KEY_PROVIDERS)[number]['id'][],
  ],
);

export const setApiKeySchema = z.object({
  provider: settingsProviderSchema,
  secret: z.string().trim().min(8, 'Key looks too short'),
});

/**
 * Delete accepts any stored provider id, not just the ones currently offered:
 * legacy rows (`deepseek`, `openai`, `google`) still win credential resolution
 * and were undeletable while this was the offered-provider enum (F-072).
 * Deletion is always scoped to the caller (personal) or admin-gated (org).
 */
export const deleteApiKeySchema = z.object({
  provider: z.string().trim().min(1).max(64),
});

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
