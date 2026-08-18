import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  RECOVERY_HEADING,
  isKnownJobErrorCode,
  knownJobErrorCodes,
  recoveryCauseLine,
  recoveryHeading,
} from '../../lib/jobs/copy';
import type { JobErrorCode } from '../../lib/jobs/types';

/**
 * `recoveryCauseLine` returns '' for a code it does not know, and the recovery panel then
 * renders its heading with no explanation of what went wrong. These tests pin the full set
 * of codes and reconcile it against every `errorCode` literal written in the source tree,
 * so a code that reaches a user without copy fails here instead of showing them nothing.
 */

// Written out by hand rather than derived from the copy map: a list derived from the thing
// under test could never disagree with it. `satisfies` keeps every entry a real member of
// the union without widening the tuple.
const EXPECTED_CODES = [
  'server_restarted',
  'timeout',
  'provider_error',
  'deploying',
  'cancelled',
  'admin_abandoned',
  'job_cap_exceeded',
  'loop_detected',
  'queue_timeout',
  'client_disconnected',
  'no_files_generated',
  'tool_call_validation_failed',
  'credits_exhausted',
  'plan_failed',
  'settle_write_failed',
  'sandbox_unavailable',
  'snapshot_unreadable',
  'sandbox_list_failed',
  'sandbox_file_unreadable',
  'sandbox_status_unknown',
  'provider_not_configured',
  'provider_quota_exhausted',
  'request_rejected',
  'import_failed',
] as const satisfies readonly JobErrorCode[];

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCANNED_ROOTS = ['lib', 'app', 'components', 'scripts'];
const SCANNED_EXTENSIONS = ['.ts', '.tsx'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.next', 'generated', 'archive']);

/** `errorCode:` in an object literal, a type position or a parameter list. */
const ERROR_CODE_ASSIGNMENT = /errorCode\s*:/g;
/**
 * A call to a helper whose job is to fail or abandon a job — `failJob`, `abandonJob`,
 * `failApplyJob`, `abandonInstanceJobs`. A route helper that takes the code as a
 * positional argument never puts the literal next to an `errorCode:`, which is exactly how
 * `sandbox_unavailable` reached two apply paths without this scan noticing.
 */
const SETTLE_CALL = /\b(?:fail|abandon)[A-Za-z]*Jobs?\s*\(/g;
/** A quoted snake_case literal — the shape every error code uses. */
const SNAKE_CASE_LITERAL = /['"]([a-z][a-z0-9_]*)['"]/g;
/** Enough to cover a multi-line settle call without running away on an unbalanced quote. */
const MAX_CALL_SPAN = 1_000;

function sourceFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...sourceFiles(full));
      continue;
    }
    if (SCANNED_EXTENSIONS.includes(path.extname(entry))) {
      files.push(full);
    }
  }
  return files;
}

/** The source range of a call's arguments, from just past `(` to its matching `)`. */
function argumentSpan(source: string, openIndex: number): string {
  let depth = 1;
  let cursor = openIndex;
  const limit = Math.min(source.length, openIndex + MAX_CALL_SPAN);
  while (cursor < limit && depth > 0) {
    const character = source[cursor];
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    cursor += 1;
  }
  return source.slice(openIndex, cursor);
}

/** Every region of a file where an error code literal could plausibly be written. */
function codeBearingRegions(source: string): Array<{ text: string; offset: number }> {
  const regions: Array<{ text: string; offset: number }> = [];
  // Form one: `errorCode: '…'` — to the end of the line, so a neighbouring `errorMessage`
  // sentence on a later line cannot be mistaken for a code.
  for (const match of source.matchAll(ERROR_CODE_ASSIGNMENT)) {
    const start = match.index + match[0].length;
    const lineEnd = source.indexOf('\n', start);
    regions.push({ text: source.slice(start, lineEnd === -1 ? source.length : lineEnd), offset: start });
  }
  // Form two: a positional argument to a fail/abandon helper, across however many lines
  // the call spans.
  for (const match of source.matchAll(SETTLE_CALL)) {
    const start = match.index + match[0].length;
    regions.push({ text: argumentSpan(source, start), offset: start });
  }
  return regions;
}

/** Every snake_case literal that can reach `GenerationJob.errorCode`, and where from. */
function scanWrittenErrorCodes(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const root of SCANNED_ROOTS) {
    for (const file of sourceFiles(path.join(REPO_ROOT, root))) {
      const source = readFileSync(file, 'utf8');
      const relative = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
      for (const region of codeBearingRegions(source)) {
        for (const match of region.text.matchAll(SNAKE_CASE_LITERAL)) {
          const at = region.offset + match.index;
          const line = source.slice(0, at).split('\n').length;
          const where = `${relative}:${line}`;
          const seen = found.get(match[1]) ?? [];
          if (!seen.includes(where)) found.set(match[1], [...seen, where]);
        }
      }
    }
  }
  return found;
}

describe('job error code copy', () => {
  it('every code in the union has a plain-English cause line', () => {
    for (const code of EXPECTED_CODES) {
      const cause = recoveryCauseLine(code);
      expect(cause, `no cause line for ${code}`).not.toBe('');
      expect(cause, `${code} repeats the recovery heading`).not.toBe(RECOVERY_HEADING);
      for (const kind of ['PLAN', 'BUILD', 'FOLLOWUP', 'IMPORT', 'PUBLISH'] as const) {
        expect(cause, `${code} repeats the ${kind} heading`).not.toBe(recoveryHeading(kind));
      }
    }
  });

  it('the copy map holds exactly the expected codes and nothing more', () => {
    expect(knownJobErrorCodes().slice().sort()).toEqual([...EXPECTED_CODES].sort());
  });

  it('a failed live listing or file read does not claim the build failed', () => {
    expect(recoveryCauseLine('sandbox_list_failed')).toBe(
      'We could not list the files in the live workspace — publish was not started from an older snapshot. Try again',
    );
    expect(recoveryCauseLine('sandbox_file_unreadable')).toBe(
      'We could not read a file from the live workspace — publish was not started with an incomplete site. Try again',
    );
    expect(recoveryCauseLine('sandbox_status_unknown')).toBe(
      'We could not tell whether the live workspace is still running — publish was not started from an older snapshot. Try again',
    );
    for (const code of ['sandbox_list_failed', 'sandbox_file_unreadable', 'sandbox_status_unknown'] as const) {
      const cause = recoveryCauseLine(code);
      expect(cause.toLowerCase()).not.toMatch(/build (failed|did not)/);
      expect(cause.toLowerCase()).not.toContain('ai service');
    }
  });

  it('a snapshot the store could not read does not claim the site was deleted or the build failed', () => {
    const cause = recoveryCauseLine('snapshot_unreadable');
    expect(cause).toBe(
      "We could not read this project's files from storage — try publish again in a few minutes",
    );
    expect(cause.toLowerCase()).not.toContain('deleted');
    expect(cause.toLowerCase()).not.toContain('no files');
    expect(cause.toLowerCase()).not.toMatch(/build (failed|did not)/);
  });

  it('a hard import failure does not claim the AI service failed', () => {
    const cause = recoveryCauseLine('import_failed');
    expect(cause).toBe(
      'The import could not finish — the source page was blocked, rejected, or produced no files.',
    );
    expect(cause.toLowerCase()).not.toMatch(/ai service/);
    expect(cause.toLowerCase()).not.toMatch(/build (failed|did not)/);
  });

  it('the three codes handed over today read as plain English', () => {
    expect(recoveryCauseLine('client_disconnected')).toBe(
      'Your browser disconnected before the build finished',
    );
    expect(recoveryCauseLine('no_files_generated')).toBe(
      'The AI finished without producing any files',
    );
    expect(recoveryCauseLine('tool_call_validation_failed')).toBe(
      'The AI replied in a form we could not use — try again',
    );
  });

  // A lost terminal write means the build may actually have finished, so the copy must not
  // claim it failed and must not mention the write at all.
  it('a lost terminal write tells the reader to reload rather than naming the write', () => {
    const cause = recoveryCauseLine('settle_write_failed');
    expect(cause).toBe(
      'We could not record how this build ended — reload the project, and if your changes are missing, try again',
    );
    for (const jargon of ['settle', 'write', 'job', 'row', 'status']) {
      expect(cause.toLowerCase(), `cause line leaks "${jargon}"`).not.toContain(jargon);
    }
  });

  // Control for the loop above: `recoveryCauseLine` is not simply returning a non-empty
  // string for anything it is handed, so "not ''" is a real assertion.
  it('control: an unknown code still has no cause line', () => {
    expect(recoveryCauseLine('not-a-real-code')).toBe('');
    expect(recoveryCauseLine('')).toBe('');
    expect(recoveryCauseLine(null)).toBe('');
    expect(recoveryCauseLine(undefined)).toBe('');
    expect(isKnownJobErrorCode('not-a-real-code')).toBe(false);
  });

  it('every errorCode literal written in the source tree has copy', () => {
    const written = scanWrittenErrorCodes();
    const missing = [...written.entries()].filter(([code]) => !isKnownJobErrorCode(code));
    expect(
      missing.map(([code, locations]) => `${code} (${locations.join(', ')})`),
      'error codes written to a job with no cause line',
    ).toEqual([]);
  });

  // Control for the scan above: if the walk or the regex broke, it would find nothing and
  // the reconciliation would pass without reading a single line of source.
  it('control: the source scan finds the codes the routes actually write', () => {
    const written = scanWrittenErrorCodes();
    expect(written.size).toBeGreaterThanOrEqual(8);
    for (const code of [
      'client_disconnected',
      'no_files_generated',
      'tool_call_validation_failed',
      'credits_exhausted',
      'plan_failed',
      'queue_timeout',
      'settle_write_failed',
    ]) {
      expect([...written.keys()], `scan did not find ${code}`).toContain(code);
    }
  });

  // Control for form two of the scan. `sandbox_unavailable` is handed to a route-local
  // helper positionally, so it appears nowhere near an `errorCode:`; the first version of
  // this walker read right past it and reported a clean tree. Pin the shape it missed.
  it('control: the scan finds a code passed positionally, not just via errorCode:', () => {
    const locations = scanWrittenErrorCodes().get('sandbox_unavailable') ?? [];
    expect(locations.length, 'positional settle-call scan found nothing').toBeGreaterThanOrEqual(2);
    const applyHits = locations.filter((location) =>
      location.includes('app/api/apply-ai-code-stream/route.ts'),
    );
    expect(applyHits.length, 'apply route no longer writes sandbox_unavailable').toBeGreaterThanOrEqual(
      2,
    );
    expect(
      locations.some((location) => location.includes('app/api/generate-ai-code-stream/route.ts')),
      'generate route must fail the job when ensureSandbox fails',
    ).toBe(true);
  });
});
