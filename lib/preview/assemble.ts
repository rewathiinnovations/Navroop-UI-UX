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
  const entry = buildEntryModule(root, globalCss, layout?.importPath ?? null);
  return {
    kind: 'bundle',
    entry: ENTRY_PATH,
    files: { ...bundleFiles, [ENTRY_PATH]: entry },
    aliases,
  };
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
 * So the layout is mounted, with its document tags swapped for plain elements:
 * React is mounting into an existing document, where a second `<html>`/`<body>`
 * cannot go. The swap is textual, so a layout holding the literal string "<body"
 * inside a template literal would also be rewritten — acceptable against every
 * layout losing its chrome, and the original file is never modified.
 */
function nextLayoutModule(
  files: Record<string, string>,
): { importPath: string; source?: string } | null {
  const path = ['app/layout.tsx', 'app/layout.jsx'].find((candidate) => candidate in files);
  if (!path) return null;
  const source = files[path];
  // An async server component evaluates to a promise, which React cannot render
  // on the client. Skipping is still better than a preview that throws.
  if (/export\s+default\s+async\s+function/.test(source)) return null;
  if (!/<html[\s>]/i.test(source)) return { importPath: path };
  // The copy sits in the layout's own directory, not under `__preview/`: it keeps
  // the original's relative imports working. Moving it broke `./globals.css` on the
  // first try, which the pane reported as a missing file the model never wrote.
  const adaptedPath = path.replace(/layout\.(tsx|jsx)$/, PREVIEW_LAYOUT_BASENAME);
  return { importPath: adaptedPath, source: adaptDocumentTags(source) };
}

/** `<html>`/`<body>` become divs; `<head>` keeps loading its links while hidden. */
function adaptDocumentTags(source: string): string {
  return source
    .replace(/<html(\s|>)/gi, '<div$1')
    .replace(/<\/html>/gi, '</div>')
    .replace(/<body(\s|>)/gi, '<div$1')
    .replace(/<\/body>/gi, '</div>')
    .replace(/<head(\s|>)/gi, '<div hidden$1')
    .replace(/<\/head>/gi, '</div>');
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
  files['__preview/next-navigation.ts'] = `const noop = () => {};
export function useRouter() {
  return { push: noop, replace: noop, back: noop, forward: noop, refresh: noop, prefetch: noop };
}
export function usePathname() { return '/'; }
export function useSearchParams() { return new URLSearchParams(); }
export function useParams() { return {}; }
export function redirect() {}
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
