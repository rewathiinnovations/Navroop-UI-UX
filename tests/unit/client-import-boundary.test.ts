import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Turbopack 500s the page when a `'use client'` graph reaches a Node builtin
 * (`node:async_hooks`, `node:dns`) or a server-only module (Prisma, logger).
 * tsc and vitest do not build a browser graph, so this walk is the cheap gate.
 */

const ROOTS = [
  { dir: 'app', minFiles: 20 },
  { dir: 'components', minFiles: 50 },
  // `'use client'` is not a `components/` privilege: hooks and a couple of
  // browser-side lib modules carry the directive too, and until 2026-08-21 the
  // walk never opened either root (F-447).
  { dir: 'hooks', minFiles: 3 },
  { dir: 'lib', minFiles: 1 },
] as const;

const SKIP_DIRS = new Set(['node_modules', '.next', 'coverage', 'dist', 'generated']);

const POLYFILL_NODE = new Set([
  'path',
  'url',
  'buffer',
  'process',
  'querystring',
  'events',
  'util',
  'assert',
  'timers',
  'string_decoder',
  'punycode',
]);

/**
 * Bare (unprefixed) Node builtins. Anything a browser bundle cannot supply
 * belongs here — the `node:` prefixed form is covered by POLYFILL_NODE being
 * the allowlist instead.
 */
const BARE_NODE_ONLY = new Set([
  'async_hooks',
  'child_process',
  'cluster',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'dns/promises',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'perf_hooks',
  'readline',
  'readline/promises',
  'repl',
  'stream',
  'stream/promises',
  'stream/web',
  'timers/promises',
  'tls',
  'trace_events',
  'tty',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
]);

/**
 * Packages that only exist on the server. `resolveLocal` cannot follow a bare
 * specifier into node_modules, so without this list a client file importing a
 * native or secret-bearing package was invisible to the walk (F-447). Exact
 * specifier only: `next-auth/react` and `@ai-sdk/react` are the browser halves
 * of two of these and stay allowed.
 */
const SERVER_ONLY_PACKAGES = new Set([
  '@ai-sdk/openai',
  '@auth/prisma-adapter',
  '@aws-sdk/client-s3',
  '@aws-sdk/lib-storage',
  '@mendable/firecrawl-js',
  '@prisma/client',
  '@sentry/node',
  'archiver',
  'bcryptjs',
  'dotenv',
  'esbuild',
  'lighthouse',
  'next-auth',
  'playwright',
  'prisma',
  'server-only',
  'sharp',
]);

const SERVER_ONLY_FILES = new Set([
  'lib/db.ts',
  'lib/logger.ts',
  'lib/request-context.ts',
  'lib/sandbox/test-run.ts',
  'lib/sandbox/teardown.ts',
  'lib/security/url-guard.ts',
]);

/** Type-only imports of these are still one edit away from a Turbopack 500. */
const TYPE_ONLY_FORBIDDEN = new Set([...SERVER_ONLY_FILES]);

const ASSET_EXT = new Set([
  '.css',
  '.scss',
  '.sass',
  '.json',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.woff',
  '.woff2',
  '.md',
]);

export type ClientImportHit = {
  entry: string;
  reached: string;
  via: string[];
  message: string;
};

function posix(file: string, cwd: string) {
  return relative(cwd, file).split(sep).join('/');
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...tsFiles(full));
      continue;
    }
    if (/\.(tsx?|jsx?)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function hasDirective(source: string, name: 'use client' | 'use server'): boolean {
  const trimmed = source.replace(/^\uFEFF/, '').trimStart();
  return trimmed.startsWith(`'${name}'`) || trimmed.startsWith(`"${name}"`);
}

function hasUseClient(source: string): boolean {
  return hasDirective(source, 'use client');
}

function hasUseServer(source: string): boolean {
  return hasDirective(source, 'use server');
}

type Spec = { spec: string; isTypeOnly: boolean };

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  if (node.importClause?.isTypeOnly) return true;
  const named = node.importClause?.namedBindings;
  if (!node.importClause?.name && named && ts.isNamedImports(named) && named.elements.length > 0) {
    return named.elements.every((element) => element.isTypeOnly);
  }
  return false;
}

function importSpecs(source: string, fileName: string): Spec[] {
  const kind =
    fileName.endsWith('.tsx') || fileName.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const specs: Spec[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push({ spec: node.moduleSpecifier.text, isTypeOnly: isTypeOnlyImport(node) });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push({ spec: node.moduleSpecifier.text, isTypeOnly: node.isTypeOnly });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specs.push({ spec: node.arguments[0].text, isTypeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

function importsServerOnlyPackage(source: string, fileName: string): boolean {
  return importSpecs(source, fileName).some((row) => !row.isTypeOnly && row.spec === 'server-only');
}

function isForbiddenNodeSpec(spec: string): string | null {
  if (spec.startsWith('node:')) {
    const name = spec.slice('node:'.length);
    if (POLYFILL_NODE.has(name)) return null;
    return spec;
  }
  if (BARE_NODE_ONLY.has(spec)) return spec;
  return null;
}

function resolveLocal(fromFile: string, spec: string, cwd: string): string | null {
  let target = spec;
  if (spec.startsWith('@/')) target = resolve(cwd, spec.slice(2));
  else if (spec.startsWith('.')) target = resolve(dirname(fromFile), spec);
  else return null;
  const tries = [
    target,
    `${target}.ts`,
    `${target}.tsx`,
    `${target}.js`,
    `${target}.jsx`,
    join(target, 'index.ts'),
    join(target, 'index.tsx'),
  ];
  for (const candidate of tries) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next resolution
    }
  }
  return null;
}

function hit(entry: string, reached: string, via: string[]): ClientImportHit {
  const chain = via.length > 0 ? ` via ${via.join(' → ')}` : '';
  return {
    entry,
    reached,
    via,
    message: `Client graph from ${entry} reaches ${reached}${chain}`,
  };
}

export function findClientImportBoundaryHits(
  options: { cwd?: string; roots?: string[] } = {},
): ClientImportHit[] {
  const cwd = options.cwd ?? process.cwd();
  const rootDirs = options.roots ?? ROOTS.map((root) => join(cwd, root.dir));
  const files: string[] = [];
  for (const dir of rootDirs) {
    if (!existsSync(dir)) throw new Error(`client import scan root is missing: ${dir}`);
    files.push(...tsFiles(dir));
  }
  const entries = files.filter((file) => hasUseClient(readFileSync(file, 'utf8')));
  const hits: ClientImportHit[] = [];

  for (const entry of entries) {
    const entryRel = posix(entry, cwd);
    const seen = new Set<string>();
    const stack: Array<{ file: string; via: string[] }> = [{ file: entry, via: [] }];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (seen.has(current.file)) continue;
      seen.add(current.file);
      const source = readFileSync(current.file, 'utf8');
      for (const { spec, isTypeOnly } of importSpecs(source, current.file)) {
        if (ASSET_EXT.has(extname(spec))) continue;
        const resolved = resolveLocal(current.file, spec, cwd);
        const rel = resolved ? posix(resolved, cwd) : null;
        if (isTypeOnly) {
          if (rel && TYPE_ONLY_FORBIDDEN.has(rel)) hits.push(hit(entryRel, rel, current.via));
          continue;
        }
        const nodeSpec = isForbiddenNodeSpec(spec);
        if (nodeSpec) {
          hits.push(hit(entryRel, nodeSpec, current.via));
          continue;
        }
        if (SERVER_ONLY_PACKAGES.has(spec) || spec.includes('generated/prisma')) {
          hits.push(hit(entryRel, spec, current.via));
          continue;
        }
        if (!resolved || !rel) continue;
        if (rel.startsWith('generated/') || rel.includes('node_modules/')) {
          hits.push(hit(entryRel, rel, current.via));
          continue;
        }
        const resolvedSource = readFileSync(resolved, 'utf8');
        // Server Actions are compiled as RPC stubs. Following through them is a
        // false positive — Next never puts their Prisma/logger graph in the browser.
        if (hasUseServer(resolvedSource)) continue;
        if (SERVER_ONLY_FILES.has(rel) || importsServerOnlyPackage(resolvedSource, resolved)) {
          hits.push(hit(entryRel, rel, current.via));
          continue;
        }
        stack.push({ file: resolved, via: [...current.via, rel] });
      }
    }
  }
  return hits;
}

function clientEntries(cwd = process.cwd()): string[] {
  const files: string[] = [];
  for (const root of ROOTS) files.push(...tsFiles(join(cwd, root.dir)));
  return files
    .filter((file) => hasUseClient(readFileSync(file, 'utf8')))
    .map((file) => posix(file, cwd));
}

describe('client import boundary', () => {
  const entries = clientEntries();

  it('reaches the client roots it claims to scan', () => {
    for (const root of ROOTS) {
      const inRoot = entries.filter((file) => file.startsWith(`${root.dir}/`));
      expect(inRoot.length, `${root.dir} 'use client' count`).toBeGreaterThan(root.minFiles);
    }
    expect(entries).toContain('components/workspace/ProjectWorkspace.tsx');
    expect(entries).toContain('hooks/useOnline.ts');
    expect(entries).toContain('lib/notify.ts');
  });

  it('keeps every use-client graph off Node builtins, Prisma, and the logger', () => {
    expect(findClientImportBoundaryHits()).toEqual([]);
  });

  it('names the Node builtin when a client file imports one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'navroop-client-boundary-'));
    writeFileSync(
      join(dir, 'Page.tsx'),
      `'use client';\nimport { resolve } from 'node:dns';\nexport const x = resolve;\n`,
    );
    const hits = findClientImportBoundaryHits({ cwd: dir, roots: [dir] });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.reached).toBe('node:dns');
    expect(hits[0]?.message).toBe('Client graph from Page.tsx reaches node:dns');
  });

  it('names an unprefixed Node builtin the browser cannot supply', () => {
    const dir = mkdtempSync(join(tmpdir(), 'navroop-client-boundary-'));
    for (const spec of ['crypto', 'os', 'zlib', 'worker_threads']) {
      writeFileSync(
        join(dir, `Uses-${spec.replace('/', '-')}.tsx`),
        `'use client';\nimport * as mod from '${spec}';\nexport const x = mod;\n`,
      );
    }
    const hits = findClientImportBoundaryHits({ cwd: dir, roots: [dir] });
    expect(hits.map((row) => row.reached).sort()).toEqual([
      'crypto',
      'os',
      'worker_threads',
      'zlib',
    ]);
  });

  it('names a server-only package a client file imports directly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'navroop-client-boundary-'));
    writeFileSync(
      join(dir, 'Page.tsx'),
      `'use client';\nimport sharp from 'sharp';\nexport const x = sharp;\n`,
    );
    const hits = findClientImportBoundaryHits({ cwd: dir, roots: [dir] });
    expect(hits.map((row) => row.message)).toEqual(['Client graph from Page.tsx reaches sharp']);
  });

  it('names a server-only package reached through a local helper', () => {
    const dir = mkdtempSync(join(tmpdir(), 'navroop-client-boundary-'));
    writeFileSync(
      join(dir, 'hash.ts'),
      `import bcrypt from 'bcryptjs';\nexport const hash = bcrypt.hashSync;\n`,
    );
    writeFileSync(
      join(dir, 'Page.tsx'),
      `'use client';\nimport { hash } from './hash';\nexport const x = hash;\n`,
    );
    const hits = findClientImportBoundaryHits({ cwd: dir, roots: [dir] });
    expect(hits.map((row) => row.message)).toEqual([
      'Client graph from Page.tsx reaches bcryptjs via hash.ts',
    ]);
  });

  it('leaves the browser half of a split package alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'navroop-client-boundary-'));
    writeFileSync(
      join(dir, 'Page.tsx'),
      `'use client';\nimport { signIn } from 'next-auth/react';\nimport { useChat } from '@ai-sdk/react';\nexport const x = [signIn, useChat];\n`,
    );
    expect(findClientImportBoundaryHits({ cwd: dir, roots: [dir] })).toEqual([]);
  });

  it('does not follow a type-only Prisma import', () => {
    const dir = mkdtempSync(join(tmpdir(), 'navroop-client-boundary-'));
    mkdirSync(join(dir, 'generated', 'prisma'), { recursive: true });
    writeFileSync(join(dir, 'generated', 'prisma', 'index.ts'), `export type Stack = 'NEXTJS';\n`);
    writeFileSync(
      join(dir, 'types.ts'),
      `import type { Stack } from './generated/prisma';\nexport type Row = { stack: Stack };\n`,
    );
    writeFileSync(
      join(dir, 'Page.tsx'),
      `'use client';\nimport type { Row } from './types';\nexport type Props = { row: Row };\n`,
    );
    expect(findClientImportBoundaryHits({ cwd: dir, roots: [dir] })).toEqual([]);
  });

  it('names a type-only import of a server-only module', () => {
    const dir = mkdtempSync(join(tmpdir(), 'navroop-client-boundary-'));
    mkdirSync(join(dir, 'lib', 'sandbox'), { recursive: true });
    writeFileSync(join(dir, 'lib', 'sandbox', 'test-run.ts'), `export const run = {};\n`);
    writeFileSync(
      join(dir, 'Page.tsx'),
      `'use client';\nimport type { run } from './lib/sandbox/test-run';\nexport type T = typeof run;\n`,
    );
    const hits = findClientImportBoundaryHits({ cwd: dir, roots: [dir] });
    expect(hits.map((row) => row.message)).toEqual([
      'Client graph from Page.tsx reaches lib/sandbox/test-run.ts',
    ]);
  });

  it('does not follow a Server Action into Node builtins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'navroop-client-boundary-'));
    writeFileSync(
      join(dir, 'action.ts'),
      `'use server';\nimport { resolve } from 'node:dns';\nexport async function run() { return resolve('example.com'); }\n`,
    );
    writeFileSync(
      join(dir, 'Page.tsx'),
      `'use client';\nimport { run } from './action';\nexport const x = run;\n`,
    );
    expect(findClientImportBoundaryHits({ cwd: dir, roots: [dir] })).toEqual([]);
  });

  it('names the server module when a client file reaches the logger through a helper', () => {
    const dir = mkdtempSync(join(tmpdir(), 'navroop-client-boundary-'));
    mkdirSync(join(dir, 'lib'));
    writeFileSync(join(dir, 'lib', 'logger.ts'), `export const log = {};\n`);
    writeFileSync(join(dir, 'helper.ts'), `import { log } from './lib/logger';\nexport { log };\n`);
    writeFileSync(
      join(dir, 'Page.tsx'),
      `'use client';\nimport { log } from './helper';\nexport const x = log;\n`,
    );
    // mkdir for lib
    const hits = findClientImportBoundaryHits({ cwd: dir, roots: [dir] });
    expect(hits.map((row) => row.message)).toEqual([
      'Client graph from Page.tsx reaches lib/logger.ts via helper.ts',
    ]);
  });
});
