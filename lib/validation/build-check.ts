import { buildStaticSite } from '@/lib/preview/server-bundle';
import type { StackId } from '@/lib/stacks';

/**
 * The bundle half of validation: compiles the generated files with the same
 * esbuild pass the preview and the published site run, and reports what failed.
 *
 * Two earlier versions of this were worse than nothing. lib/build-validator.ts
 * fetched the preview HTML and looked for `vite-error-overlay` / `id="root"` —
 * signals only REACT produces, so NEXTJS (the default stack) reported a false
 * pass on every broken build. Its replacement shelled `npm run build` into a
 * sandbox VM and skipped when there was no sandbox; the sandbox subsystem was
 * then deleted (migration 20260819010000_drop_sandbox_columns), which left a
 * check that skipped every single time while the docs described a working loop.
 * Compiling in-process cannot skip, and it is a truer signal anyway: it is
 * exactly what the user's preview runs.
 *
 * The cheap half runs first — see lib/validation/import-check.ts.
 */

export type BuildErrorKind = 'missing-package' | 'syntax' | 'type' | 'import' | 'unknown';

export type BuildError = {
  kind: BuildErrorKind;
  message: string;
  /** Project-relative when the compiler named one. */
  file: string | null;
  line: number | null;
};

export type BuildCheckResult = {
  status: 'passed' | 'failed' | 'skipped';
  stack: StackId;
  errors: BuildError[];
  /** Installable names — cheaper to install than to re-prompt a model for. */
  missingPackages: string[];
  /** Stable across retries of the same failure. Null when nothing failed. */
  signature: string | null;
  /** Reason a check was skipped, for the job step. */
  skipReason?: 'no-build-command' | 'no-files' | 'checker-unavailable';
};

/** Build output can be megabytes; only the tail matters and only some of it. */
const MAX_OUTPUT_CHARS = 20_000;
const MAX_ERRORS = 10;

/**
 * The bundler itself failing rather than the code failing — a missing or
 * unspawnable esbuild binary. Reported, never treated as a code fault: the
 * previous generation of this check turned an infrastructure gap into a silent
 * pass, and turning it into a *rewrite* would be the same mistake pointed the
 * other way, at the user's credits.
 */
const CHECKER_UNAVAILABLE =
  /spawn|ENOENT|EACCES|EPERM|Cannot find module 'esbuild'|host version|binary/i;

const MISSING_PACKAGE_PATTERNS = [
  /Failed to resolve import ["']([^"']+)["']/g,
  /Cannot find module ["']([^"']+)["']/g,
  /Module not found: Can't resolve ["']([^"']+)["']/g,
  /Package ["']([^"']+)["'] not found/g,
];

/** `./app/page.tsx:12:5` or `src/App.jsx (12:5)` or `at src/App.jsx:12`. */
const LOCATION_PATTERNS = [
  /^\.?\/?([\w./-]+\.[a-z]{2,4}):(\d+)(?::\d+)?/i,
  /([\w./-]+\.[a-z]{2,4})\s*\((\d+)[:,]\d+\)/i,
];

function tail(output: string): string {
  return output.length > MAX_OUTPUT_CHARS ? output.slice(-MAX_OUTPUT_CHARS) : output;
}

/**
 * Relative imports are a code bug, not a missing dependency — installing `./Foo`
 * would fail and burn a retry. Scoped names keep two segments.
 */
export function extractMissingPackages(output: string): string[] {
  const found = new Set<string>();
  for (const pattern of MISSING_PACKAGE_PATTERNS) {
    for (const match of output.matchAll(pattern)) {
      const raw = match[1]?.trim();
      if (!raw || raw.startsWith('.') || raw.startsWith('/') || raw.startsWith('@/')) continue;
      const parts = raw.split('/');
      found.add(raw.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
    }
  }
  return [...found];
}

function locate(line: string): { file: string | null; line: number | null } {
  for (const pattern of LOCATION_PATTERNS) {
    const match = line.match(pattern);
    if (match) return { file: match[1], line: Number(match[2]) || null };
  }
  return { file: null, line: null };
}

function classify(line: string): BuildErrorKind {
  // esbuild's wording for the failure that reached a user: `No matching export
  // in "vfs:lib/data.ts" for import "site"`. Not a missing package — there is
  // nothing to install — so it must not be classified as one.
  if (/no matching export|cannot resolve ["']\.|is not exported/i.test(line)) return 'import';
  if (/cannot find module|failed to resolve import|module not found/i.test(line))
    return 'missing-package';
  if (/syntaxerror|unexpected token|parsing error|unterminated/i.test(line)) return 'syntax';
  if (/type error|ts\d{4}|is not assignable|has no exported member/i.test(line)) return 'type';
  return 'unknown';
}

/**
 * Compilers repeat the same failure across framework layers (webpack, then the
 * page, then the route). Dedupe on message so one bug costs one retry, not three.
 */
export function parseBuildErrors(output: string): BuildError[] {
  const errors: BuildError[] = [];
  const seen = new Set<string>();
  // Next.js — our default stack — prints the location on its own line above the
  // message ("./app/page.tsx:12:5" then "Type error: ..."). Matching only lines
  // that contain "error" would drop every location and leave the fix prompt
  // unable to name a file, so carry the last bare location forward.
  let pendingLocation: { file: string | null; line: number | null } | null = null;

  for (const rawLine of tail(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Progress spinners and summary counts carry no diagnostic value.
    if (/^\s*[-–—]\s*(info|wait|event)/i.test(line) || /^\d+\s+errors?$/i.test(line)) continue;

    const own = locate(line);
    const isDiagnostic = /error|cannot find|not found|failed to resolve|unexpected/i.test(line);

    if (!isDiagnostic) {
      // A line that is *only* a location belongs to the diagnostic that follows.
      if (own.file) pendingLocation = own;
      continue;
    }

    const message = line.replace(/^\s*(×|✕|✗|ERROR:?|\[error\])\s*/i, '').slice(0, 400);
    const key = message.toLowerCase().replace(/\s+/g, ' ');
    if (!message || seen.has(key)) {
      pendingLocation = null;
      continue;
    }
    seen.add(key);

    const location = own.file ? own : (pendingLocation ?? { file: null, line: null });
    pendingLocation = null;

    errors.push({ kind: classify(line), message, ...location });
    if (errors.length >= MAX_ERRORS) break;
  }

  return errors;
}

/**
 * Identity of a failure, not of a run. Two attempts that fail the same way share
 * a signature, which is how the loop knows the model made no progress and stops.
 * Line numbers are excluded: an edit above the fault shifts them without fixing
 * anything, and that must not read as progress.
 */
export function buildErrorSignature(errors: BuildError[]): string | null {
  if (errors.length === 0) return null;
  return errors
    .map(
      (error) =>
        `${error.kind}:${error.file ?? '?'}:${error.message.toLowerCase().replace(/\s+/g, ' ')}`,
    )
    .sort()
    .join('|');
}

/**
 * Compiles the project the same way the preview does — esbuild over the
 * generated files — and reports what failed.
 *
 * This used to shell `npm run build` into a sandbox VM. There is no VM now,
 * and running the real bundler is a truer check anyway: it is exactly what the
 * user's preview and the published build run, so a pass here means the site
 * actually renders rather than that a package manager was happy.
 */
export async function checkBuild(input: {
  stack: StackId;
  files: Record<string, string>;
}): Promise<BuildCheckResult> {
  const { stack, files } = input;

  // STATIC_HTML has no compile step — there is nothing that can fail to build.
  if (stack === 'STATIC_HTML') {
    return {
      status: 'skipped',
      stack,
      errors: [],
      missingPackages: [],
      signature: null,
      skipReason: 'no-build-command',
    };
  }
  if (Object.keys(files).length === 0) {
    return {
      status: 'skipped',
      stack,
      errors: [],
      missingPackages: [],
      signature: null,
      skipReason: 'no-files',
    };
  }

  const built = await buildStaticSite(stack, files);
  if (built.ok) {
    return { status: 'passed', stack, errors: [], missingPackages: [], signature: null };
  }

  const errors = parseBuildErrors(built.error);
  if (errors.length === 0) {
    // Nothing diagnostic in the output and it reads like the toolchain rather
    // than the code: report it as unchecked, not as a fault in the site.
    if (CHECKER_UNAVAILABLE.test(built.error)) {
      return {
        status: 'skipped',
        stack,
        errors: [],
        missingPackages: [],
        signature: null,
        skipReason: 'checker-unavailable',
      };
    }
    errors.push({ kind: 'unknown', message: built.error, file: null, line: null });
  }

  return {
    status: 'failed',
    stack,
    errors,
    missingPackages: extractMissingPackages(built.error),
    signature: buildErrorSignature(errors),
  };
}
