import { NextResponse } from 'next/server';
import { offeredModel } from '@/lib/ai/providers';
import type { ActionErr } from '@/lib/projects/actions';
import {
  GENERATION_STATUSES,
  generationPersistSchema,
  type GenerationPersistFields,
} from '@/lib/projects/schema';

export function actionError(result: ActionErr) {
  const details =
    result.details && typeof result.details === 'object'
      ? (result.details as Record<string, unknown>)
      : {};
  return NextResponse.json(
    {
      error: result.error,
      ...(result.status === 402 || result.status === 409
        ? details
        : result.details
          ? { details: result.details }
          : {}),
    },
    { status: result.status },
  );
}

export function readCreateInput(body: Record<string, unknown>) {
  const initialPrompt = String(body.initialPrompt ?? body.prompt ?? '').trim();
  const rawName = body.name ?? body.title;
  const name = typeof rawName === 'string' ? rawName : undefined;
  // Omit stack / designDirection when callers leave them off so zod can default.
  // Do not invent a stack here — invalid values must fail validation.
  return {
    name,
    initialPrompt,
    skipPlanning: body.skipPlanning === true,
    ...(typeof body.stack === 'string' && body.stack ? { stack: body.stack } : {}),
    ...(typeof body.designDirection === 'string' && body.designDirection
      ? { designDirection: body.designDirection }
      : {}),
    ...(typeof body.importMode === 'string' && body.importMode
      ? { importMode: body.importMode }
      : {}),
    ...(typeof body.templateId === 'string' && body.templateId
      ? { templateId: body.templateId }
      : {}),
  };
}

export type GenerationInputResult =
  { ok: true; data: GenerationPersistFields & { model?: string | null } } | ActionErr;

/**
 * Every field here used to be `body.X as string | null | undefined`, so a PATCH
 * carrying `{"lastCode": {"a": 1}}` reached `prisma.project.update` and came
 * back as a 500 rather than a 400 naming the field, with no bound on the size
 * of the site content it stored (F-743).
 *
 * Unknown keys are still ignored rather than rejected: the client sent
 * `sandboxId` for weeks after the column was dropped, and answering 400 to a
 * legacy client would break the persist the same way accepting it did.
 */
export function readGenerationInput(body: Record<string, unknown>): GenerationInputResult {
  const legacyStatus =
    typeof body.status === 'string' &&
    (GENERATION_STATUSES as readonly string[]).includes(body.status)
      ? body.status
      : undefined;

  const candidate: Record<string, unknown> = {};
  for (const field of ['style', 'previewUrl', 'lastCode', 'progressMessage'] as const) {
    if (body[field] !== undefined) candidate[field] = body[field];
  }
  for (const field of ['sourceMessage', 'source'] as const) {
    if (typeof body[field] === 'string') candidate[field] = body[field];
  }
  if (body.thumbnailUrl !== undefined) candidate.thumbnailUrl = body.thumbnailUrl;
  else if (body.screenshot !== undefined) candidate.thumbnailUrl = body.screenshot;
  if (body.generationStatus !== undefined) candidate.generationStatus = body.generationStatus;
  else if (legacyStatus !== undefined) candidate.generationStatus = legacyStatus;

  const parsed = generationPersistSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.') || 'body';
    return {
      ok: false,
      error: `${field}: ${issue?.message ?? 'Validation failed'}`,
      status: 400,
      details: parsed.error.issues,
    };
  }

  return {
    ok: true,
    data: {
      ...parsed.data,
      // A model the product no longer offers is not a preference, so it is not stored as
      // one: `null` clears the column instead of leaving a legacy id on the row to
      // outrank `ai.primaryModel` on every future build (F-004). `undefined` still means
      // "field absent — do not touch", which is what `hasGenerationFields` keys on.
      ...(body.model === undefined ? {} : { model: offeredModel(body.model) ?? null }),
      // No sandboxId. `Project` lost that column in 20260819010000_drop_sandbox_columns,
      // and accepting it here is what carried a dead field into prisma.project.update,
      // where it threw `Unknown argument` on every generation persist.
    },
  };
}

export function hasGenerationFields(input: GenerationPersistFields & { model?: string | null }) {
  return (
    input.style !== undefined ||
    input.model !== undefined ||
    input.previewUrl !== undefined ||
    input.thumbnailUrl !== undefined ||
    input.lastCode !== undefined ||
    input.generationStatus !== undefined ||
    input.progressMessage !== undefined
  );
}
