import { INSPECTOR_SCRIPT, INSPECTOR_SCRIPT_ID } from '@/lib/visual-edits/inspector';
import {
  buildImportMap,
  PREVIEW_DEPS,
  TAILWIND_BROWSER_URL,
  TAILWIND_PREVIEW_CONFIG,
} from './deps';

/**
 * Builds the document the preview iframe renders.
 *
 * The iframe is sandboxed without allow-same-origin, so this document is the
 * whole world the generated app sees: import map, Tailwind, the bundle, an
 * error bridge that posts failures back to the parent (a sandboxed frame
 * cannot be inspected from outside, so uncaught errors would otherwise vanish),
 * and the Visual Edits inspector, for the same reason — the frame's origin is
 * opaque, so nothing outside can put a script into it after the fact. The
 * inspector idles until the workspace posts it a `navroop:inspector-active`
 * message (F-143).
 */

export const PREVIEW_MESSAGE_SOURCE = 'navroop-preview';

export type PreviewMessage =
  | { source: typeof PREVIEW_MESSAGE_SOURCE; type: 'ready' }
  | { source: typeof PREVIEW_MESSAGE_SOURCE; type: 'error'; message: string; stack?: string };

/**
 * Node globals the generated code assumes exist.
 *
 * `lib/preview/bundle.ts` already substitutes `process.env.NODE_ENV` at build
 * time, but that only covers that one exact expression. Real generated Next.js
 * code reaches `process` in ways `define` cannot see — another `process.env.X`,
 * a `typeof process !== 'undefined'` guard, a destructure of `process.env` — and
 * the first one crashed the whole preview with `Uncaught ReferenceError: process
 * is not defined`, which the pane reported as "Preview couldn't run" over an
 * otherwise perfectly good 19-file site. A missing env var should read as
 * `undefined` inside the frame, exactly as it would in a browser build; it must
 * never take the page down.
 *
 * Deliberately minimal and non-authoritative: no secrets are exposed here (the
 * frame is sandboxed without allow-same-origin and this object is empty apart
 * from NODE_ENV), and it does not overwrite a `process` the bundle itself
 * provided.
 */
const NODE_GLOBALS_SHIM = `
(function () {
  var existing = window.process;
  var env = (existing && existing.env) || {};
  if (!env.NODE_ENV) env.NODE_ENV = "production";
  window.process = Object.assign({}, existing, { env: env });
  if (!window.global) window.global = window;
})();
`;

const ERROR_BRIDGE = `
(function () {
  var POST = function (payload) {
    try {
      parent.postMessage(Object.assign({ source: "${PREVIEW_MESSAGE_SOURCE}" }, payload), "*");
    } catch (_) {}
  };
  window.__previewPost = POST;
  window.addEventListener("error", function (event) {
    POST({
      type: "error",
      message: (event && event.message) || "Script error",
      stack: event && event.error && event.error.stack ? String(event.error.stack) : undefined,
    });
  });
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event && event.reason;
    POST({
      type: "error",
      message: reason && reason.message ? String(reason.message) : "Unhandled promise rejection",
      stack: reason && reason.stack ? String(reason.stack) : undefined,
    });
  });
})();
`;

/**
 * A sandboxed srcdoc has no base URL, so `document.baseURI` resolves to the
 * parent document's URL (the app origin). A plain `<a href="#reserve">` therefore
 * navigates the frame out to `http://<app>/project/<id>#reserve` — past the app
 * auth gate and off the preview — instead of scrolling to the in-frame section.
 * The Next router's click handler only intercepts `/`-prefixed links, so hash
 * anchors fall through to that escape. This document-level handler catches them
 * for every stack and scrolls inside the frame.
 */
const HASH_LINK_INTERCEPTOR = `
(function () {
  document.addEventListener("click", function (event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var anchor = event.target && event.target.closest ? event.target.closest("a") : null;
    if (!anchor) return;
    var href = anchor.getAttribute("href");
    if (href == null || href[0] !== "#") return;
    // Always swallow the click: a hash link must never leave the preview document.
    event.preventDefault();
      var id = href.slice(1);
    if (id) {
      try { id = decodeURIComponent(id); } catch {}
      var target = document.getElementById(id);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
})();
`;

/**
 * The Play CDN's theme, assigned only if the CDN actually arrived.
 *
 * `cdn.tailwindcss.com` is a third-party origin the frame is allowed to lose —
 * an offline dev machine, a corporate proxy, a CSP on the preview host — and a
 * bare `tailwind.config = …` in the very next script then dies with
 * `ReferenceError: tailwind is not defined`. That turned "the preview is
 * unstyled", which is what a blocked CDN used to cost, into "the preview reports
 * an error", which is a strictly worse answer to the same missing script. Worse
 * still while the assignment sat ahead of ERROR_BRIDGE: the throw reached no
 * listener, and the iframe is sandboxed without allow-same-origin, so nothing
 * outside could see it either — the frame just went quiet. The bridge is
 * installed before this now, and this cannot throw in the first place.
 */
const TAILWIND_CONFIG_SCRIPT = `if (typeof tailwind !== "undefined") tailwind.config = ${TAILWIND_PREVIEW_CONFIG};`;

/**
 * The inspector, ready to be turned on. It installs a `message` listener and
 * nothing else until the workspace activates it, so an unused Visual Edits
 * toolbar costs the frame one idle listener.
 */
const INSPECTOR_TAG = `<script id="${INSPECTOR_SCRIPT_ID}">${escapeClosingScript(INSPECTOR_SCRIPT)}</script>`;

export function buildPreviewSrcdoc(options: {
  code: string;
  css?: string;
  deps?: Record<string, string>;
  /** Rendered verbatim instead of the bundle — used by the STATIC_HTML stack. */
  rawHtml?: string;
}): string {
  if (options.rawHtml !== undefined) {
    return injectBridgeIntoHtml(options.rawHtml);
  }

  const deps = options.deps ?? PREVIEW_DEPS;
  const importMap = buildImportMap(deps);
  const code = escapeClosingScript(`${options.code}
setTimeout(function () {
  if (window.__previewPost) window.__previewPost({ type: "ready" });
}, 0);
`);
  const css = escapeClosingStyle(options.css ?? '');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<script type="importmap">${JSON.stringify(importMap)}</script>
<!-- Shim, bridge and interceptor first: nothing that can throw may run ahead of
     the bridge, or the frame has no way to report it. -->
<script>${NODE_GLOBALS_SHIM}</script>
<script>${ERROR_BRIDGE}</script>
<script>${HASH_LINK_INTERCEPTOR}</script>
<script src="${TAILWIND_BROWSER_URL}"></script>
<!-- The Play CDN's documented configuration API: a second script that assigns
     tailwind.config. This is what makes bg-background / text-foreground resolve
     to the project's CSS variables instead of compiling to nothing. -->
<script>${TAILWIND_CONFIG_SCRIPT}</script>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script type="module" id="__preview-app">${code}</script>
<script>
// A module script that fails to fetch or instantiate fires "error" on the
// element only — never on window — so without this listener the preview would
// hang blank with nothing reported. Error events dispatch in a later task, so
// this parser-synchronous listener cannot attach too late.
document.getElementById("__preview-app").addEventListener("error", function () {
  if (window.__previewPost) {
    window.__previewPost({
      type: "error",
      message: "The preview could not load one of its packages. Check the imports in your code.",
    });
  }
});
</script>
${INSPECTOR_TAG}
</body>
</html>`;
}

/**
 * Puts the error bridge and the ready signal into raw model HTML.
 *
 * Both scripts are mandatory: BrowserPreview arms a 15 second watchdog while
 * the frame is running and only disarms it on the ready postMessage. The ready
 * script used to be injected with `.replace(/<\/body>/i, …)`, and String.replace
 * returns the input unchanged when it matches nothing — so markup with a <head>
 * but no </body> got the bridge, no ready, and a page that had rendered
 * perfectly was buried 15 seconds later under "The preview did not finish
 * loading. A package import may be unavailable" (advice that is doubly wrong
 * here: this path has no bundle and no imports). Every branch below therefore
 * places both scripts explicitly, and an unrecognised shape appends them
 * rather than dropping them — a no-match must never look like a success.
 */
function injectBridgeIntoHtml(html: string) {
  // Shim first, then the bridge: a static page can carry a script that touches
  // `process` just as a bundled one can, and the shim is worthless if it lands
  // after the code that needed it. The hash interceptor is the third script: it
  // keeps `#section` links inside the frame, exactly as in the bundled preview.
  const bridge = `<script>${NODE_GLOBALS_SHIM}</script><script>${ERROR_BRIDGE}</script><script>${HASH_LINK_INTERCEPTOR}</script>`;
  // The inspector rides with the ready signal, on the same "must be placed
  // explicitly, never dropped by a no-match" rule: Visual Edits has to work on a
  // static-HTML project too, and its only way in is this document.
  const ready = `<script>setTimeout(function(){ if (window.__previewPost) window.__previewPost({ type: "ready" }); }, 0);</script>${INSPECTOR_TAG}`;

  const headOpen = /<head[^>]*>/i.exec(html);
  let withBridge: string;
  if (headOpen) {
    const afterHead = headOpen.index + headOpen[0].length;
    withBridge = `${html.slice(0, afterHead)}${bridge}${html.slice(afterHead)}`;
  } else {
    withBridge = `${bridge}${html}`;
  }

  const bodyClose = /<\/body>/i.exec(withBridge);
  if (!bodyClose) return `${withBridge}${ready}`;
  return `${withBridge.slice(0, bodyClose.index)}${ready}${withBridge.slice(bodyClose.index)}`;
}

function escapeClosingScript(code: string) {
  return code.replace(/<\/script/gi, '<\\/script');
}

function escapeClosingStyle(css: string) {
  return css.replace(/<\/style/gi, '<\\/style');
}
