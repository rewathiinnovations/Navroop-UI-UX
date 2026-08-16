import { NextResponse } from 'next/server';
import type { ActionErr } from '@/lib/projects/actions';

export function actionError(result: ActionErr) {
  return NextResponse.json(
    { error: result.error, ...(result.details ? { details: result.details } : {}) },
    { status: result.status },
  );
}

export function readCreateInput(body: Record<string, unknown>) {
  const initialPrompt = String(body.initialPrompt ?? body.prompt ?? '').trim();
  const rawName = body.name ?? body.title;
  const name = typeof rawName === 'string' ? rawName : undefined;
  // Omit stack when callers leave it off so zod can default to REACT.
  // Do not invent a stack here — invalid values must fail validation.
  return {
    name,
    initialPrompt,
    skipPlanning: body.skipPlanning === true,
    ...(typeof body.stack === 'string' && body.stack ? { stack: body.stack } : {}),
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
    sandboxId: body.sandboxId as string | null | undefined,
    previewUrl: body.previewUrl as string | null | undefined,
    thumbnailUrl,
    lastCode: body.lastCode as string | null | undefined,
    generationStatus,
    progressMessage: body.progressMessage as string | null | undefined,
    sourceMessage: typeof body.sourceMessage === 'string' ? body.sourceMessage : undefined,
  };
}

export function hasGenerationFields(input: ReturnType<typeof readGenerationInput>) {
  return (
    input.style !== undefined ||
    input.model !== undefined ||
    input.sandboxId !== undefined ||
    input.previewUrl !== undefined ||
    input.thumbnailUrl !== undefined ||
    input.lastCode !== undefined ||
    input.generationStatus !== undefined ||
    input.progressMessage !== undefined
  );
}
