import type { PreviewPaneKind } from './after-generation';

/**
 * What the workspace may offer on top of the preview it is actually showing.
 *
 * There are two previews and they were conflated. `BrowserPreview` compiles the
 * project in this tab and renders it into a `srcdoc` iframe sandboxed without
 * `allow-same-origin`; that frame is the only preview a user ever sees. The
 * `PreviewBuild` is the *served* copy of the same document — `buildStaticSite`
 * runs the same `assemblePreview` through the same `buildPreviewSrcdoc` — and it
 * exists for the SEO audit, the share link and password-protected preview
 * deploys. It is reachable only from a distinct preview origin (F-140), which
 * most installations never configure.
 *
 * Gating the Visual Edits toolbar on that served URL therefore hid the toolbar
 * in exactly the deployments where the in-browser frame is the only preview,
 * and in the others showed it over a frame that was never mounted (F-143).
 * `frameRendered` is the honest signal: the frame is on screen right now.
 */
export function previewToolsState(input: {
  view: string;
  pane: PreviewPaneKind;
  frameRendered: boolean;
  tool: string | null;
}): { showTools: boolean; inspectEnabled: boolean } {
  const showTools = input.view === 'preview' && input.frameRendered && input.pane !== 'planning';
  return { showTools, inspectEnabled: showTools && input.tool !== null };
}

/**
 * Whether a `message` event came from the preview frame.
 *
 * The frame's origin is the opaque string `"null"` — it is sandboxed without
 * `allow-same-origin` on purpose, so the generated app cannot reach this app's
 * origin, storage or session. Comparing `event.origin` against an origin parsed
 * out of the served preview URL therefore dropped every message the inspector
 * sent, which is the second half of F-143. Window identity is the stronger
 * check in any case: only that exact frame can be the `source` of its own
 * messages, whatever its origin claims to be.
 */
export function isMessageFromPreviewFrame(
  event: { source: unknown },
  frame: { contentWindow: unknown } | null | undefined,
): boolean {
  if (!frame?.contentWindow) return false;
  return event.source === frame.contentWindow;
}
