import { LIVE_MODE_START_FAILED, PREVIEW_NOT_READY_NOTICE } from './labels';

export type PreviewAfterGenerationResult =
  { ok: true } | { ok: false; skipped?: boolean; error?: string; reason?: string };

export type PreviewCaptureScope = {
  projectId: string;
  checkpointId: string;
  checkpointCreatedAt: Date;
  findExisting?: () => Promise<{ status: string } | null | undefined>;
};

type CaptureOutcome = { notice: string | null; error?: unknown };

const inflight = new Map<string, Promise<CaptureOutcome>>();
const lastCapturedAt = new Map<string, number>();

export function previewCaptureKey(projectId: string, checkpointId: string) {
  return `${projectId}:${checkpointId}`;
}

export function resetPreviewCaptureInflight() {
  inflight.clear();
  lastCapturedAt.clear();
}

const STALE_BUILDING_MS = 5 * 60 * 1000;

export function shouldSkipPreviewCapture(
  existing: { status: string; createdAt?: Date } | null | undefined,
  now = Date.now(),
): boolean {
  if (existing?.status === 'READY') return true;
  if (existing?.status !== 'BUILDING') return false;
  if (!existing.createdAt) return true;
  return now - existing.createdAt.getTime() < STALE_BUILDING_MS;
}

export function shouldAdoptPreviewBuild(input: {
  incomingId: string;
  incomingCreatedAt: Date;
  currentId: string | null;
  currentCreatedAt: Date | null;
}): boolean {
  if (!input.currentId || !input.currentCreatedAt) return true;
  if (input.incomingId === input.currentId) return true;
  return input.incomingCreatedAt >= input.currentCreatedAt;
}

export function noticeForPreviewAfterGeneration(
  result: PreviewAfterGenerationResult | null | undefined,
): string | null {
  if (result?.ok) return null;
  return PREVIEW_NOT_READY_NOTICE;
}

function alreadyCapturedThisOrNewer(scope: PreviewCaptureScope) {
  const previous = lastCapturedAt.get(scope.projectId);
  return previous !== undefined && scope.checkpointCreatedAt.getTime() <= previous;
}

async function runCaptureWork(
  work: () => Promise<PreviewAfterGenerationResult>,
): Promise<CaptureOutcome> {
  try {
    const result = await work();
    return { notice: noticeForPreviewAfterGeneration(result) };
  } catch (error) {
    return { notice: noticeForPreviewAfterGeneration({ ok: false }), error };
  }
}

/**
 * One sandbox preview build per generation. Same checkpoint (or an older one)
 * joins the in-flight work or skips. A newer checkpoint still captures.
 */
export async function capturePreviewAfterGeneration(
  work: () => Promise<PreviewAfterGenerationResult>,
  scope?: PreviewCaptureScope,
): Promise<CaptureOutcome> {
  if (!scope) {
    return runCaptureWork(work);
  }

  const key = previewCaptureKey(scope.projectId, scope.checkpointId);
  const running = inflight.get(key);
  if (running) return running;

  if (alreadyCapturedThisOrNewer(scope)) {
    return { notice: null };
  }

  const existing = scope.findExisting ? await scope.findExisting() : null;
  if (shouldSkipPreviewCapture(existing)) {
    if (existing?.status === 'READY') {
      lastCapturedAt.set(scope.projectId, scope.checkpointCreatedAt.getTime());
    }
    return { notice: null };
  }

  const pending = runCaptureWork(work).then((outcome) => {
    if (!outcome.error && outcome.notice === null) {
      lastCapturedAt.set(scope.projectId, scope.checkpointCreatedAt.getTime());
    }
    return outcome;
  });
  inflight.set(key, pending);
  try {
    return await pending;
  } finally {
    inflight.delete(key);
  }
}

export function noticeForLiveModeStart(ok: boolean): string | null {
  return ok ? null : LIVE_MODE_START_FAILED;
}

export type PreviewPaneKind = 'planning' | 'preparing' | 'ready' | 'preview-failed' | 'empty';

/**
 * Which pane the preview area shows.
 *
 * `hasFiles` is what decides "ready" now. This used to key off a sandbox
 * preview URL, so with the VMs gone every finished project fell through to the
 * empty state and the panel claimed there was nothing to show while the site
 * sat in the database.
 */
export function previewPaneKind(input: {
  phase?: string | null;
  planTrigger?: string | null;
  hasFiles?: boolean;
  previewUrl?: string | null;
  preparing?: boolean;
  previewBuildFailed?: boolean;
}): PreviewPaneKind {
  const planning = input.phase === 'PLANNING' && input.planTrigger !== 'followup';
  if (planning) return 'planning';
  if (input.previewBuildFailed) return 'preview-failed';
  if (input.preparing) return 'preparing';
  if (input.hasFiles || input.previewUrl) return 'ready';
  return 'empty';
}
