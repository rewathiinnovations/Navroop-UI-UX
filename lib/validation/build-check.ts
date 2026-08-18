import { getStack, type StackId } from '@/lib/stacks';
import type { SandboxRunner } from '@/lib/audit/types';

/**
 * Stack-aware build validation for the post-apply auto-fix loop.
 *
 * Supersedes lib/build-validator.ts, which fetched the preview HTML and looked
 * for `vite-error-overlay` and `id="root"` — signals only REACT produces. NEXTJS
 * is the default stack and would have reported a false pass on every broken
 * build. Running the stack's own build command is the signal that generalizes:
 * it is what actually has to succeed, and it fails loudly with a parseable error.
 */

export type BuildErrorKind = 'missing-package' | 'syntax' | 'type' | 'unknown';

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
  skipReason?: 'no-build-command' | 'no-sandbox';
};

/** Build output can be megabytes; only the tail matters and only some of it. */
const MAX_OUTPUT_CHARS = 20_000;
const MAX_ERRORS = 10;

/** Compilers say this when the build itself failed, not when code merely logs "error". */
const BUILD_FAILED = /Failed to compile|Build failed|error during build|Type error:|SyntaxError|Module not found/i;

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
  if (/cannot find module|failed to resolve import|module not found/i.test(line)) return 'missing-package';
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
    .map((error) => `${error.kind}:${error.file ?? '?'}:${error.message.toLowerCase().replace(/\s+/g, ' ')}`)
    .sort()
    .join('|');
}

export async function checkBuild(input: {
  stack: StackId;
  sandbox: SandboxRunner | null;
}): Promise<BuildCheckResult> {
  const { stack, sandbox } = input;
  const buildCommand = getStack(stack).buildCommand;

  // STATIC_HTML has no build step — there is nothing that can fail to compile.
  if (!buildCommand) {
    return { status: 'skipped', stack, errors: [], missingPackages: [], signature: null, skipReason: 'no-build-command' };
  }
  if (!sandbox) {
    return { status: 'skipped', stack, errors: [], missingPackages: [], signature: null, skipReason: 'no-sandbox' };
  }

  let output: string;
  let succeeded: boolean;
  try {
    const result = await sandbox.runCommand(buildCommand);
    output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    succeeded = result.success !== false && result.exitCode === 0;
  } catch (error) {
    // A sandbox that cannot run a command tells us nothing about the code. Skip
    // rather than fail, so an infrastructure blip never triggers a code rewrite.
    return {
      status: 'skipped',
      stack,
      errors: [],
      missingPackages: [],
      signature: null,
      skipReason: 'no-sandbox',
    };
  }

  if (succeeded && !BUILD_FAILED.test(output)) {
    return { status: 'passed', stack, errors: [], missingPackages: [], signature: null };
  }

  const errors = parseBuildErrors(output);
  // Exit code said failure but nothing parsed — keep it actionable rather than empty.
  if (errors.length === 0) {
    errors.push({ kind: 'unknown', message: `Build command failed: ${buildCommand}`, file: null, line: null });
  }

  return {
    status: 'failed',
    stack,
    errors,
    missingPackages: extractMissingPackages(output),
    signature: buildErrorSignature(errors),
  };
}
