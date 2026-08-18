import { buildImportMap, PREVIEW_DEPS, TAILWIND_BROWSER_URL } from './deps';

/**
 * Builds the document the preview iframe renders.
 *
 * The iframe is sandboxed without allow-same-origin, so this document is the
 * whole world the generated app sees: import map, Tailwind, the bundle, and an
 * error bridge that posts failures back to the parent (a sandboxed frame
 * cannot be inspected from outside, so uncaught errors would otherwise vanish).
 */

export const PREVIEW_MESSAGE_SOURCE = 'navroop-preview';

export type PreviewMessage =
  | { source: typeof PREVIEW_MESSAGE_SOURCE; type: 'ready' }
  | { source: typeof PREVIEW_MESSAGE_SOURCE; type: 'error'; message: string; stack?: string };

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
<script src="${TAILWIND_BROWSER_URL}"></script>
<style>${css}</style>
<script>${ERROR_BRIDGE}</script>
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
</body>
</html>`;
}

function injectBridgeIntoHtml(html: string) {
  const bridge = `<script>${ERROR_BRIDGE}</script>`;
  const ready = `<script>setTimeout(function(){ if (window.__previewPost) window.__previewPost({ type: "ready" }); }, 0);</script>`;
  if (/<head[^>]*>/i.test(html)) {
    return html
      .replace(/<head([^>]*)>/i, `<head$1>${bridge}`)
      .replace(/<\/body>/i, `${ready}</body>`);
  }
  return `${bridge}${html}${ready}`;
}

function escapeClosingScript(code: string) {
  return code.replace(/<\/script/gi, '<\\/script');
}

function escapeClosingStyle(css: string) {
  return css.replace(/<\/style/gi, '<\\/style');
}
