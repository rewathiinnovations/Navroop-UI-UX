/**
 * Turns a generated project's file map into something the in-browser bundler
 * can build: an entry module, the virtual filesystem, and any shims the stack
 * needs. Pure and dependency-free so it can be unit-tested and reused by the
 * server-side publish bundler.
 */

import { PREVIEW_LAYOUT_BASENAME } from '@/lib/preview/labels';

export type PreviewAssembly =
  | { kind: 'html'; html: string }
  | {
      kind: 'bundle';
      entry: string;
      files: Record<string, string>;
      aliases: Record<string, string>;
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

export function assemblePreview(stack: string, rawFiles: Record<string, string>): PreviewAssembly {
  const files = normalizeFiles(rawFiles);
  if (Object.keys(files).length === 0) {
    return { kind: 'empty', reason: 'This project has no files yet.' };
  }

  if (stack === 'STATIC_HTML') {
    const html = files['index.html'] ?? files['public/index.html'];
    if (!html) {
      return { kind: 'empty', reason: 'No index.html found in this project.' };
    }
    return { kind: 'html', html: inlineLocalAssets(html, files) };
  }

  const aliases = stack === 'NEXTJS' ? withNextShims(files) : {};
  const selfMounting = SELF_MOUNTING_ENTRIES.find((path) => path in files);
  if (selfMounting && stack === 'REACT') {
    return { kind: 'bundle', entry: selfMounting, files, aliases };
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
  };
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
