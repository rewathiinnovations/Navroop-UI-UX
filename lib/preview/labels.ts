export const PREPARING_PREVIEW = 'Preparing preview…';
export const PREVIEW_BUILD_FAILED = 'Preview could not be built';
export const PREVIEW_NOT_READY_NOTICE =
  'The site is built, but its published preview snapshot is not ready yet.';
/**
 * Shown when `GET/POST /api/projects/[id]/preview` answers 403. Minting a
 * preview token is owner/ADMIN only because the signed URL it returns is
 * spendable anonymously on `/preview-static`, so a workspace member who can
 * read the project still cannot open its preview.
 */
export const PREVIEW_ACCESS_DENIED = 'Only the project owner can open its preview.';
export const PREVIEW_EMPTY = 'Nothing to preview yet — describe what you want built in the chat.';
export const STATIC_PREVIEW_LABEL = 'Preview';
export const LIVE_SANDBOX_LABEL = 'Live sandbox';
/**
 * Live mode died with the sandbox subsystem (migration
 * 20260819010000_drop_sandbox_columns), and the rest of the LIVE_MODE_* copy
 * went with it. This line survives because `getPreviewStatus` still reports
 * `liveReason` for a project whose static export failed (./status.ts).
 */
export const LIVE_MODE_LOCKED_REASON =
  'This project needs a live sandbox because the static export failed.';
export const PREVIEW_TOO_LARGE =
  'Preview is too large to store. It must be under 200 MB and 5,000 files.';
export const PREVIEW_NOT_FOUND_TITLE = 'Page not found';
export const PREVIEW_STATIC_HOST_PREFIX = 'preview-static';
