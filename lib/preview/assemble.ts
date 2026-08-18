/**
 * Turns a generated project's file map into something the in-browser bundler
 * can build: an entry module, the virtual filesystem, and any shims the stack
 * needs. Pure and dependency-free so it can be unit-tested and reused by the
 * server-side publish bundler.
 */

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
  const entry = buildEntryModule(
    root,
    globalCss,
    stack === 'NEXTJS' ? findNextLayout(files) : null,
  );
  return {
    kind: 'bundle',
    entry: ENTRY_PATH,
    files: { ...files, [ENTRY_PATH]: entry },
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

function findNextLayout(files: Record<string, string>) {
  // The App Router layout usually renders <html>/<body>, which React cannot
  // mount inside an existing document. Only use it when it does not.
  const path = ['app/layout.tsx', 'app/layout.jsx'].find((candidate) => candidate in files);
  if (!path) return null;
  return /<html[\s>]/i.test(files[path]) ? null : path;
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
  files['__preview/next-font.ts'] =
    `type FontResult = { className: string; variable: string; style: { fontFamily: string } };
const font = (): FontResult => ({ className: '', variable: '', style: { fontFamily: 'inherit' } });
export const Inter = font;
export const Roboto = font;
export const Poppins = font;
export const Montserrat = font;
export const Playfair_Display = font;
export const Space_Grotesk = font;
export const DM_Sans = font;
export const Lora = font;
export const Manrope = font;
export const Outfit = font;
export const Geist = font;
export const Geist_Mono = font;
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
