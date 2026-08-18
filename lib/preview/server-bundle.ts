import * as esbuild from 'esbuild';
import { assemblePreview } from './assemble';
import { buildPreviewSrcdoc } from './html';

/**
 * Server-side twin of the in-browser preview bundler.
 *
 * The live preview compiles with esbuild-wasm in the user's tab; a published
 * build needs the same output as real files on disk. Same esbuild version,
 * same virtual filesystem, same esm.sh import map — so what a user approves in
 * the preview is what gets deployed.
 */

export type StaticBuildResult =
  { ok: true; files: Record<string, string> } | { ok: false; error: string };

export async function buildStaticSite(
  stack: string,
  projectFiles: Record<string, string>,
): Promise<StaticBuildResult> {
  const assembly = assemblePreview(stack, projectFiles);

  if (assembly.kind === 'empty') {
    return { ok: false, error: assembly.reason };
  }

  if (assembly.kind === 'html') {
    // Static projects ship as-is; their assets are already relative files.
    return { ok: true, files: { ...projectFiles, 'index.html': assembly.html } };
  }

  try {
    const result = await esbuild.build({
      entryPoints: [assembly.entry],
      bundle: true,
      write: false,
      outfile: '/assets/app.js',
      format: 'esm',
      target: 'es2022',
      jsx: 'automatic',
      minify: true,
      sourcemap: false,
      logLevel: 'silent',
      legalComments: 'none',
      define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [virtualFsPlugin(assembly.files, assembly.aliases)],
    });

    const code = joinOutputs(result.outputFiles, '.js');
    const css = joinOutputs(result.outputFiles, '.css');
    return {
      ok: true,
      files: {
        'index.html': buildPreviewSrcdoc({ code, css }),
      },
    };
  } catch (error) {
    return { ok: false, error: formatBuildError(error) };
  }
}

function virtualFsPlugin(
  files: Record<string, string>,
  aliases: Record<string, string>,
): esbuild.Plugin {
  return {
    name: 'navroop-virtual-fs',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const aliased = aliases[args.path];
        if (aliased && aliased in files) return { path: aliased, namespace: 'vfs' };
        if (!args.importer) {
          const entry = resolveVirtual(args.path, undefined, files);
          if (entry) return { path: entry, namespace: 'vfs' };
        }
        if (isBare(args.path)) return { path: args.path, external: true };
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

const EXTENSIONS = ['', '.tsx', '.ts', '.jsx', '.js', '.mjs', '.css', '.json'];
const INDEXES = ['/index.tsx', '/index.ts', '/index.jsx', '/index.js'];

function resolveVirtual(
  specifier: string,
  importer: string | undefined,
  files: Record<string, string>,
): string | null {
  const raw = specifier.split('?')[0] || specifier;
  let base: string;
  if (raw.startsWith('@/')) base = raw.slice(2);
  else if (raw.startsWith('/')) base = raw.replace(/^\/+/, '');
  else if (raw.startsWith('.')) base = normalize(`${dirname(importer || '')}/${raw}`);
  else base = raw;

  const normalized = normalize(base);
  for (const suffix of [...EXTENSIONS, ...INDEXES]) {
    if (`${normalized}${suffix}` in files) return `${normalized}${suffix}`;
  }
  const swapped = normalized.startsWith('src/') ? normalized.slice(4) : `src/${normalized}`;
  for (const suffix of [...EXTENSIONS, ...INDEXES]) {
    if (`${swapped}${suffix}` in files) return `${swapped}${suffix}`;
  }
  return null;
}

function isBare(specifier: string) {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('@/');
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

function normalize(path: string) {
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

function formatBuildError(error: unknown): string {
  if (error && typeof error === 'object' && 'errors' in error) {
    const errors = (error as { errors?: Array<{ text?: string }> }).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      return errors.map((row) => row.text ?? 'Build error').join('\n');
    }
  }
  return error instanceof Error ? error.message : String(error);
}
