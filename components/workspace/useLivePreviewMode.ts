'use client';

import type { PreviewBuildStatus } from '@/lib/preview/types';

/**
 * Live mode was a sandbox VM kept warm by a 30-second heartbeat.
 * `20260819010000_drop_sandbox_columns` removed that subsystem, so
 * `POST /api/projects/[id]/preview` implements only `action: 'token'` — 'live',
 * 'heartbeat' and 'retry' all answer `400 Unknown action`. The preview is
 * compiled and run in this browser from the project's stored files
 * (`BrowserPreview`), so there is nothing left to boot or keep warm.
 *
 * Kept as one hook instead of deleted so the workspace's remaining live-mode
 * branches stay inert from a single place, the same way
 * `lib/workspace/sandbox-request.ts` holds the sandbox gate: flipping this flag
 * back on is then the only edit a future server-side live mode needs.
 *
 * There is deliberately no `startLive` any more. It survived for one revision as
 * a no-op that set a "Live mode is gone" banner, which left three buttons in
 * PreviewPanel offering an action the product cannot perform — the same lying
 * affordance this cleanup exists to remove, with the failure moved from a 400 to
 * a polite notice. Live mode is not temporarily unavailable, it died with the
 * sandbox subsystem, so the buttons are gone too (see PreviewPanel).
 */
const LIVE_MODE_SUPPORTED = false;

/**
 * A FAILED static build must never enter live mode. It used to: the workspace
 * ORs `staticPreview.status === 'FAILED'` into `lockedOn`, and the mount effect
 * then called `startLive()`. That POST answers 400, `enabled` was left `true`
 * anyway, and `lockedOn` also skipped the 20-minute stop timer — so a single
 * failed build meant a heartbeat POST against a 400 every 30 seconds for as long
 * as the tab stayed open, under a banner ("Live mode could not start") that
 * blamed the user for a feature that had been deleted.
 */
export function shouldEnterLiveMode(input: {
  lockedLive: boolean;
  staticStatus: PreviewBuildStatus | null;
  supported?: boolean;
}): boolean {
  if (input.staticStatus === 'FAILED') return false;
  if (!(input.supported ?? LIVE_MODE_SUPPORTED)) return false;
  return input.lockedLive;
}

export function useLivePreviewMode({
  lockedOn,
  staticStatus = null,
}: {
  lockedOn: boolean;
  staticStatus?: PreviewBuildStatus | null;
}) {
  return { enabled: shouldEnterLiveMode({ lockedLive: lockedOn, staticStatus }) };
}
