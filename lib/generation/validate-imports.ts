/**
 * Static import/export check over a generated file map.
 *
 * The incident this exists for: a build shipped `app/page.tsx` with
 * `import { site } from '@/lib/data'` while `lib/data.ts` exported something
 * else. Nothing checked it, so the first thing the user saw was the preview
 * bundler's own message — `No matching export in "vfs:lib/data.ts" for import
 * "site"` — in a broken iframe, after being told the build succeeded.
 *
 * Deliberately pure, synchronous and dependency-free: it runs inside the
 * generation route before the `complete` frame, and would run in the browser
 * unchanged. It mirrors the resolution rules of `lib/preview/server-bundle.ts`
 * (`resolveVirtual`) — the same extension/index/`src/` swap ladder — because the
 * only verdict worth predicting is that bundler's.
 *
 * ## What it deliberately does not understand
 *
 * There is no parser here — a real one is not a dependency of this path, and an
 * esbuild pass is the *other* check (`lib/validation/build-check.ts`). This is a
 * scanner over comment-stripped source, so it does not understand:
 *
 * - computed or generated exports (`Object.assign(exports, …)`, `export` inside
 *   a conditional block),
 * - `export * from` chains deeper than {@link MAX_REEXPORT_DEPTH},
 * - CommonJS (`module.exports`) beyond recognising it and going quiet,
 * - which names are types and which are values — type and value exports share
 *   one set, so importing a type as a value is not reported here (`tsc` owns
 *   that).
 *
 * Every one of those gaps is a *miss*, never a false alarm, and that is the
 * trade on purpose: a wrong "invalid" verdict would block a good build and burn
 * a generation rewriting correct code. When in doubt this passes — see
 * {@link mentionsSymbol}, the last-resort guard before any missing-export claim.
 */

export type ImportProblemKind =
  | 'unresolved-import'
  | 'missing-named-export'
  | 'missing-default-export'
  | 'self-import'
  | 'import-cycle';

export type ImportProblem = {
  kind: ImportProblemKind;
  /** Repo-relative path of the file containing the bad import. */
  file: string;
  /** 1-based line of the import statement, when the scanner located it. */
  line: number | null;
  /** The specifier as written, e.g. `@/lib/data`. */
  specifier: string | null;
  /** The imported name, for the two export problems. `default` for a default import. */
  symbol: string | null;
  /** Plain English, naming the file and the symbol. Chat copy and repair copy. */
  message: string;
};

export type ImportValidationResult = {
  /** Problems that stop the bundle. These are what a repair attempt targets. */
  problems: ImportProblem[];
  /**
   * Reported to the user, never used to justify a rewrite: a cycle is legal ESM
   * and the bundler accepts it, so "fixing" it would edit working code.
   */
  warnings: ImportProblem[];
  /** How many in-scope modules were scanned — 0 means the check did nothing. */
  checkedFiles: number;
};

/** Modules whose imports/exports this understands. `.css`/`.json` are opaque. */
const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];

/** Mirrors lib/preview/server-bundle.ts — the resolver whose verdict decides. */
const EXTENSIONS = ['', '.tsx', '.ts', '.jsx', '.js', '.mjs', '.css', '.json'];
const INDEXES = ['/index.tsx', '/index.ts', '/index.jsx', '/index.js'];

/** `export * from` hops followed before the export set is treated as unknown. */
const MAX_REEXPORT_DEPTH = 4;

/** A dozen lines of copy is readable; forty is a wall the user will skip. */
const MAX_PROBLEMS = 12;

export function validateGeneratedImports(input: {
  /**
   * Every file the bundle can see, keyed by repo-relative path — for an edit
   * that means the project's existing files merged with the new ones, or a
   * one-file edit would look like it imported half a missing app.
   */
  files: Record<string, string>;
  /**
   * Paths to report on, normally the files this run generated. Omitted means
   * all of them. A problem in a file the model did not touch is pre-existing and
   * must not fail this build.
   */
  scope?: string[];
}): ImportValidationResult {
  const files = normalizeKeys(input.files);
  const scope = input.scope ? new Set(input.scope.map(normalizePath)) : null;

  const problems: ImportProblem[] = [];
  const warnings: ImportProblem[] = [];
  const exportsCache = new Map<string, ExportSet>();
  const graph = new Map<string, string[]>();
  let checkedFiles = 0;

  for (const path of Object.keys(files)) {
    if (!isCode(path)) continue;
    // A declaration file is erased before anything bundles, and it addresses its
    // siblings the way TypeScript does — `./tokens.js` meaning `./tokens.ts`, a
    // rewrite the preview resolver does not implement. Scanning them would report
    // resolution failures the bundle never sees.
    if (path.endsWith('.d.ts')) continue;
    const inScope = !scope || scope.has(path);
    if (inScope) checkedFiles += 1;

    const edges: string[] = [];
    for (const statement of scanImports(files[path])) {
      // A bare specifier is a dependency question, not a code one: whether
      // `lucide-react` is available is answered by lib/preview/deps.ts, and
      // guessing here would flag `next/image`, which the preview shims.
      if (isBare(statement.specifier)) continue;

      const target = resolveVirtual(statement.specifier, path, files);
      if (!target) {
        if (inScope) {
          problems.push({
            kind: 'unresolved-import',
            file: path,
            line: statement.line,
            specifier: statement.specifier,
            symbol: null,
            message: `${path} imports "${statement.specifier}", but no such file exists in the project.`,
          });
        }
        continue;
      }

      edges.push(target);

      if (target === path) {
        if (inScope) {
          problems.push({
            kind: 'self-import',
            file: path,
            line: statement.line,
            specifier: statement.specifier,
            symbol: null,
            message: `${path} imports "${statement.specifier}", which is itself.`,
          });
        }
        continue;
      }

      // A dynamic import's symbols are read off a promise at runtime, so only
      // its resolution is checkable here.
      if (!inScope || statement.dynamic || !isCode(target)) continue;

      const exported = exportsOf(target, files, exportsCache);
      // `open` means the scanner could not enumerate this module's exports
      // (CommonJS, an unresolvable `export *`, a chain that ran too deep). An
      // unknown export set can never contradict an import.
      if (exported.open) continue;

      if (statement.default && !exported.hasDefault && !mentionsSymbol(files[target], 'default')) {
        problems.push({
          kind: 'missing-default-export',
          file: path,
          line: statement.line,
          specifier: statement.specifier,
          symbol: 'default',
          message: `${path} imports ${target} as a default import, but ${target} has no default export.`,
        });
      }

      for (const name of statement.named) {
        if (exported.names.has(name)) continue;
        if (name === 'default' && exported.hasDefault) continue;
        // The one case where the name being present in the target proves the
        // import wrong rather than the scan: the target's *default* export is
        // declared under exactly this name, so the bundler will report no
        // matching export and the fix is a one-word change at the import.
        if (name === exported.defaultName) {
          problems.push({
            kind: 'missing-named-export',
            file: path,
            line: statement.line,
            specifier: statement.specifier,
            symbol: name,
            message: `${path} imports { ${name} } from "${statement.specifier}", but ${target} exports ${name} as its default export. Import it as \`import ${name} from '${statement.specifier}'\`.`,
          });
          continue;
        }
        // Last-resort guard: the name appears in the target, so the likelier
        // reading is that this scanner missed an export form than that the model
        // forgot to write one. Staying quiet is the cheap price of never
        // blocking a good build.
        if (mentionsSymbol(files[target], name)) continue;
        const verb = statement.reexport ? 're-exports' : 'imports';
        problems.push({
          kind: 'missing-named-export',
          file: path,
          line: statement.line,
          specifier: statement.specifier,
          symbol: name,
          message: `${path} ${verb} { ${name} } from "${statement.specifier}", but ${target} does not export ${name}. ${target} exports: ${describeExports(exported)}.`,
        });
      }
    }

    graph.set(path, edges);
  }

  const cycle = findCycle(graph, scope);
  if (cycle) {
    warnings.push({
      kind: 'import-cycle',
      file: cycle[0],
      line: null,
      specifier: null,
      symbol: null,
      message: `These files import each other in a circle: ${cycle.join(' → ')} → ${cycle[0]}. The bundle still builds, but a value read from a circular import can be undefined at module load.`,
    });
  }

  return { problems: problems.slice(0, MAX_PROBLEMS), warnings, checkedFiles };
}

/** One line for chat and for the job step. */
export function describeImportProblems(result: ImportValidationResult): string {
  const count = result.problems.length;
  if (count === 0) return 'No import problems found.';
  const first = result.problems[0].message;
  if (count === 1) return first;
  return `${first} (+${count - 1} more import problem${count === 2 ? '' : 's'})`;
}

/* ------------------------------------------------------------------ scanning */

export type ImportStatement = {
  specifier: string;
  /** 1-based line of the statement. */
  line: number;
  /** Names read from the target, already unwrapped from `a as b`. */
  named: string[];
  default: boolean;
  /** `export { … } from` — the same check, different wording. */
  reexport: boolean;
  /** `import('x')` — resolution is checkable, the symbols are not. */
  dynamic: boolean;
};

/**
 * `import|export <clause> from "x"`, bare `import "x"`, and `import("x")`.
 *
 * The clause charset excludes `=`, `(`, `)` and `;` on purpose. With a
 * permissive `[\s\S]*?` the scanner matched from an unrelated earlier `export`
 * all the way to the next `from` — so any file with an `export` above its
 * imports had every import misread as one re-export, and lost symbol checking
 * entirely. An import clause only ever contains identifiers, `*`, `,`, braces
 * and whitespace.
 */
const IMPORT_PATTERN =
  /(?:^|[\s;}])(import|export)\s*(type\s+)?([\w$*,{}\s]*?)from\s*['"]([^'"\n]+)['"]|(?:^|[\s;}])import\s*['"]([^'"\n]+)['"]|\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;

export function scanImports(source: string): ImportStatement[] {
  const code = stripCommentsAndStrings(source);
  const statements: ImportStatement[] = [];

  for (const match of code.matchAll(IMPORT_PATTERN)) {
    const specifier = match[4] ?? match[5] ?? match[6];
    if (!specifier) continue;
    // The pattern eats the delimiter before `import`, which for a statement on
    // its own line is the previous line's newline. Report the keyword's line.
    const lead = match[0].length - match[0].replace(/^[\s;}]+/, '').length;
    const line = lineOf(code, (match.index ?? 0) + lead);

    if (match[6] || match[5]) {
      statements.push({
        specifier,
        line,
        named: [],
        default: false,
        reexport: false,
        dynamic: Boolean(match[6]),
      });
      continue;
    }

    const isTypeOnly = Boolean(match[2]);
    const clause = (match[3] ?? '').trim();
    const reexport = match[1] === 'export';
    statements.push({
      specifier,
      line,
      // A re-exported name has to exist in the target exactly as an imported one
      // does — esbuild fails the bundle either way.
      named: namedBindings(clause),
      // A type-only import erases before the bundler sees it, so a missing
      // default there breaks nothing at build time.
      default: !isTypeOnly && !reexport && hasDefaultBinding(clause),
      reexport,
      dynamic: false,
    });
  }

  return statements;
}

/** `{ a, b as c, type D }` → `['a', 'b', 'D']`. `* as ns` and `Default` are not named. */
function namedBindings(clause: string): string[] {
  const braces = clause.match(/\{([\s\S]*)\}/);
  if (!braces) return [];
  const names: string[] = [];
  for (const raw of braces[1].split(',')) {
    const part = raw.trim();
    if (!part) continue;
    // `type X` / `type X as Y` erase before the bundler runs, but the name still
    // has to exist for tsc, and type and value exports share one set here.
    const name = part
      .replace(/^type\s+/, '')
      .split(/\s+as\s+/)[0]
      .trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name) || name === 'default') names.push(name);
  }
  return names;
}

function hasDefaultBinding(clause: string): boolean {
  // Anything before the first `{` or `*` that is a plain identifier.
  const head = clause.split(/[{*]/)[0].replace(/,\s*$/, '').trim();
  return /^[A-Za-z_$][\w$]*$/.test(head);
}

/* ------------------------------------------------------------------- exports */

type ExportSet = {
  names: Set<string>;
  hasDefault: boolean;
  /**
   * The name a `export default function Foo` / `class Foo` declares. Kept because
   * importing that name in braces is the one import mistake the name's presence
   * in the file confirms rather than excuses.
   */
  defaultName: string | null;
  /** True when the export set could not be enumerated with confidence. */
  open: boolean;
};

const NAMED_EXPORT_PATTERNS = [
  /\bexport\s+(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
  /\bexport\s+(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g,
  /\bexport\s+(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  /\bexport\s+(?:declare\s+)?(?:type|interface)\s+([A-Za-z_$][\w$]*)/g,
  /\bexport\s+(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/g,
  /\bexport\s+(?:declare\s+)?namespace\s+([A-Za-z_$][\w$]*)/g,
];

/** `export const { a, b } = x` / `export const [a, b] = x`. */
const DESTRUCTURED_EXPORT = /\bexport\s+(?:const|let|var)\s*([[{])([^\]}]*)[\]}]/g;

/** `export { a, b as c }`, with or without a `from`. */
const EXPORT_CLAUSE = /\bexport\s+(?:type\s+)?\{([^}]*)\}(?:\s*from\s*['"]([^'"\n]+)['"])?/g;

/** `export * from './x'` and `export * as ns from './x'`. */
const STAR_EXPORT = /\bexport\s*\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s*)?from\s*['"]([^'"\n]+)['"]/g;

const DEFAULT_EXPORT = /\bexport\s+default\b/;

/** `export default function Hero()` / `export default class Hero` — named, but default. */
const DEFAULT_DECLARATION =
  /\bexport\s+default\s+(?:async\s+)?(?:function\s*\*?\s*|(?:abstract\s+)?class\s+)([A-Za-z_$][\w$]*)/;

/** Anything CommonJS: enumerating exports from here would be guesswork. */
const COMMONJS = /\bmodule\.exports\b|\bexports\.[A-Za-z_$]/;

function exportsOf(
  path: string,
  files: Record<string, string>,
  cache: Map<string, ExportSet>,
  depth = 0,
): ExportSet {
  const cached = cache.get(path);
  if (cached) return cached;

  const code = stripCommentsAndStrings(files[path] ?? '');
  // Seeded open so a re-export loop resolves to "unknown" instead of recursing
  // forever; the cycle itself is reported separately as a warning.
  cache.set(path, { names: new Set(), hasDefault: true, defaultName: null, open: true });

  if (COMMONJS.test(code)) return cache.get(path) as ExportSet;

  const result: ExportSet = {
    names: new Set(),
    hasDefault: DEFAULT_EXPORT.test(code),
    defaultName: code.match(DEFAULT_DECLARATION)?.[1] ?? null,
    open: false,
  };

  for (const pattern of NAMED_EXPORT_PATTERNS) {
    for (const match of code.matchAll(pattern)) result.names.add(match[1]);
  }
  for (const match of code.matchAll(DESTRUCTURED_EXPORT)) {
    for (const raw of match[2].split(',')) {
      // `{ a: renamed }` exposes `renamed`; `[first]` exposes `first`.
      const name =
        raw
          .split(':')
          .pop()
          ?.replace(/[^\w$]/g, '') ?? '';
      if (name) result.names.add(name);
    }
  }
  for (const match of code.matchAll(EXPORT_CLAUSE)) {
    for (const raw of match[1].split(',')) {
      const part = raw.trim().replace(/^type\s+/, '');
      if (!part) continue;
      const exposed = (part.split(/\s+as\s+/)[1] ?? part).trim();
      if (exposed === 'default') result.hasDefault = true;
      else if (/^[A-Za-z_$][\w$]*$/.test(exposed)) result.names.add(exposed);
    }
  }
  for (const match of code.matchAll(STAR_EXPORT)) {
    const [, alias, specifier] = match;
    if (alias) {
      result.names.add(alias);
      continue;
    }
    // A wildcard re-export means this module's names live somewhere else. If
    // that somewhere cannot be read, every named import through here has to be
    // treated as possibly valid.
    const target = isBare(specifier) ? null : resolveVirtual(specifier, path, files);
    if (!target || !isCode(target) || depth >= MAX_REEXPORT_DEPTH) {
      result.open = true;
      continue;
    }
    const nested = exportsOf(target, files, cache, depth + 1);
    if (nested.open) result.open = true;
    for (const name of nested.names) result.names.add(name);
  }

  cache.set(path, result);
  return result;
}

function describeExports(exported: ExportSet): string {
  const names = [...exported.names].sort();
  if (exported.hasDefault) names.unshift('default');
  return names.length ? names.join(', ') : 'nothing';
}

/**
 * Whether the target file mentions the symbol at all. Used only to *suppress* a
 * finding: if `lib/data.ts` contains the token `site` anywhere, the safe reading
 * is that this scanner missed an export form, not that the model forgot to write
 * one. Word-bounded, so `siteConfig` does not vouch for `site` — which is
 * exactly the shape of the failure that made this file necessary. Names reach
 * here only after matching an identifier pattern, so there is nothing to escape.
 */
function mentionsSymbol(source: string, symbol: string): boolean {
  return new RegExp(`\\b${symbol}\\b`).test(source);
}

/* -------------------------------------------------------------------- cycles */

/**
 * First cycle reachable from the scoped files, as a path of module names.
 * Iterative depth-first search: a generated site is small, but recursion here
 * would be one more way for a check to throw inside the generation route.
 */
function findCycle(graph: Map<string, string[]>, scope: Set<string> | null): string[] | null {
  const state = new Map<string, 'visiting' | 'done'>();

  for (const root of graph.keys()) {
    if (scope && !scope.has(root)) continue;
    if (state.get(root) === 'done') continue;
    const stack: string[] = [root];
    const trail: string[] = [];

    while (stack.length > 0) {
      const path = stack[stack.length - 1];
      if (state.get(path) === 'visiting') {
        state.set(path, 'done');
        stack.pop();
        trail.pop();
        continue;
      }
      if (state.get(path) === 'done') {
        stack.pop();
        continue;
      }
      state.set(path, 'visiting');
      trail.push(path);

      for (const next of graph.get(path) ?? []) {
        if (next === path) continue; // a self-import is reported on its own
        if (state.get(next) === 'visiting') return trail.slice(trail.indexOf(next));
        if (state.get(next) !== 'done') stack.push(next);
      }
    }
  }

  return null;
}

/* ---------------------------------------------------------------- resolution */

function isBare(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('@/');
}

function isCode(path: string): boolean {
  return CODE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/** The same ladder as `resolveVirtual` in lib/preview/server-bundle.ts. */
function resolveVirtual(
  specifier: string,
  importer: string,
  files: Record<string, string>,
): string | null {
  const raw = specifier.split('?')[0] || specifier;
  let base: string;
  if (raw.startsWith('@/')) base = raw.slice(2);
  else if (raw.startsWith('/')) base = raw.replace(/^\/+/, '');
  else {
    const slash = importer.lastIndexOf('/');
    base = `${slash === -1 ? '' : importer.slice(0, slash)}/${raw}`;
  }

  const normalized = normalizePath(base);
  for (const suffix of [...EXTENSIONS, ...INDEXES]) {
    if (`${normalized}${suffix}` in files) return `${normalized}${suffix}`;
  }
  const swapped = normalized.startsWith('src/') ? normalized.slice(4) : `src/${normalized}`;
  for (const suffix of [...EXTENSIONS, ...INDEXES]) {
    if (`${swapped}${suffix}` in files) return `${swapped}${suffix}`;
  }
  return null;
}

function normalizePath(path: string): string {
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

function normalizeKeys(files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    if (typeof content === 'string') out[normalizePath(path)] = content;
  }
  return out;
}

/* ---------------------------------------------------------------- stripping */

/** A string body kept verbatim: short, and shaped like a module specifier. */
const SPECIFIER_SHAPE = /^[@\w./~-]{1,120}$/;

/**
 * Blanks comments and string bodies, preserving offsets so reported line
 * numbers still match the file the user sees. Only bodies that look like a
 * module specifier survive, which is all the scanner reads out of a string.
 *
 * Why this is worth the code: a commented-out `import { Foo } from './gone'`
 * would otherwise be reported as a missing file, and a code sample inside a
 * template literal (generated marketing sites are full of them) would look like
 * a real import. Both are false alarms, the one outcome this module must never
 * produce.
 *
 * Not a lexer: a regex literal is treated as division, so `/['"]/` leaves an
 * unbalanced quote and the scan of the rest of the file degrades. That direction
 * is safe — it hides imports and exports rather than inventing them — and
 * `mentionsSymbol` covers the case where the hidden thing was an export.
 */
export function stripCommentsAndStrings(source: string): string {
  let out = '';
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        out += ' ';
        index += 1;
      }
      continue;
    }

    if (char === '/' && next === '*') {
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        out += source[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      out += index < source.length ? '  ' : '';
      index += 2;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      index += 1;
      const start = index;
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        if (source[index] === quote) break;
        index += 1;
      }
      const body = source.slice(start, Math.min(index, source.length));
      // The specifier patterns need the delimiters, so the quotes survive.
      out += quote;
      out += SPECIFIER_SHAPE.test(body) ? body : body.replace(/[^\n]/g, ' ');
      if (index < source.length) {
        out += quote;
        index += 1;
      }
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index && cursor < source.length; cursor += 1) {
    if (source[cursor] === '\n') line += 1;
  }
  return line;
}
