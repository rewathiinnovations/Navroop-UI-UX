/**
 * Turns a generated project's file map into something the in-browser bundler
 * can build: an entry module, the virtual filesystem, and any shims the stack
 * needs. Side-effect-free and I/O-free so it can be unit-tested and reused by the
 * server-side publish bundler. Two things it reads from outside its arguments: the
 * origin project-asset URLs resolve against (`previewAssetOrigin` below), which is
 * `location` in the tab and `NEXT_PUBLIC_APP_URL` on the server; and the pinned
 * dependency maps, so the returned assembly can carry the import map its bare
 * specifiers were resolved against — the bundler and the served document have to
 * agree about which packages exist, or a build compiles and then fails to load.
 *
 * **Everything this file value-imports ships to the browser.**
 * `components/workspace/BrowserPreview.tsx` is a `'use client'` component and
 * calls `assemblePreview` on every chunk of a generation stream, so its whole
 * transitive value graph is downloaded and parsed by every visitor to
 * `/project/[id]` — including one who never opens the Code pane. Nothing here
 * reaches a server-only module or a `node:*` builtin, so the failure class is
 * weight and disclosure rather than a Turbopack cold-compile 500: the generation
 * prompts are model instructions, and a value edge to them makes their exact
 * wording readable from the client bundle. Add an import only for something the
 * preview genuinely needs at runtime *in the frame*, and prefer `import type`,
 * which the bundler never sees. `tests/unit/preview-client-graph.test.ts` walks
 * this graph, pins it as an upper bound and names the prompt-text modules and
 * exports it may not reach.
 */

import { projectPreviewDeps } from '@/lib/preview/deps';
import { PREVIEW_LAYOUT_BASENAME } from '@/lib/preview/labels';
import { withStarterFiles } from '@/lib/stacks/starter';

export type PreviewAssembly =
  | { kind: 'html'; html: string }
  | {
      kind: 'bundle';
      entry: string;
      files: Record<string, string>;
      aliases: Record<string, string>;
      /**
       * The import map this assembly's bare specifiers resolve against: the
       * always-available set plus whichever optional packages the project's own
       * `package.json` asks for.
       *
       * Carried on the assembly rather than recomputed by each caller so the
       * bundler and the document's import map cannot disagree — a bundle built
       * against a wider set than the frame serves compiles and then fails to load.
       */
      deps: Record<string, string>;
    }
  | { kind: 'empty'; reason: string };

const ENTRY_PATH = '__preview/entry.tsx';

/** Root component candidates per stack, most specific first. */
const ROOT_CANDIDATES: Record<string, string[]> = {
  REACT: ['src/App.tsx', 'src/App.jsx', 'App.tsx', 'App.jsx', 'src/app.tsx', 'src/app.jsx'],
  NEXTJS: ['app/page.tsx', 'app/page.jsx', 'pages/index.tsx', 'pages/index.jsx'],
};

/** Entry modules a project may ship that already mount the app themselves. */
const SELF_MOUNTING_ENTRIES = ['src/main.tsx', 'src/main.jsx', 'src/index.tsx', 'src/index.jsx'];

export function assemblePreview(
  stack: string,
  rawFiles: Record<string, string>,
  directionId?: string | null,
): PreviewAssembly {
  const projectFiles = normalizeFiles(rawFiles);
  // Emptiness is a fact about the *project*, not about the merged set: the
  // starter kit is eleven files, so asking after the merge would turn "this
  // project has no files yet" into "no root component found".
  if (Object.keys(projectFiles).length === 0) {
    return { kind: 'empty', reason: 'This project has no files yet.' };
  }

  // Normalised first, then the starter kit *underneath*: a project file stored
  // as `./app/globals.css` has to beat the starter's `app/globals.css`, and
  // merging before normalisation would leave both keys in the map with the
  // winner decided by insertion order.
  //
  // This one call is what puts the locked stack in front of the browser
  // preview, `buildStaticSite`, the served `/preview-static` build and
  // `checkBuild` — all four route through here. It is also the only import on
  // this file's browser graph that is wider than what the frame uses:
  // `withStarterFiles` asks the `lib/stacks/templates` barrel for a whole repo
  // scaffold and filters it down to the starter kit, so the `package.json` /
  // `tsconfig.json` / `vite.config.js` builders and the stack definition table
  // ride into the bundle to produce files the filter then discards. The pin in
  // `tests/unit/preview-client-graph.test.ts` lists them as the residual to
  // remove; the fix belongs in `lib/stacks/starter.ts`, not here.
  //
  // The asset rewrite sits on top of that merge, so the STATIC_HTML branch's
  // `inlineLocalAssets` inlines a stylesheet whose `url(...)` references have
  // already been made absolute.
  const merged = withResolvableAssetUrls(
    withStarterFiles(stack, projectFiles, directionId),
    previewAssetOrigin(),
  );

  if (stack === 'STATIC_HTML') {
    const html = merged['index.html'] ?? merged['public/index.html'];
    if (!html) {
      return { kind: 'empty', reason: 'No index.html found in this project.' };
    }
    return { kind: 'html', html: inlineLocalAssets(html, merged) };
  }

  // Below this line the file set is headed for esbuild, which is not Tailwind —
  // hence the layer flattening, which STATIC_HTML deliberately does not get.
  const files = withFlattenedTailwindLayers(merged);

  const aliases = stack === 'NEXTJS' ? withNextShims(files) : {};
  // From the project's own files, not the merged set: the starter kit's manifest
  // must not widen what a project may import.
  const deps = projectPreviewDeps(rawFiles);
  const selfMounting = SELF_MOUNTING_ENTRIES.find((path) => path in files);
  if (selfMounting && stack === 'REACT') {
    return { kind: 'bundle', entry: selfMounting, files, aliases, deps };
  }

  const root = ROOT_CANDIDATES[stack]?.find((path) => path in files);
  if (!root) {
    const expected = ROOT_CANDIDATES[stack]?.[0] ?? 'src/App.tsx';
    return {
      kind: 'empty',
      reason: `No root component found — expected ${expected}.`,
    };
  }

  const globalCss = findGlobalCss(files);
  const layout = stack === 'NEXTJS' ? nextLayoutModule(files) : null;
  const bundleFiles = { ...files };
  if (layout?.source) bundleFiles[layout.importPath] = layout.source;

  // Next App Router: a site is usually more than app/page.tsx. Enumerate the
  // static pages and mount them behind an in-frame router, so /about renders
  // /about instead of tree-shaking every non-home page away and letting the
  // link escape into the parent app (F-145).
  const routes = stack === 'NEXTJS' ? nextPageRoutes(files) : [];
  const entry =
    stack === 'NEXTJS' && routes.length > 0
      ? buildNextRouterEntry(routes, globalCss, layout?.importPath ?? null)
      : buildEntryModule(root, globalCss, layout?.importPath ?? null);
  return {
    kind: 'bundle',
    entry: ENTRY_PATH,
    files: { ...bundleFiles, [ENTRY_PATH]: entry },
    aliases,
    deps,
  };
}

/**
 * The prefix the local storage driver hands out for a project image
 * (`localUrl` in `lib/storage/index.ts` returns `/uploads/{key}`). The S3 driver
 * returns an absolute public-bucket URL instead, which the match below never
 * touches because it is anchored to the start of the reference.
 */
const PROJECT_ASSET_PREFIX = '/uploads/';

/**
 * One project-asset reference, anchored to the character that opens it.
 *
 * The opener has to be a quote, a `url(`, a `srcSet` separator or an unquoted
 * `=`, because `/uploads/` is only a reference when it *starts* the URL:
 * `https://cdn.example.com/uploads/hero.webp` and a `` `${base}/uploads/x` ``
 * template both carry the same six characters in the middle and must be left
 * exactly as they are. The run then stops at anything that ends a URL token, so
 * a `srcSet` descriptor (`… 2x`), a closing `)` and a template hole (`${id}`)
 * all survive. A `data:` payload cannot be hit: base64's `=` is padding, so it
 * only ever appears at the very end of one.
 *
 * The comma is both an opener and a terminator, because `srcSet` may separate
 * its candidates with no space at all (`"/uploads/a.webp,/uploads/b.webp 2x"`,
 * which the HTML parser accepts). Terminating only on whitespace read that as
 * one URL, so the whole descriptor list became the first candidate's path and
 * the second image was never rewritten — the exact failure the rewrite exists to
 * end, one attribute over. No project-asset URL can contain a comma itself:
 * these are `normalizeKey` outputs.
 */
const PROJECT_ASSET_REFERENCE = new RegExp(
  `(^|["'\`(,=\\s])(${PROJECT_ASSET_PREFIX}[^\\s"'\`),<>\\\\{]*)`,
  'g',
);

/**
 * Rewrites project-asset references to absolute URLs against the app origin.
 *
 * A `ProjectAsset` is bytes in object storage plus a row holding the URL this
 * app serves them at, and on the local driver that URL is app-relative. The
 * string reaches generated code verbatim — `lib/assets/manifest.ts` lists it for
 * the model to reuse and `lib/assets/fulfill.ts` substitutes it in for a
 * `NEED_IMAGE:` token — so the preview frame is asked to load `/uploads/…`. That
 * frame is a `srcdoc` document sandboxed *without* `allow-same-origin`: its
 * origin is opaque, so a root-relative URL has nothing to resolve against and
 * the request never leaves the page. Every photograph rendered as its alt text
 * while `HEAD /uploads/projects/{id}/assets/{id}.webp` answered 200 on the app
 * origin, so a customer approved a page with no pictures on it and published one
 * with pictures.
 *
 * An absolute URL is the fix that needs no new privilege: an image, a stylesheet
 * `url(...)` and a `srcSet` candidate are subresource loads, which are not
 * subject to the same-origin policy, so an opaque-origin document may fetch all
 * three from another origin. The sandbox must stay exactly as it is —
 * `allow-same-origin` on model-authored JavaScript would hand it the viewer's
 * session (F-140) — and a `<base>` tag was the other candidate and is worse: it
 * would silently redirect every *other* relative URL in the document too.
 *
 * Only the preview assembly is rewritten. The published site resolves the same
 * paths the other way round: `collectPublishAssets` (`lib/publish/assets.ts`)
 * copies the bytes into `{publicDir}/uploads/…` in the deploy repo so the
 * deployed page answers its own `/uploads/…`, which needs the stored project
 * files to keep the relative form. Nothing here touches them — the map arrives
 * from `normalizeFiles`, which already copied it, and this returns a new map.
 */
function withResolvableAssetUrls(
  files: Record<string, string>,
  origin: string | null,
): Record<string, string> {
  if (!origin) return files;
  const out: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    out[path] = content.includes(PROJECT_ASSET_PREFIX)
      ? content.replace(
          PROJECT_ASSET_REFERENCE,
          (_match, opener: string, url: string) => `${opener}${origin}${url}`,
        )
      : content;
  }
  return out;
}

/**
 * The origin `/uploads/…` has to be resolved against, or null when this
 * deployment cannot say.
 *
 * In the tab that is the location serving the workspace: it is the ground truth
 * for where the asset was just fetched from, and the only answer that survives
 * this repository's two checkouts running on two ports with two different
 * `NEXT_PUBLIC_APP_URL` values. On the server — `buildStaticSite`, which runs the
 * same assembly for the served `/preview-static` build — there is no location,
 * so the build-time public URL is read instead; production refuses to boot
 * without it (`assertInternalOrigin`, `lib/api/internal-origin.ts`).
 *
 * Null rather than a guessed host when nothing parses: inventing an origin
 * points every image on the page at a host that does not exist. What that floor
 * actually costs is not uniform, and this comment used to claim it was — "one
 * broken image" is true only of the half of it that is a string. A `src` or a
 * `srcSet` left relative is the broken image the rewrite exists to end, and
 * nothing worse. A CSS `url(/uploads/…)` left relative is the whole preview: the
 * virtual resolver behind the bundler (`lib/preview/bundle.ts` in the tab,
 * `lib/preview/server-bundle.ts` on the server) reads a `url()` token as a
 * module specifier, finds no such entry in the file map and fails the build
 * naming the stylesheet, so a page that would have rendered with one missing
 * background does not render at all. Making that reference `external` to esbuild
 * belongs in those two resolvers, which own the build options; until it is there
 * the floor for a stylesheet that names a project image is a dead preview, not a
 * degraded one. A truthy string is not a URL, so `https://undefined` is refused
 * by name.
 */
function previewAssetOrigin(): string | null {
  const fromLocation = (globalThis as { location?: { origin?: unknown } }).location?.origin;
  if (typeof fromLocation === 'string' && fromLocation) {
    const parsed = parseOrigin(fromLocation);
    if (parsed) return parsed;
  }
  // Guarded because this module is on the `'use client'` graph: Next inlines
  // `NEXT_PUBLIC_*` into the browser bundle, and the guard is what keeps a build
  // that did not from throwing `process is not defined` inside the workspace.
  const fromEnv = typeof process === 'undefined' ? null : process.env.NEXT_PUBLIC_APP_URL;
  return parseOrigin(fromEnv);
}

function parseOrigin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname || parsed.hostname === 'undefined' || parsed.hostname === 'null') return null;
  return parsed.origin;
}

/**
 * The three layer names Tailwind v3 owns. `@layer base` in a Tailwind stylesheet
 * is a *build directive*, not the CSS at-rule that shares its spelling: the
 * PostCSS plugin removes the wrapper and emits its contents into the
 * corresponding `@tailwind` position. Any other name is a real cascade layer the
 * author meant (Tailwind itself errors on one, having no `@tailwind foo` to put
 * it in), so it is left exactly as written.
 */
const TAILWIND_LAYER_BLOCK = /@layer\s+(?:base|components|utilities)\s*\{/iy;

/**
 * Unwraps Tailwind's layer directives, because the preview has no PostCSS.
 *
 * The stylesheet reaches the frame through esbuild, which treats `@layer base {
 * … }` as what it literally is — a real CSS cascade layer — while the built site
 * never has one, because Tailwind stripped the wrapper before the browser saw
 * it. Layer order is resolved *before* specificity, so every declaration inside
 * that block sits below every unlayered declaration no matter how specific it
 * is, and the Play CDN injects its preflight unlayered. The starter stylesheet's
 * `border-color: hsl(var(--border))` therefore lost to preflight's gray-200 in
 * the preview and won in the exported repo, the ZIP and the published site: a
 * `className="border rounded-lg"` card was approved in one colour and shipped in
 * another, against the one property `lib/preview/server-bundle.ts` claims.
 *
 * Model-authored CSS has the identical bug and is the larger half of it — every
 * shadcn/ui snippet in the training data wraps its base rules this way, so a
 * project that writes its own `app/globals.css` reproduces it without the
 * starter kit being involved at all.
 *
 * STATIC_HTML is excluded at the call site rather than here: that stack ships
 * its stylesheet to nginx byte for byte, so its `@layer` really is a cascade
 * layer in production, and flattening it would *create* the divergence this
 * removes.
 *
 * An unbalanced sheet returns unchanged. Dropping an opener whose closer was
 * never found would emit a stray `}` and take out every rule after it, which is
 * a worse answer than the layering this exists to fix.
 */
function withFlattenedTailwindLayers(files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    out[path] = path.endsWith('.css') ? flattenTailwindLayers(content) : content;
  }
  return out;
}

function flattenTailwindLayers(css: string): string {
  if (!css.includes('@layer')) return css;
  const out: string[] = [];
  let copied = 0;
  let i = 0;
  let depth = 0;
  // The brace depth each unwrapped block was opened at, innermost last: its
  // closer is the `}` seen back at that same depth.
  const unwrapped: number[] = [];

  while (i < css.length) {
    const char = css[i];
    // Comments and strings first: a `{` inside `content: "{"` or a commented-out
    // rule would otherwise move the depth counter and mis-pair every closer
    // after it.
    if (char === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      i += 1;
      while (i < css.length && css[i] !== char) i += css[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (char === '@') {
      TAILWIND_LAYER_BLOCK.lastIndex = i;
      const opener = TAILWIND_LAYER_BLOCK.exec(css);
      if (opener) {
        out.push(css.slice(copied, i));
        i += opener[0].length;
        copied = i;
        unwrapped.push(depth);
        depth += 1;
        continue;
      }
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (unwrapped[unwrapped.length - 1] === depth) {
        unwrapped.pop();
        out.push(css.slice(copied, i));
        copied = i + 1;
      }
    }
    i += 1;
  }

  if (unwrapped.length > 0) return css;
  out.push(css.slice(copied));
  return out.join('');
}

export type NextRoute = { path: string; file: string };

/**
 * The statically-enumerable App Router pages, most general path first
 * (`/` before its children), then alphabetical. Route groups (`(marketing)`)
 * are stripped from the URL as Next strips them; dynamic segments (`[slug]`)
 * are skipped because their concrete URLs are not known ahead of a request —
 * rendering them is the scoped follow-up.
 */
export function nextPageRoutes(rawFiles: Record<string, string>): NextRoute[] {
  const files = normalizeFiles(rawFiles);
  const routes: NextRoute[] = [];
  for (const file of Object.keys(files)) {
    const match = /^app\/(.*\/)?page\.(tsx|jsx|js|mjs)$/.exec(file);
    if (!match) continue;
    const dir = match[1] ?? '';
    const segments = dir.split('/').filter((segment) => segment && !/^\(.*\)$/.test(segment));
    if (segments.some((segment) => segment.includes('[') || segment.includes(']'))) continue;
    routes.push({ path: `/${segments.join('/')}`.replace(/\/$/, '') || '/', file });
  }
  return routes.sort((left, right) => {
    if (left.path === '/') return -1;
    if (right.path === '/') return 1;
    return left.path.localeCompare(right.path);
  });
}

function buildEntryModule(root: string, globalCss: string | null, layout: string | null) {
  const importPath = (path: string) => `/${path}`;
  const lines = [
    `import React from 'react';`,
    `import { createRoot } from 'react-dom/client';`,
    globalCss ? `import '${importPath(globalCss)}';` : null,
    `import Root from '${importPath(root)}';`,
    layout ? `import Layout from '${importPath(layout)}';` : null,
    ``,
    `const container = document.getElementById('root');`,
    `if (container) {`,
    layout
      ? `  createRoot(container).render(React.createElement(Layout, null, React.createElement(Root)));`
      : `  createRoot(container).render(React.createElement(Root));`,
    `}`,
    ``,
  ].filter((line) => line !== null);
  return lines.join('\n');
}

/**
 * Entry for a multi-page Next.js site: import every static page, mount them
 * behind a tiny in-frame router, and intercept in-project absolute links so a
 * click routes in the frame instead of navigating the preview origin out to the
 * parent app (F-145). The router state lives in the `next/navigation` shim, so
 * `useRouter().push` and a plain `<a href>` move the same current path.
 */
function buildNextRouterEntry(
  routes: NextRoute[],
  globalCss: string | null,
  layout: string | null,
) {
  const importPath = (path: string) => `/${path}`;
  const imports = routes.map(
    (route, index) => `import Page_${index} from '${importPath(route.file)}';`,
  );
  const table = routes
    .map((route, index) => `  { path: ${JSON.stringify(route.path)}, Component: Page_${index} },`)
    .join('\n');
  const lines = [
    `import React from 'react';`,
    `import { createRoot } from 'react-dom/client';`,
    globalCss ? `import '${importPath(globalCss)}';` : null,
    layout ? `import Layout from '${importPath(layout)}';` : null,
    `import { __setRoutes, __currentPath, __subscribe, __navigate } from '/__preview/next-navigation';`,
    ...imports,
    ``,
    `const routes = [`,
    table,
    `];`,
    `__setRoutes(routes.map(function (route) { return { path: route.path }; }));`,
    ``,
    `function PreviewRouter() {`,
    `  const [path, setPath] = React.useState(__currentPath());`,
    `  React.useEffect(function () { return __subscribe(setPath); }, []);`,
    `  const match = routes.find(function (route) { return route.path === path; })`,
    `    || routes.find(function (route) { return route.path === '/'; })`,
    `    || routes[0];`,
    `  return match`,
    `    ? React.createElement(match.Component)`,
    `    : React.createElement('div', null, 'Page not found');`,
    `}`,
    ``,
    `// Any in-project absolute link routes in the frame. A sandboxed srcdoc has`,
    `// an opaque origin and the served build sits under the preview host, so an`,
    `// unintercepted <a href="/about"> either dead-ends or escapes into the app.`,
    `document.addEventListener('click', function (event) {`,
    `  if (event.defaultPrevented || event.button !== 0) return;`,
    `  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;`,
    `  const anchor = event.target && event.target.closest ? event.target.closest('a') : null;`,
    `  if (!anchor) return;`,
    `  const href = anchor.getAttribute('href');`,
    `  if (!href || href[0] !== '/') return;`,
    `  const target = anchor.getAttribute('target');`,
    `  if (target && target !== '_self') return;`,
    `  event.preventDefault();`,
    `  __navigate(href);`,
    `});`,
    ``,
    `const container = document.getElementById('root');`,
    `if (container) {`,
    layout
      ? `  createRoot(container).render(React.createElement(Layout, null, React.createElement(PreviewRouter)));`
      : `  createRoot(container).render(React.createElement(PreviewRouter));`,
    `}`,
    ``,
  ].filter((line) => line !== null);
  return lines.join('\n');
}

function findGlobalCss(files: Record<string, string>) {
  return (
    ['src/index.css', 'src/globals.css', 'app/globals.css', 'styles/globals.css', 'index.css'].find(
      (path) => path in files,
    ) ?? null
  );
}

/**
 * The App Router's layout is where Next.js wants the nav and the footer, and it
 * is where the model correctly puts them. This used to drop that file whenever it
 * rendered `<html>` — which every idiomatic layout does — so generated sites
 * previewed with no header and no footer while `components/Nav.tsx` and
 * `components/Footer.tsx` sat in the file tree looking ungenerated.
 *
 * So the layout is mounted: its document tags are swapped for plain elements
 * (React mounts into an existing document, where a second `<html>`/`<body>`
 * cannot go) and an async layout gets a client boundary instead of being
 * dropped (F-153). The rewrite lands in a copy — the project's own file is never
 * modified.
 */
function nextLayoutModule(
  files: Record<string, string>,
): { importPath: string; source?: string } | null {
  const path = ['app/layout.tsx', 'app/layout.jsx'].find((candidate) => candidate in files);
  if (!path) return null;
  const source = files[path];
  const isAsync = ASYNC_DEFAULT_EXPORT.test(source);
  const rendersDocument = DOCUMENT_ROOT.test(source);
  if (!isAsync && !rendersDocument) return { importPath: path };
  // The copy sits in the layout's own directory, not under `__preview/`: it keeps
  // the original's relative imports working. Moving it broke `./globals.css` on the
  // first try, which the pane reported as a missing file the model never wrote.
  const adaptedPath = path.replace(/layout\.(tsx|jsx)$/, PREVIEW_LAYOUT_BASENAME);
  const adapted = rendersDocument ? adaptDocumentTags(source) : source;
  return { importPath: adaptedPath, source: isAsync ? mountAsyncLayout(adapted) : adapted };
}

/** Captures the local name so the body can keep it once it stops being default. */
const ASYNC_DEFAULT_EXPORT = /export\s+default\s+async\s+function\s*([A-Za-z_$][\w$]*)?\s*\(/;
const ANON_ASYNC_LAYOUT = '__previewAsyncLayout';

/**
 * An async layout is a server component: it evaluates to a promise, which React
 * cannot render on the client. The whole file used to be skipped for it, so the
 * nav and the footer vanished from the preview with nothing said, while
 * `components/Nav.tsx` sat in the file tree — the exact symptom mounting the
 * layout exists to prevent (F-153).
 *
 * Instead the async body keeps its name and stops being the default export, and
 * the new default is a sync component that calls it outside render and swaps the
 * resolved element in when it arrives. Until then — and if it rejects, which a
 * browser will for server-only data fetching — the children render on their own,
 * which is all that dropping the layout ever achieved.
 */
function mountAsyncLayout(source: string): string {
  const match = ASYNC_DEFAULT_EXPORT.exec(source);
  if (!match) return source;
  const name = match[1] ?? ANON_ASYNC_LAYOUT;
  return `${source.replace(ASYNC_DEFAULT_EXPORT, `async function ${name}(`)}
import * as __previewReact from 'react';
export default function __PreviewAsyncLayout(props) {
  const [resolved, setResolved] = __previewReact.useState(null);
  const children = props ? props.children : null;
  __previewReact.useEffect(function () {
    let alive = true;
    Promise.resolve()
      .then(function () { return ${name}(props); })
      .then(function (node) { if (alive) setResolved(node); })
      .catch(function () { if (alive) setResolved(null); });
    return function () { alive = false; };
  }, [children]);
  return resolved === null ? children : resolved;
}
`;
}

/** What each document tag becomes; a hidden `<head>` keeps loading its links. */
const DOCUMENT_TAG_SWAP: Record<string, string> = {
  html: '<div',
  body: '<div',
  head: '<div hidden',
};
/** Sticky: tested at one index, never scanned forward. */
const DOCUMENT_TAG = /<(\/?)(html|body|head)(?=[\s/>])/iy;
const DOCUMENT_ROOT = /<html[\s>]/i;
/** Where a `<` may open JSX. After an identifier it is a comparison. */
const JSX_MAY_START = /[([{},;:=?&|!+>]/;

type JsxContext = 'js' | 'template' | 'text' | 'tag' | 'closing-tag';

/**
 * `<html>`/`<body>` become divs and `<head>` a hidden div — but only where the
 * tag is a real JSX element. The rewrite used to be a blanket `String.replace`
 * over the file's text, so an analytics snippet or a `<noscript>` fallback
 * holding the literal "<body" in a string was rewritten too, and the preview
 * rendered markup the real build never contains (F-152).
 *
 * The scan tracks JSX text as text rather than as JavaScript: an apostrophe in
 * "Don't" and the `//` in a URL are prose, and reading either as a string or a
 * comment would hide every tag after it. `{…}` drops back to JavaScript, where
 * quotes, template literals and comments mean what they mean.
 *
 * If the scan leaves a `<html>` behind — an exotic layout its JSX tracking
 * cannot follow — the blanket rewrite is taken instead: a mounted copy with a
 * second `<html>` in it is the failure this whole path exists to avoid, so
 * today's behaviour is the floor rather than the ceiling.
 */
function adaptDocumentTags(source: string): string {
  const scanned = swapJsxDocumentTags(source);
  if (!DOCUMENT_ROOT.test(scanned)) return scanned;
  return source
    .replace(/<html(\s|>)/gi, '<div$1')
    .replace(/<\/html>/gi, '</div>')
    .replace(/<body(\s|>)/gi, '<div$1')
    .replace(/<\/body>/gi, '</div>')
    .replace(/<head(\s|>)/gi, '<div hidden$1')
    .replace(/<\/head>/gi, '</div>');
}

function swapJsxDocumentTags(source: string): string {
  const out: string[] = [];
  let copied = 0;
  // Innermost last. The outermost `js` is the module itself and never pops.
  const stack: JsxContext[] = ['js'];
  // Open braces per JavaScript context, so an expression container — `${…}` in a
  // template, `{…}` in JSX — recognises its own closer.
  const braces: number[] = [0];
  let lastChar = '';
  let lastWord = '';
  let i = 0;

  while (i < source.length) {
    const mode = stack[stack.length - 1];
    const char = source[i];
    const next = source[i + 1] ?? '';

    if (mode === 'template') {
      if (char === '\\') i += 2;
      else if (char === '`') {
        stack.pop();
        i += 1;
      } else if (char === '$' && next === '{') {
        stack.push('js');
        braces.push(0);
        i += 2;
      } else i += 1;
      continue;
    }

    if (mode === 'text') {
      if (char === '{') {
        stack.push('js');
        braces.push(0);
        i += 1;
      } else if (char === '<') {
        DOCUMENT_TAG.lastIndex = i;
        const tag = DOCUMENT_TAG.exec(source);
        if (tag) {
          out.push(
            source.slice(copied, i),
            tag[1] ? '</div' : DOCUMENT_TAG_SWAP[tag[2].toLowerCase()],
          );
          i += tag[0].length;
          copied = i;
          stack.push(tag[1] ? 'closing-tag' : 'tag');
        } else {
          stack.push(next === '/' ? 'closing-tag' : 'tag');
          i += next === '/' ? 2 : 1;
        }
      } else i += 1;
      continue;
    }

    if (mode === 'tag' || mode === 'closing-tag') {
      if (char === '"' || char === "'") {
        // A JSX attribute value holds no escapes, so the next quote ends it.
        const end = source.indexOf(char, i + 1);
        i = end === -1 ? source.length : end + 1;
      } else if (char === '{') {
        stack.push('js');
        braces.push(0);
        i += 1;
      } else if (char === '/' && next === '>') {
        stack.pop();
        i += 2;
      } else if (char === '>') {
        stack.pop();
        if (mode === 'tag') stack.push('text');
        // A closing tag ends the children region it closes.
        else if (stack[stack.length - 1] === 'text') stack.pop();
        i += 1;
      } else i += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      i += 1;
      while (i < source.length && source[i] !== char) i += source[i] === '\\' ? 2 : 1;
      i += 1;
      lastChar = char;
      lastWord = '';
      continue;
    }
    if (char === '`') {
      stack.push('template');
      i += 1;
      lastChar = char;
      lastWord = '';
      continue;
    }
    if (char === '}' && braces[braces.length - 1] === 0 && stack.length > 1) {
      stack.pop();
      braces.pop();
      i += 1;
      continue;
    }
    if (char === '{') braces[braces.length - 1] += 1;
    if (char === '}') braces[braces.length - 1] -= 1;
    // `<` opens JSX only where a value may start: `count < max` is a comparison,
    // and so is `Array<string>`, but `return <html>` and `=> <html>` are not.
    if (
      char === '<' &&
      /[A-Za-z_$>/]/.test(next) &&
      (lastChar === '' || JSX_MAY_START.test(lastChar) || lastWord === 'return')
    ) {
      DOCUMENT_TAG.lastIndex = i;
      const tag = DOCUMENT_TAG.exec(source);
      if (tag) {
        out.push(
          source.slice(copied, i),
          tag[1] ? '</div' : DOCUMENT_TAG_SWAP[tag[2].toLowerCase()],
        );
        i += tag[0].length;
        copied = i;
        stack.push(tag[1] ? 'closing-tag' : 'tag');
      } else {
        stack.push(next === '/' ? 'closing-tag' : 'tag');
        i += next === '/' ? 2 : 1;
      }
      continue;
    }
    if (!/\s/.test(char)) {
      lastChar = char;
      lastWord = /[\w$]/.test(char) ? lastWord + char : '';
    }
    i += 1;
  }

  out.push(source.slice(copied));
  return out.join('');
}

/**
 * next/* modules have no browser build, so previews get minimal shims:
 * Link renders an anchor, Image an img, and the router hooks are inert.
 */
function withNextShims(files: Record<string, string>): Record<string, string> {
  files['__preview/next-link.tsx'] = `import React from 'react';
export default function Link({ href, children, ...rest }: any) {
  return React.createElement('a', { href: typeof href === 'string' ? href : '#', ...rest }, children);
}
`;
  files['__preview/next-image.tsx'] = `import React from 'react';
export default function Image({ src, alt, fill, priority, quality, loader, placeholder, blurDataURL, unoptimized, ...rest }: any) {
  const source = typeof src === 'string' ? src : src?.src;
  const style = fill
    ? { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', ...(rest.style || {}) }
    : rest.style;
  return React.createElement('img', { src: source, alt: alt || '', loading: priority ? 'eager' : 'lazy', ...rest, style });
}
`;
  files['__preview/next-navigation.ts'] = `import React from 'react';

// A real, in-frame router. The old shim's push was a noop and usePathname was a
// constant '/', so a multi-page site could not move between its pages and every
// link either dead-ended or escaped the preview (F-145). State lives here so the
// entry's click interceptor, useRouter().push and usePathname all read one path.
type Listener = (path: string) => void;
const listeners = new Set<Listener>();
let routes: Array<{ path: string }> = [];
let navigated = false;

function fromLocation(): string {
  const pathname = (typeof location !== 'undefined' && location.pathname) || '/';
  for (const route of routes) if (route.path === pathname) return route.path;
  // The served build sits under an unknown /<projectId> mount prefix, so match
  // the longest known route the pathname ends with; the srcdoc frame has no
  // meaningful pathname and falls through to '/'.
  let best = '/';
  for (const route of routes) {
    if (route.path !== '/' && pathname.endsWith(route.path) && route.path.length > best.length) {
      best = route.path;
    }
  }
  return best;
}

let current = '/';

export function __setRoutes(next: Array<{ path: string }>): void {
  routes = next;
  if (!navigated) current = fromLocation();
}
export function __currentPath(): string {
  return current;
}
export function __subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function __navigate(path: string): void {
  const clean = path[0] === '/' ? path.split('#')[0].split('?')[0] : '/' + path;
  navigated = true;
  current = clean;
  try {
    history.pushState({}, '', path);
  } catch {}
  listeners.forEach((listener) => listener(clean));
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    current = fromLocation();
    listeners.forEach((listener) => listener(current));
  });
}

export function useRouter() {
  return {
    push: (href: string) => __navigate(href),
    replace: (href: string) => __navigate(href),
    back: () => {
      try {
        history.back();
      } catch {}
    },
    forward: () => {},
    refresh: () => {},
    prefetch: () => {},
  };
}
export function usePathname(): string {
  const [path, setPath] = React.useState(__currentPath());
  React.useEffect(() => __subscribe(setPath), []);
  return path;
}
export function useSearchParams() { return new URLSearchParams(); }
export function useParams() { return {}; }
export function redirect(path: string) { __navigate(path); }
export function notFound() {}
`;
  // Every font the project imports, generated from the project itself: Google
  // ships hundreds of families and a fixed list is a guaranteed miss. Mounting the
  // layout is what first exercised these imports, and the first real site asked for
  // `Open_Sans`, which the hardcoded list did not have — so the whole preview
  // failed to compile on a font name.
  const fontExports = nextFontImportNames(files)
    .map((name) => `export const ${name} = font;`)
    .join('\n');
  files['__preview/next-font.ts'] =
    `type FontResult = { className: string; variable: string; style: { fontFamily: string } };
const font = (): FontResult => ({ className: '', variable: '', style: { fontFamily: 'inherit' } });
${fontExports}
export default font;
`;
  files['__preview/next-head.tsx'] = `export default function Head() { return null; }
`;

  return {
    'next/link': '__preview/next-link.tsx',
    'next/image': '__preview/next-image.tsx',
    'next/navigation': '__preview/next-navigation.ts',
    'next/font/google': '__preview/next-font.ts',
    'next/font/local': '__preview/next-font.ts',
    'next/head': '__preview/next-head.tsx',
  };
}

/**
 * The font families a project imports from `next/font/*`, so the shim can export
 * exactly those. Aliases (`Open_Sans as sans`) are read from the left-hand name,
 * which is what the module has to export.
 */
function nextFontImportNames(files: Record<string, string>): string[] {
  const names = new Set<string>();
  for (const content of Object.values(files)) {
    const re = /import\s*\{([^}]*)\}\s*from\s*['"]next\/font\/(?:google|local)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      for (const part of match[1].split(',')) {
        const name = part
          .trim()
          .split(/\s+as\s+/)[0]
          .trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
      }
    }
  }
  return [...names];
}

/** Inline same-project css/js referenced by a static page so it renders standalone. */
function inlineLocalAssets(html: string, files: Record<string, string>) {
  let out = html.replace(
    /<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi,
    (match, href: string) => {
      const content = files[stripLeading(href)];
      return content ? `<style>${content}</style>` : match;
    },
  );
  out = out.replace(
    /<script([^>]*)\ssrc=["']([^"']+)["']([^>]*)><\/script>/gi,
    (match, before: string, src: string, after: string) => {
      const content = files[stripLeading(src)];
      if (!content) return match;
      const attrs = `${before}${after}`.replace(/\s+/g, ' ').trim();
      return `<script${attrs ? ` ${attrs}` : ''}>${content}</script>`;
    },
  );
  return out;
}

function stripLeading(path: string) {
  return path.replace(/^\.?\//, '').split('?')[0];
}

export function normalizeFiles(files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    if (typeof content !== 'string') continue;
    const normalized = path.replace(/^\.?\//, '').replace(/\\/g, '/');
    if (!normalized) continue;
    out[normalized] = content;
  }
  return out;
}

/**
 * A stable identity for "these exact files", derived without copying them.
 *
 * The preview used to key its rebuild on `JSON.stringify(assembly)` — a full
 * serialisation of every byte of the project, allocated and thrown away. The
 * streaming rail hands down a fresh array on every chunk, so that ran per chunk
 * of a build, on the same thread as the frames meant to show progress (F-642).
 *
 * FNV-1a over `path\0content` for each entry, keys sorted so a reordered map is
 * still the same code. It reads the same bytes `JSON.stringify` did, but
 * allocates nothing per call and produces a comparable 16-character key. A hash
 * over path plus content *length* would have been cheaper still and wrong: a
 * one-character edit that keeps the length is exactly the change a rebuild
 * exists for.
 */
export function previewFilesKey(files: Record<string, string>): string {
  // Two 32-bit lanes rather than one: a single FNV-1a over a whole project is
  // narrow enough to collide, and a collision here silently shows stale code.
  let low = 0x811c9dc5;
  let high = 0x01000193;
  const mix = (text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      low = Math.imul(low ^ code, 0x01000193);
      high = Math.imul(high ^ (code + i), 0x85ebca6b);
    }
  };
  for (const path of Object.keys(files).sort()) {
    mix(path);
    mix('\u0000');
    mix(files[path]);
    mix('\u0001');
  }
  return `${(low >>> 0).toString(16).padStart(8, '0')}${(high >>> 0).toString(16).padStart(8, '0')}`;
}
