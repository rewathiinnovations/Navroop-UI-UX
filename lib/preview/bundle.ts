import * as esbuild from 'esbuild-wasm';
import { isLocalPreviewSpecifier, stripPreviewScheme } from './labels';

/**
 * In-browser bundler for generated apps.
 *
 * Adapted from llamacoder's preview renderer: esbuild-wasm compiles the
 * generated file set from a virtual filesystem, bare imports stay external and
 * are resolved at runtime by an esm.sh import map. No server, no sandbox VM.
 */

const ESBUILD_WASM_URL = '/preview-vendor/esbuild.wasm';

export const BARE_IMPORT_EXTERNALS = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react-dom/client',
];

export type BundleResult =
  | { ok: true; code: string; css: string; durationMs: number; cacheHit: boolean }
  | { ok: false; error: string; durationMs: number; cacheHit: boolean };

declare global {
  var __navroopEsbuildInit: Promise<void> | undefined;
  var __navroopBundleCache: Map<string, { code: string; css: string }> | undefined;
}

const BUNDLE_CACHE_LIMIT = 16;

export function ensureEsbuild(): Promise<void> {
  globalThis.__navroopEsbuildInit ??= esbuild.initialize({
    wasmURL: ESBUILD_WASM_URL,
    worker: true,
  });
  return globalThis.__navroopEsbuildInit;
}

/**
 * @param files virtual filesystem, keys are repo-relative paths
 * @param entry entry module path within `files`
 */
export async function bundlePreview(
  files: Record<string, string>,
  entry: string,
  options: { aliases?: Record<string, string> } = {},
): Promise<BundleResult> {
  const aliases = options.aliases ?? {};
  const cacheKey = stableKey(files, entry, aliases);
  const cached = readCache(cacheKey);
  if (cached) {
    return { ok: true, code: cached.code, css: cached.css, durationMs: 0, cacheHit: true };
  }

  await ensureEsbuild();
  const start = performance.now();
  try {
    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      outfile: '/preview.js',
      format: 'esm',
      target: 'es2022',
      jsx: 'automatic',
      sourcemap: false,
      logLevel: 'silent',
      legalComments: 'none',
      define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [virtualFs(files, aliases)],
    });
    const code = joinOutputs(result.outputFiles, '.js');
    const css = joinOutputs(result.outputFiles, '.css');
    writeCache(cacheKey, { code, css });
    return { ok: true, code, css, durationMs: performance.now() - start, cacheHit: false };
  } catch (error) {
    return {
      ok: false,
      error: formatEsbuildError(error),
      durationMs: performance.now() - start,
      cacheHit: false,
    };
  }
}

function virtualFs(files: Record<string, string>, aliases: Record<string, string>): esbuild.Plugin {
  return {
    name: 'navroop-virtual-fs',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        // Aliased bare specifiers (next/link, next/image, …) resolve to shim
        // modules in the virtual filesystem: they have no browser-loadable
        // build on esm.sh, so left external the preview dies on import.
        const aliased = aliases[args.path];
        if (aliased && aliased in files) {
          return { path: aliased, namespace: 'vfs' };
        }
        // The entry point arrives with no importer. It is a virtual path, not a
        // package, and marking it external makes esbuild refuse the build.
        if (!args.importer) {
          const entryPath = resolveVirtual(args.path, undefined, files);
          if (entryPath) return { path: entryPath, namespace: 'vfs' };
        }
        // Bare specifiers (react, lucide-react, …) are served by the import
        // map at runtime rather than bundled: esm.sh ships them pre-built and
        // keeping them external is what makes the wasm bundle fast enough to
        // run on every keystroke.
        if (isBareSpecifier(args.path)) {
          return { path: args.path, external: true };
        }
        const resolved = resolveVirtual(args.path, args.importer, files);
        if (!resolved) {
          return {
            errors: [{ text: `Cannot resolve "${args.path}" from "${args.importer || 'entry'}"` }],
          };
        }
        return { path: resolved, namespace: 'vfs' };
      });

      build.onLoad({ filter: /.*/, namespace: 'vfs' }, (args) => ({
        contents: files[args.path],
        loader: loaderFor(args.path),
        resolveDir: '/',
      }));
    },
  };
}

const SOURCE_EXTENSIONS = ['', '.tsx', '.ts', '.jsx', '.js', '.mjs', '.css', '.json'];
const INDEX_EXTENSIONS = ['/index.tsx', '/index.ts', '/index.jsx', '/index.js'];

export function resolveVirtual(
  specifier: string,
  importer: string | undefined,
  files: Record<string, string>,
): string | null {
  const raw = specifier.split('?')[0] || specifier;
  let base: string;
  if (raw.startsWith('@/')) {
    base = raw.slice(2);
  } else if (raw.startsWith('/')) {
    base = raw.replace(/^\/+/, '');
  } else if (raw.startsWith('.')) {
    base = joinVirtual(dirname(importer || ''), raw);
  } else {
    base = raw;
  }
  const normalized = normalizeVirtual(base);
  for (const suffix of [...SOURCE_EXTENSIONS, ...INDEX_EXTENSIONS]) {
    const candidate = `${normalized}${suffix}`;
    if (candidate in files) return candidate;
  }
  // Generated code often writes `src/App` for a file stored as `App.tsx`, and
  // vice versa, so try the path with and without a leading src/.
  const swapped = normalized.startsWith('src/') ? normalized.slice(4) : `src/${normalized}`;
  for (const suffix of [...SOURCE_EXTENSIONS, ...INDEX_EXTENSIONS]) {
    const candidate = `${swapped}${suffix}`;
    if (candidate in files) return candidate;
  }
  return null;
}

function isBareSpecifier(specifier: string) {
  // `vfs:` paths are already-resolved virtual modules, not package names.
  return !specifier.startsWith('vfs:') && !isLocalPreviewSpecifier(specifier);
}

function loaderFor(path: string): esbuild.Loader {
  if (path.endsWith('.tsx')) return 'tsx';
  if (path.endsWith('.ts')) return 'ts';
  if (path.endsWith('.jsx')) return 'jsx';
  if (path.endsWith('.css')) return 'css';
  if (path.endsWith('.json')) return 'json';
  return 'js';
}

function dirname(path: string) {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

function joinVirtual(dir: string, relative: string) {
  return normalizeVirtual(dir ? `${dir}/${relative}` : relative);
}

export function normalizeVirtual(path: string) {
  const parts: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

function joinOutputs(outputs: esbuild.OutputFile[] | undefined, extension: string) {
  return (outputs ?? [])
    .filter((file) => file.path.endsWith(extension))
    .map((file) => file.text)
    .join('\n');
}

/**
 * The message a reader sees. `vfs:` is stripped here, at the single boundary
 * where esbuild's words become ours: it is the namespace of our own virtual
 * filesystem plugin and names nothing in the project, and the pane put
 * `No matching export in "vfs:lib/data.ts" for import "site"` in front of a user.
 */
function formatEsbuildError(error: unknown): string {
  if (error && typeof error === 'object' && 'errors' in error && Array.isArray(error.errors)) {
    // A rejected build is a BuildFailure, whose `errors` are esbuild Messages.
    const messages: esbuild.Message[] = error.errors;
    if (messages.length > 0) {
      return stripPreviewScheme(
        messages
          .map((entry) => {
            const where = entry.location?.file
              ? ` (${entry.location.file}${entry.location.line ? `:${entry.location.line}` : ''})`
              : '';
            return `${entry.text || 'Build error'}${where}`;
          })
          .join('\n'),
      );
    }
  }
  return stripPreviewScheme(error instanceof Error ? error.message : String(error));
}

function stableKey(files: Record<string, string>, entry: string, aliases: Record<string, string>) {
  return JSON.stringify({
    entry,
    aliases: Object.keys(aliases)
      .sort()
      .map((key) => [key, aliases[key]]),
    files: Object.keys(files)
      .sort()
      .map((path) => [path, files[path]]),
  });
}

function cache() {
  globalThis.__navroopBundleCache ??= new Map();
  return globalThis.__navroopBundleCache;
}

function readCache(key: string) {
  const store = cache();
  const hit = store.get(key);
  if (!hit) return null;
  // Refresh LRU position.
  store.delete(key);
  store.set(key, hit);
  return hit;
}

function writeCache(key: string, value: { code: string; css: string }) {
  const store = cache();
  store.set(key, value);
  while (store.size > BUNDLE_CACHE_LIMIT) {
    const oldest = store.keys().next().value;
    if (!oldest) break;
    store.delete(oldest);
  }
}
