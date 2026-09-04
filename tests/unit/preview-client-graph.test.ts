import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import * as esbuild from 'esbuild';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  DESIGN_DIRECTIONS,
  DESIGN_DIRECTION_IDS,
  INTERFACE_QUALITY_BAR,
} from '@/lib/design/directions';

/**
 * The generation prompts are server text. They must not be downloaded, parsed and
 * held in memory by every visitor to `/project/[id]` just so a preview can render.
 *
 * `components/workspace/BrowserPreview.tsx` is a `'use client'` file and calls
 * `assemblePreview`, so everything `lib/preview/assemble.ts` reaches through a
 * *value* import is in the browser bundle. That path exists for one reason — the
 * locked starter kit (`app/globals.css`, `tailwind.config.js`, `cn()` and the eight
 * shadcn/ui primitives) has to be merged under the project's own files or a
 * generated page importing `@/components/ui/button` cannot compile in the frame.
 * The model instructions are not part of that: `toPromptBlock` composes a design
 * direction with `INTERFACE_QUALITY_BAR` into the block a generation request is
 * built from, `lib/stack-prompts/**` is the rest of it, and the vendored
 * ui-ux-pro-max profile tables are ~150 KB of research data the brief selects from
 * on the server. None of it renders anything, and all of it is readable from the
 * client bundle by any signed-in user the moment an edit puts it on this graph.
 *
 * Modelled on `tests/unit/client-import-boundary.test.ts` (and on
 * `no-callable-provider.test.ts`, which models on the same walk) rather than
 * extending it, because the two guards answer different questions and disagree on
 * type-only imports on purpose. That one is about a Turbopack cold-compile 500, so
 * a type-only import of a denylisted server module is still a failure — it is one
 * edit from a value import. This one is about bytes and disclosure, and a type is
 * erased before the bundler sees it, so a `import type` edge is not a hit here.
 *
 * Neither `tsc` nor the rest of Vitest sees this class: the graph is only real
 * once Turbopack builds a browser bundle.
 *
 * The import walk below is the cheap half and it is not sufficient. It records a
 * hit only for a module under one of the denied prefixes or for a *named* import
 * of a prompt-composing export, and `lib/preview/assemble.ts` does neither: it
 * reaches `lib/design/directions.ts` transitively, through `lib/stacks/starter.ts`
 * and `lib/design/tailwind-theme.ts`, and every name it takes there is allowed —
 * `renderTokenCss`, `DEFAULT_DESIGN_DIRECTION`, and `getDirection` until the
 * tokens-only door replaced it. So `hits` was empty and every case here passed
 * while an esbuild bundle of the same entry carried the whole 18-line interface
 * quality bar at byte 115 of 43,182, plus the direction prose. An edge is not the
 * unit; the bytes are. `the preview bundle carries no prompt text` at the bottom
 * of this file bundles the real entries with the bundler the preview itself uses
 * and searches the output, and is the guard that can actually fail.
 */

/** Modules whose whole point is text for the model. None belongs in a bundle. */
const PROMPT_TEXT_MODULES = ['lib/stack-prompts/', 'lib/ui-ux-pro-max/'] as const;

/**
 * Prompt text that shares a module with something the browser legitimately wants.
 * `lib/design/directions.ts` also exports `renderTokenCss`, which the starter kit's
 * stylesheet is written from, so the module itself cannot be denied outright — the
 * two prompt-composing exports are named instead, which is also the unit a bundler
 * tree-shakes at.
 */
const PROMPT_TEXT_SYMBOLS: Record<string, readonly string[]> = {
  'lib/design/directions.ts': ['toPromptBlock', 'INTERFACE_QUALITY_BAR'],
};

/**
 * Every module the preview assembly currently puts in the browser, as an upper
 * bound: the walk may return fewer, never more.
 *
 * The bottom six are the residual this pin exists to shrink and are not what the
 * browser needs. `assemblePreview` reaches them because it calls `withStarterFiles`
 * (`lib/stacks/starter.ts`), which asks the `lib/stacks/templates` barrel for a
 * whole *repo* scaffold and then filters it down to the starter kit — so the two
 * `package.json` / `tsconfig.json` / `vite.config.js` builders, the STATIC_HTML
 * index, the stack definition table and the barrel itself all ride along to produce
 * files the filter immediately discards. `lib/design/directions.ts` is on the list
 * for its nine-value token tables, which the starter kit's stylesheet is written
 * from — those it genuinely needs. The direction prose that used to sit in the
 * same binding as those tables no longer does, so the module being present costs
 * the palettes rather than the model instructions. Module presence cannot say
 * which of the two shipped; the bundle assertions at the bottom of this file are
 * what enforce it.
 *
 * `lib/preview/deps.ts` is there because the assembly now carries the import map
 * its bare specifiers resolve against (`PreviewAssembly.deps`), so the bundler and
 * the served document cannot disagree about which packages exist — a bundle built
 * against a wider set than the frame serves compiles and then fails to load. It is
 * not new weight in the browser: `BrowserPreview.tsx` already reaches that module
 * through `lib/preview/html.ts`, and its only edge is `lib/design/tailwind-theme.ts`,
 * already on this list. It holds pinned version strings and an import-map builder,
 * no model instructions.
 */
const PREVIEW_ASSEMBLY_MODULES = [
  'lib/preview/assemble.ts',
  'lib/preview/labels.ts',
  'lib/preview/deps.ts',
  'lib/stacks/templates/starter-kit.ts',
  // The section layer the starter kit emits. Component source strings only —
  // the same weight and the same kind of content as the primitives beside them,
  // and the preview must ship them for a page that composes a section to render.
  'lib/stacks/templates/sections.ts',
  'lib/design/tailwind-theme.ts',
  // residual — see above
  'lib/design/directions.ts',
  'lib/stacks.ts',
  'lib/stacks/starter.ts',
  'lib/stacks/templates/index.ts',
  'lib/stacks/templates/nextjs.ts',
  'lib/stacks/templates/react.ts',
  'lib/stacks/templates/static-html.ts',
] as const;

const ASSET_EXT = new Set(['.css', '.scss', '.json', '.svg', '.png', '.jpg', '.webp', '.md']);

type Edge = { spec: string; isTypeOnly: boolean; names: string[] };

export type PromptTextHit = { entry: string; reached: string; via: string[]; message: string };

function posix(file: string, cwd: string) {
  return relative(cwd, file).split(sep).join('/');
}

function hasUseServer(source: string): boolean {
  const trimmed = source.trimStart();
  return trimmed.startsWith(`'use server'`) || trimmed.startsWith(`"use server"`);
}

function hasUseClient(source: string): boolean {
  const trimmed = source.trimStart();
  return trimmed.startsWith(`'use client'`) || trimmed.startsWith(`"use client"`);
}

function isTypeOnly(node: ts.ImportDeclaration): boolean {
  if (node.importClause?.isTypeOnly) return true;
  const named = node.importClause?.namedBindings;
  if (!node.importClause?.name && named && ts.isNamedImports(named) && named.elements.length > 0) {
    return named.elements.every((element) => element.isTypeOnly);
  }
  return false;
}

/** Value edges plus the names each one binds — the tree-shaking unit. */
function importEdges(source: string, fileName: string): Edge[] {
  const kind =
    fileName.endsWith('.tsx') || fileName.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const edges: Edge[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const names: string[] = [];
      const bindings = node.importClause?.namedBindings;
      if (node.importClause?.name) names.push(node.importClause.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (!element.isTypeOnly) names.push((element.propertyName ?? element.name).text);
        }
      }
      // A namespace import binds everything the module exports.
      if (bindings && ts.isNamespaceImport(bindings)) names.push('*');
      edges.push({ spec: node.moduleSpecifier.text, isTypeOnly: isTypeOnly(node), names });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const names =
        node.exportClause && ts.isNamedExports(node.exportClause)
          ? node.exportClause.elements
              .filter((element) => !element.isTypeOnly)
              .map((element) => (element.propertyName ?? element.name).text)
          : ['*'];
      edges.push({ spec: node.moduleSpecifier.text, isTypeOnly: node.isTypeOnly, names });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      // A dynamic import is a separate chunk, not a saving: the bytes still ship.
      edges.push({ spec: node.arguments[0].text, isTypeOnly: false, names: ['*'] });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return edges;
}

function resolveLocal(fromFile: string, spec: string, cwd: string): string | null {
  let target = spec;
  if (spec.startsWith('@/')) target = resolve(cwd, spec.slice(2));
  else if (spec.startsWith('.')) target = resolve(dirname(fromFile), spec);
  else return null;
  for (const candidate of [
    target,
    `${target}.ts`,
    `${target}.tsx`,
    `${target}.js`,
    join(target, 'index.ts'),
    join(target, 'index.tsx'),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next resolution
    }
  }
  return null;
}

/**
 * The modules a value-import walk from `entry` puts in a browser bundle, and any
 * prompt text it reaches. Stops at a `'use server'` file for the same reason the
 * sibling guard does: Next compiles those to RPC stubs, so their graph is never
 * shipped.
 */
export function walkBrowserGraph(
  entry: string,
  options: { cwd?: string } = {},
): { modules: string[]; hits: PromptTextHit[] } {
  const cwd = options.cwd ?? process.cwd();
  const entryFile = resolve(cwd, entry);
  const entryRel = posix(entryFile, cwd);
  const seen = new Set<string>();
  const hits: PromptTextHit[] = [];
  const stack: Array<{ file: string; via: string[] }> = [{ file: entryFile, via: [] }];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current.file)) continue;
    seen.add(current.file);
    const source = readFileSync(current.file, 'utf8');
    for (const edge of importEdges(source, current.file)) {
      if (edge.isTypeOnly) continue;
      if (ASSET_EXT.has(extnameOf(edge.spec))) continue;
      const resolved = resolveLocal(current.file, edge.spec, cwd);
      if (!resolved) continue;
      const rel = posix(resolved, cwd);
      const forbiddenSymbols = PROMPT_TEXT_SYMBOLS[rel] ?? [];
      const named = edge.names.filter((name) => name === '*' || forbiddenSymbols.includes(name));
      if (forbiddenSymbols.length > 0 && named.length > 0) {
        for (const name of named) {
          hits.push(hit(entryRel, `${rel} (${name})`, current.via));
        }
      }
      if (PROMPT_TEXT_MODULES.some((prefix) => rel.startsWith(prefix))) {
        hits.push(hit(entryRel, rel, current.via));
        continue;
      }
      if (hasUseServer(readFileSync(resolved, 'utf8'))) continue;
      stack.push({ file: resolved, via: [...current.via, rel] });
    }
  }
  return { modules: [...seen].map((file) => posix(file, cwd)).sort(), hits };
}

function extnameOf(spec: string): string {
  const dot = spec.lastIndexOf('.');
  const slash = spec.lastIndexOf('/');
  return dot > slash ? spec.slice(dot) : '';
}

function hit(entry: string, reached: string, via: string[]): PromptTextHit {
  const chain = via.length > 0 ? ` via ${via.join(' → ')}` : '';
  return { entry, reached, via, message: `Browser graph from ${entry} reaches ${reached}${chain}` };
}

describe('the preview assembly keeps the generation prompts out of the browser', () => {
  it('is pointed at a graph the browser really loads', () => {
    // If the preview stops being assembled from a client component, this guard is
    // measuring nothing and should be retargeted rather than left passing.
    const browserPreview = 'components/workspace/BrowserPreview.tsx';
    expect(hasUseClient(readFileSync(browserPreview, 'utf8'))).toBe(true);
    expect(walkBrowserGraph(browserPreview).modules).toContain('lib/preview/assemble.ts');
  });

  it('reaches no prompt-text module or prompt-composing export', () => {
    expect(walkBrowserGraph('lib/preview/assemble.ts').hits).toEqual([]);
  });

  it('reaches no prompt text from the client component either', () => {
    expect(walkBrowserGraph('components/workspace/BrowserPreview.tsx').hits).toEqual([]);
  });

  it('pins the module set the preview assembly ships, as an upper bound', () => {
    const { modules } = walkBrowserGraph('lib/preview/assemble.ts');
    const unexpected = modules.filter(
      (module) => !(PREVIEW_ASSEMBLY_MODULES as readonly string[]).includes(module),
    );
    expect(unexpected, 'the preview assembly widened its browser graph').toEqual([]);
  });

  it('names a prompt-text module reached through a helper', () => {
    const dir = mkdtempSync(join(tmpdir(), 'navroop-preview-graph-'));
    mkdirSync(join(dir, 'lib', 'stack-prompts'), { recursive: true });
    writeFileSync(join(dir, 'lib', 'stack-prompts', 'nextjs.ts'), `export const PROMPT = 'x';\n`);
    writeFileSync(
      join(dir, 'starter.ts'),
      `import { PROMPT } from './lib/stack-prompts/nextjs';\nexport const s = PROMPT;\n`,
    );
    writeFileSync(
      join(dir, 'assemble.ts'),
      `import { s } from './starter';\nexport const a = s;\n`,
    );
    const { hits } = walkBrowserGraph('assemble.ts', { cwd: dir });
    expect(hits.map((row) => row.message)).toEqual([
      'Browser graph from assemble.ts reaches lib/stack-prompts/nextjs.ts via starter.ts',
    ]);
  });

  it('names a prompt-composing export taken from a module the browser may otherwise use', () => {
    const dir = mkdtempSync(join(tmpdir(), 'navroop-preview-graph-'));
    mkdirSync(join(dir, 'lib', 'design'), { recursive: true });
    writeFileSync(
      join(dir, 'lib', 'design', 'directions.ts'),
      `export const INTERFACE_QUALITY_BAR = 'bar';\nexport function renderTokenCss() { return ''; }\nexport function toPromptBlock() { return INTERFACE_QUALITY_BAR; }\n`,
    );
    writeFileSync(
      join(dir, 'assemble.ts'),
      `import { renderTokenCss, toPromptBlock } from './lib/design/directions';\nexport const a = [renderTokenCss, toPromptBlock];\n`,
    );
    const { hits } = walkBrowserGraph('assemble.ts', { cwd: dir });
    expect(hits.map((row) => row.reached)).toEqual(['lib/design/directions.ts (toPromptBlock)']);
  });

  it('leaves the token renderer alone when it is the only export taken', () => {
    const dir = mkdtempSync(join(tmpdir(), 'navroop-preview-graph-'));
    mkdirSync(join(dir, 'lib', 'design'), { recursive: true });
    writeFileSync(
      join(dir, 'lib', 'design', 'directions.ts'),
      `export const INTERFACE_QUALITY_BAR = 'bar';\nexport function renderTokenCss() { return ''; }\n`,
    );
    writeFileSync(
      join(dir, 'assemble.ts'),
      `import { renderTokenCss } from './lib/design/directions';\nexport const a = renderTokenCss;\n`,
    );
    expect(walkBrowserGraph('assemble.ts', { cwd: dir }).hits).toEqual([]);
  });

  it('treats a namespace import as taking everything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'navroop-preview-graph-'));
    mkdirSync(join(dir, 'lib', 'design'), { recursive: true });
    writeFileSync(
      join(dir, 'lib', 'design', 'directions.ts'),
      `export const INTERFACE_QUALITY_BAR = 'bar';\n`,
    );
    writeFileSync(
      join(dir, 'assemble.ts'),
      `import * as directions from './lib/design/directions';\nexport const a = directions;\n`,
    );
    expect(walkBrowserGraph('assemble.ts', { cwd: dir }).hits).toHaveLength(1);
  });

  it('does not count a type-only edge, which the bundler never sees', () => {
    const dir = mkdtempSync(join(tmpdir(), 'navroop-preview-graph-'));
    mkdirSync(join(dir, 'lib', 'stack-prompts'), { recursive: true });
    writeFileSync(join(dir, 'lib', 'stack-prompts', 'nextjs.ts'), `export type Prompt = string;\n`);
    writeFileSync(
      join(dir, 'assemble.ts'),
      `import type { Prompt } from './lib/stack-prompts/nextjs';\nexport type A = Prompt;\n`,
    );
    expect(walkBrowserGraph('assemble.ts', { cwd: dir }).hits).toEqual([]);
  });

  it('does not follow a Server Action into the prompts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'navroop-preview-graph-'));
    mkdirSync(join(dir, 'lib', 'stack-prompts'), { recursive: true });
    writeFileSync(join(dir, 'lib', 'stack-prompts', 'nextjs.ts'), `export const PROMPT = 'x';\n`);
    writeFileSync(
      join(dir, 'action.ts'),
      `'use server';\nimport { PROMPT } from './lib/stack-prompts/nextjs';\nexport async function run() { return PROMPT; }\n`,
    );
    writeFileSync(
      join(dir, 'assemble.ts'),
      `import { run } from './action';\nexport const a = run;\n`,
    );
    expect(walkBrowserGraph('assemble.ts', { cwd: dir }).hits).toEqual([]);
  });

  it('counts a dynamic import, which is a separate chunk and not a saving', () => {
    const dir = mkdtempSync(join(tmpdir(), 'navroop-preview-graph-'));
    mkdirSync(join(dir, 'lib', 'stack-prompts'), { recursive: true });
    writeFileSync(join(dir, 'lib', 'stack-prompts', 'nextjs.ts'), `export const PROMPT = 'x';\n`);
    writeFileSync(
      join(dir, 'assemble.ts'),
      `export async function a() { return import('./lib/stack-prompts/nextjs'); }\n`,
    );
    expect(walkBrowserGraph('assemble.ts', { cwd: dir }).hits).toHaveLength(1);
  });
});

/**
 * Bundling with the same bundler the preview itself runs — `lib/preview/build.ts` in
 * the tab, `lib/preview/server-bundle.ts` on the server — so what is asserted is a
 * real tree-shaken output rather than an import edge that may or may not carry bytes.
 *
 * It is not Turbopack, which is what actually builds the client chunk Next serves, and
 * that is worth being precise about: esbuild here is a strictly *more* aggressive
 * eliminator than the guarantee we want, so a string it still emits is one no bundler
 * could have dropped, while a string it drops is only strong evidence about the shipped
 * chunk. Turbopack cannot be driven from a unit test; this is the closest honest
 * measurement, and it is the one that caught the quality bar in the first place.
 *
 * `minify` is on because that is how the app ships and because it is the harder case:
 * minification is where dead code goes away, so text that survives it survives
 * everywhere. `alias` reproduces the `@/` path mapping from `tsconfig.json`, and the
 * default `platform: 'browser'` is the right target for a `'use client'` graph. Nothing
 * is written under the repository — `tests/setup/repo-write-guard.global.ts` fails the
 * run on a test that writes its own state.
 *
 * `packages: 'external'` leaves every bare specifier — `react`, `lucide-react`,
 * `esbuild-wasm` — as an unresolved import, which is what makes bundling a real
 * `'use client'` component a few milliseconds rather than an app build. It is safe for
 * what this file asserts because every module that holds prompt text is first-party:
 * `lib/design/directions.ts`, `lib/stack-prompts/**`, `lib/ui-ux-pro-max/**`. Do not
 * reach for it to silence a resolution failure in a first-party module — that would
 * excuse the graph this guard exists to measure. `jsx: 'automatic'` matches the app's
 * `tsconfig.json` and is inert for the `.ts` entries.
 */
async function bundleForBrowser(
  entryFile: string,
  cwd: string,
  options: { packages?: 'external' } = {},
): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [entryFile],
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2022',
    minify: true,
    logLevel: 'silent',
    alias: { '@': cwd },
    absWorkingDir: cwd,
    jsx: 'automatic',
    ...(options.packages ? { packages: options.packages } : {}),
  });
  return result.outputFiles.map((file) => file.text).join('\n');
}

/**
 * Lines long and distinctive enough to be searched for, and free of quote
 * characters.
 *
 * A minifier is free to re-quote a string literal, and re-quoting escapes whatever
 * quote it picked — so a needle containing an apostrophe can miss text that is
 * plainly there. Newlines are the same trap in reverse (a template literal may be
 * emitted as a `\n`-escaped string), which is why the needles are single lines and
 * the haystack has its backslashes stripped before the search.
 */
function searchableLines(text: string, minLength: number): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= minLength && !/['"\\`]/.test(line));
}

/** The needle set for one bundle: single lines, matched against unescaped output. */
function occurrencesIn(bundle: string, needles: readonly string[]): string[] {
  const haystack = bundle.split('\\').join('');
  return needles.filter((needle) => haystack.includes(needle));
}

/**
 * Prose from the direction table that is written for the model, not for the browser.
 * `signature` and `avoidTraps` are instructions in full sentences; `fontPairing` is
 * the type spec the model is told to implement. None of it renders anything.
 */
const DIRECTION_PROSE = DESIGN_DIRECTION_IDS.flatMap((id) => {
  const direction = DESIGN_DIRECTIONS[id];
  return searchableLines(
    [direction.fontPairing, direction.signature, ...direction.avoidTraps].join('\n'),
    30,
  );
});

const QUALITY_BAR_LINES = searchableLines(INTERFACE_QUALITY_BAR, 40);

/**
 * Modules on the preview's browser graph allowed to read a whole direction rather
 * than its palette. Empty, and the emptiness is the assertion.
 *
 * `getDirection` hands back a `DesignDirection`, so its value edge is to
 * `DESIGN_DIRECTIONS` — the record that also holds all six directions' `signature`,
 * `avoidTraps` and `fontPairing`, model instructions no bundler can partially retain.
 * `lib/design/tailwind-theme.ts` was the one entry here: it built `FALLBACK_TOKEN_VALUES`
 * at module scope from `getDirection(DEFAULT_DESIGN_DIRECTION).tokens`, so nine HSL
 * triplets cost every direction's prose. It now calls `getDirectionTokens`, which reads
 * `DIRECTION_TOKENS` and reaches no prose, and this list emptied with it — leaving it
 * naming a module that no longer qualifies would have widened the allowance to a
 * regression nobody had asked for.
 *
 * Kept as a list rather than collapsed into "no module may import `getDirection`"
 * because a module that genuinely has to read a brief on this graph should be named
 * here with its reason, not slipped in.
 */
const WHOLE_DIRECTION_READERS_ON_THE_PREVIEW_GRAPH: readonly string[] = [];

describe('the preview bundle carries no prompt text', () => {
  const cwd = process.cwd();

  /** One throwaway entry per case, so each door into the directions module is bundled alone. */
  function entryImporting(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'navroop-preview-bundle-'));
    const file = join(dir, 'entry.ts');
    writeFileSync(file, body);
    return file;
  }

  it('drops every line of the interface quality bar', async () => {
    // A needle set that quietly emptied would make this pass forever.
    expect(QUALITY_BAR_LINES.length).toBeGreaterThan(5);

    const bundle = await bundleForBrowser(join(cwd, 'lib/preview/assemble.ts'), cwd);
    // …and so would a bundle that failed to reach the starter kit at all. The
    // default direction's background token is the palette the browser legitimately
    // needs, and its presence proves this bundle is the real graph.
    expect(bundle).toContain('60 9% 98%');

    expect(
      occurrencesIn(bundle, QUALITY_BAR_LINES),
      'the model instructions are back in the browser preview bundle',
    ).toEqual([]);
  });

  it('drops the prompt block the quality bar is composed into', async () => {
    const bundle = await bundleForBrowser(join(cwd, 'lib/preview/assemble.ts'), cwd);
    expect(bundle).not.toContain('DESIGN DIRECTION -');
    expect(bundle).not.toContain('Signature element (build the page around this');
  });

  /**
   * The palettes and the prose are one module and two doors, and which door a caller
   * takes decides what a visitor downloads. `lib/stacks/templates/index.ts` — reached
   * from the preview through `lib/stacks/starter.ts` — asked for
   * `getDirection(id).tokens`, a property access whose value edge is to
   * `DESIGN_DIRECTIONS`, where every direction's `signature` and `avoidTraps` also
   * live. It now asks `getDirectionTokens(id)`, which reaches the palettes and
   * nothing else.
   *
   * Bundling the barrel itself would not show this: its scaffolds pull in
   * `lib/design/tailwind-theme.ts`, which still reads a whole direction (see
   * `WHOLE_DIRECTION_READERS_ON_THE_PREVIEW_GRAPH`) and would supply the prose no
   * matter what the barrel does. So each door is bundled on its own, and the pair is
   * asserted together — the `getDirection` case is what proves the needles can find
   * prose that is present, so the `getDirectionTokens` case cannot pass vacuously.
   */
  it('reaches the palettes without the prose through the tokens-only door', async () => {
    expect(DIRECTION_PROSE.length).toBeGreaterThan(10);

    const viaTokens = await bundleForBrowser(
      entryImporting(
        `import { getDirectionTokens } from '@/lib/design/directions';\n` +
          `export const tokens = getDirectionTokens('minimal');\n`,
      ),
      cwd,
    );
    expect(viaTokens).toContain('60 9% 98%');
    expect(
      occurrencesIn(viaTokens, DIRECTION_PROSE),
      'getDirectionTokens is dragging the direction table along again',
    ).toEqual([]);

    const viaDirection = await bundleForBrowser(
      entryImporting(
        `import { getDirection } from '@/lib/design/directions';\n` +
          `export const tokens = getDirection('minimal').tokens;\n`,
      ),
      cwd,
    );
    expect(viaDirection).toContain('60 9% 98%');
    expect(occurrencesIn(viaDirection, DIRECTION_PROSE).length).toBeGreaterThan(10);
  });

  it('names every module on the graph that still reads a whole direction', () => {
    const { modules } = walkBrowserGraph('lib/preview/assemble.ts', { cwd });
    // The import specifier, not a bare mention: `getDirection` also appears in prose
    // in comments that explain why a caller must not use it.
    const takesGetDirection =
      /import\s*\{[^}]*\bgetDirection\b[^}]*\}\s*from\s*['"]@\/lib\/design\/directions['"]/;
    // A pattern that had stopped matching anything would pass this forever, and with
    // the allowance now empty there is no module on the graph left to prove it still
    // works. `lib/stack-prompts/index.ts` is the tree's one production importer of
    // `getDirection` — where the prose is genuinely read, on the server — so it is the
    // control that keeps the regex honest.
    const promptComposer = readFileSync(join(cwd, 'lib/stack-prompts/index.ts'), 'utf8');
    expect(takesGetDirection.test(promptComposer)).toBe(true);

    const readers = modules.filter((module) =>
      takesGetDirection.test(readFileSync(join(cwd, module), 'utf8')),
    );
    const unexpected = readers.filter(
      (module) => !WHOLE_DIRECTION_READERS_ON_THE_PREVIEW_GRAPH.includes(module),
    );
    expect(unexpected, 'a new browser-graph module is reading the direction prose').toEqual([]);
  });

  /**
   * The assembler is where the prompt text arrived, but it is not what the browser
   * loads. `components/workspace/BrowserPreview.tsx` is the `'use client'` entry Next
   * compiles for the tab, and it reaches thirty-odd first-party modules of its own —
   * `lib/generation/**`, `lib/jobs/**`, `lib/preview/**`. A
   * prompt import landing on any of those, or on the component itself, ships to every
   * visitor and appears in no bundle of `lib/preview/assemble.ts`. This is the case that
   * covers them. The assembler case above stays because it is the sharper answer — when
   * both fail, the narrower one names which graph brought the text back.
   */
  it('drops the prompt text from the client entry the browser actually loads', async () => {
    expect(QUALITY_BAR_LINES.length).toBeGreaterThan(5);
    expect(DIRECTION_PROSE.length).toBeGreaterThan(10);

    const bundle = await bundleForBrowser(
      join(cwd, 'components/workspace/BrowserPreview.tsx'),
      cwd,
      { packages: 'external' },
    );
    // The default direction's background token: proof the preview assembly is inside
    // this bundle rather than shaken out of it, which is what would make the two
    // searches below pass while measuring nothing.
    expect(bundle).toContain('60 9% 98%');

    expect(
      occurrencesIn(bundle, QUALITY_BAR_LINES),
      'the model instructions are back in the browser preview bundle',
    ).toEqual([]);
    expect(
      occurrencesIn(bundle, DIRECTION_PROSE),
      'the direction briefs are back in the browser preview bundle',
    ).toEqual([]);
  });
});
