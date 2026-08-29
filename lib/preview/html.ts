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
 * a capture-phase link interceptor, and `<base href="about:srcdoc">`.
 */

export const PREVIEW_MESSAGE_SOURCE = 'navroop-preview';

export type PreviewMessage =
  | { source: typeof PREVIEW_MESSAGE_SOURCE; type: 'ready' }
  | {
      source: typeof PREVIEW_MESSAGE_SOURCE;
      type: 'error';
      message: string;
      stack?: string;
      /**
       * The route mounted when the error fired, from the in-frame router.
       *
       * Absent on a crash early enough that the navigation shim has not run —
       * which is itself informative, and why this is optional rather than
       * defaulted to `/`. Claiming the home page for an error that happened
       * before any page mounted is exactly the wrong guess to hand a repair.
       */
      route?: string;
    };

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
  // Which page was mounted. Length-capped because everything here crosses a
  // sandboxed-frame postMessage boundary into a repair prompt: it is untrusted
  // string data, exactly like message and stack, and the frame runs code this
  // pipeline generated rather than code anyone reviewed.
  var ROUTE = function () {
    try {
      if (typeof window.__previewRoute !== "function") return undefined;
      var value = window.__previewRoute();
      return typeof value === "string" ? value.slice(0, 200) : undefined;
    } catch (_) {
      return undefined;
    }
  };
  window.__previewPost = POST;
  window.addEventListener("error", function (event) {
    POST({
      type: "error",
      message: (event && event.message) || "Script error",
      stack: event && event.error && event.error.stack ? String(event.error.stack) : undefined,
      route: ROUTE(),
    });
  });
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event && event.reason;
    POST({
      type: "error",
      message: reason && reason.message ? String(reason.message) : "Unhandled promise rejection",
      stack: reason && reason.stack ? String(reason.stack) : undefined,
      route: ROUTE(),
    });
  });
})();
`;

/**
 * A sandboxed srcdoc has no base URL, so `document.baseURI` resolves to the
 * parent document's URL (the app origin). A plain `<a href="#reserve">` therefore
 * navigates the frame out to `http://<app>/project/<id>#reserve` — past the app
 * auth gate and off the preview — instead of scrolling to the in-frame section.
 * An `<a href="/shop">` aims at `http://<app>/shop` and either escapes or is
 * silently blocked by the opaque-origin sandbox, so the link looks dead (F-145).
 *
 * This capture-phase handler runs for every stack, before React or the Next
 * entry listener can preventDefault without routing. `/` paths go through
 * `window.__previewNavigate` (the next/navigation shim); `#` hashes scroll
 * inside the frame. The workspace page picker posts `{ type: "navigate" }`.
 */
const PREVIEW_LINK_INTERCEPTOR = `
(function () {
  function scrollHash(hash) {
    var id = hash && hash[0] === "#" ? hash.slice(1) : "";
    if (id) {
      try { id = decodeURIComponent(id); } catch (e) {}
      var target = document.getElementById(id);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function routeInFrame(href) {
    if (typeof window.__previewNavigate === "function") {
      window.__previewNavigate(href);
    }
    var hashAt = href.indexOf("#");
    if (hashAt !== -1) scrollHash(href.slice(hashAt));
  }

  function inSitePath(pathname) {
    return pathname.indexOf("/project/") !== 0
      && pathname.indexOf("/api/") !== 0
      && pathname.indexOf("/admin") !== 0
      && pathname.indexOf("/preview-static/") !== 0;
  }

  document.addEventListener("click", function (event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var node = event.target;
    if (node && node.nodeType === 3) node = node.parentElement;
    var anchor = node && node.closest ? node.closest("a") : null;
    if (!anchor) return;
    var href = anchor.getAttribute("href");
    if (href == null || href === "") return;
    var target = anchor.getAttribute("target");
    if (target && target !== "_self") return;
    if (href[0] === "#") {
      event.preventDefault();
      scrollHash(href);
      return;
    }
    if (href[0] === "/") {
      event.preventDefault();
      routeInFrame(href);
      return;
    }
    try {
      var abs = new URL(href, "http://preview.invalid/");
      if ((abs.protocol === "http:" || abs.protocol === "https:") && inSitePath(abs.pathname)) {
        event.preventDefault();
        if (abs.host === "preview.invalid") return;
        routeInFrame(abs.pathname + abs.search + abs.hash);
      }
    } catch (e) {}
  }, true);

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.source !== "${PREVIEW_MESSAGE_SOURCE}" || data.type !== "navigate") return;
    if (typeof data.path === "string") routeInFrame(data.path);
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
<script>${PREVIEW_LINK_INTERCEPTOR}</script>
<base href="about:srcdoc">
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
  // after the code that needed it. The link interceptor is the third script: it
  // keeps `#section` and `/page` links inside the frame, exactly as in the
  // bundled preview. `<base>` stops leftover hrefs resolving against the app.
  const bridge = `<script>${NODE_GLOBALS_SHIM}</script><script>${ERROR_BRIDGE}</script><script>${PREVIEW_LINK_INTERCEPTOR}</script><base href="about:srcdoc">`;
  const ready = `<script>setTimeout(function(){ if (window.__previewPost) window.__previewPost({ type: "ready" }); }, 0);</script>`;

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
