import { NextResponse } from 'next/server';
import type { ActionErr } from '@/lib/projects/actions';

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

export function readGenerationInput(body: Record<string, unknown>) {
  const generationStatus =
    typeof body.generationStatus === 'string'
      ? body.generationStatus
      : typeof body.status === 'string' &&
          ['idle', 'generating', 'applying', 'ready', 'error'].includes(body.status)
        ? body.status
        : undefined;

  const thumbnailUrl =
    body.thumbnailUrl !== undefined
      ? (body.thumbnailUrl as string | null)
      : body.screenshot !== undefined
        ? (body.screenshot as string | null)
        : undefined;

  return {
    style: body.style as string | null | undefined,
    model: body.model as string | null | undefined,
    // No sandboxId. `Project` lost that column in 20260819010000_drop_sandbox_columns,
    // and accepting it here is what carried a dead field into prisma.project.update,
    // where it threw `Unknown argument` on every generation persist.
    previewUrl: body.previewUrl as string | null | undefined,
    thumbnailUrl,
    lastCode: body.lastCode as string | null | undefined,
    generationStatus,
    progressMessage: body.progressMessage as string | null | undefined,
    sourceMessage: typeof body.sourceMessage === 'string' ? body.sourceMessage : undefined,
    source: typeof body.source === 'string' ? body.source : undefined,
  };
}

export function hasGenerationFields(input: ReturnType<typeof readGenerationInput>) {
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
