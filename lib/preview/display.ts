import { PREVIEW_MESSAGE_SOURCE } from './html';

/**
 * Whether a `message` event came from the preview frame.
 *
 * The frame's origin is the opaque string `"null"` — it is sandboxed without
 * `allow-same-origin` on purpose, so the generated app cannot reach this app's
 * origin, storage or session. Comparing `event.origin` against an origin parsed
 * out of the served preview URL therefore dropped every message the frame
 * sent (F-143). Window identity is the stronger check in any case: only that
 * exact frame can be the `source` of its own messages, whatever its origin
 * claims to be.
 */
export function isMessageFromPreviewFrame(
  event: { source: unknown },
  frame: { contentWindow: unknown } | null | undefined,
): boolean {
  if (!frame?.contentWindow) return false;
  return event.source === frame.contentWindow;
}

type PreviewFrameWindow = {
  postMessage: (message: unknown, targetOrigin: string) => void;
};

/**
 * Ask the in-browser preview to show `path`.
 *
 * The frame is a `srcdoc` sandboxed without `allow-same-origin` (F-140), so
 * the parent cannot set `iframe.src` or read `contentDocument`. `postMessage`
 * with `targetOrigin: '*'` is the only channel — the opaque origin cannot be
 * named. Returns false when the frame is not mounted yet; callers must not
 * treat that as a thrown error.
 *
 * Post at `previewFrameRef` (BrowserPreview). The sandbox-era iframe in
 * GenerationWorkspace is never mounted.
 */
export function postNavigateToPreviewFrame(
  frame: { contentWindow: PreviewFrameWindow | null } | null | undefined,
  path: string,
): boolean {
  const win = frame?.contentWindow;
  if (!win) return false;
  win.postMessage({ source: PREVIEW_MESSAGE_SOURCE, type: 'navigate', path }, '*');
  return true;
}
