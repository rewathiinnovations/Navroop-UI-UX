import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  RECOVERY_HEADING,
  isKnownJobErrorCode,
  knownJobErrorCodes,
  offersRecoveryRetry,
  recoveryCauseLine,
  recoveryHeading,
  recoveryNextStepLine,
} from '../../lib/jobs/copy';
import { creditDenialMessage } from '../../lib/plans/messages';
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
  'member_cap_reached',
  'credit_charge_failed',
  'plan_failed',
  'settle_write_failed',
  'sandbox_unavailable',
  'snapshot_unreadable',
  'provider_not_configured',
  'provider_quota_exhausted',
  'provider_resting',
  'request_rejected',
  'repo_conflict',
  'project_lock_lost',
  'import_failed',
  'stack_mismatch',
  'internal_error',
  'project_deleted',
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
/**
 * A helper whose declared return type is `JobErrorCode`: the codes sit in its body, next to
 * no `errorCode:` and inside no settle call. `creditFailureCode` in lib/jobs/lifecycle.ts
 * maps three different throws onto three codes exactly that way, and with only the two
 * forms above the scan found `credits_exhausted` written nowhere in the tree while it was
 * being written from that one function.
 */
const CODE_RETURNING_FUNCTION = /\)\s*:\s*JobErrorCode\b[^{\n;]*\{/g;
/**
 * A quoted snake_case literal — the shape every error code uses — with the comparison
 * operator in front of it, when there is one, in group 1. A compared literal is something
 * the code *reads*, not a code it writes.
 */
const SNAKE_CASE_LITERAL = /(===?|!==?|\bcase\b)?\s*['"]([a-z][a-z0-9_]*)['"]/g;
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

/**
 * The source range a bracket pair encloses, from just past the opener to its match — a
 * call's arguments with `(`/`)`, a function body with `{`/`}`.
 */
function balancedSpan(source: string, openIndex: number, open: string, close: string): string {
  let depth = 1;
  let cursor = openIndex;
  const limit = Math.min(source.length, openIndex + MAX_CALL_SPAN);
  while (cursor < limit && depth > 0) {
    const character = source[cursor];
    if (character === open) depth += 1;
    else if (character === close) depth -= 1;
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
    regions.push({
      text: source.slice(start, lineEnd === -1 ? source.length : lineEnd),
      offset: start,
    });
  }
  // Form two: a positional argument to a fail/abandon helper, across however many lines
  // the call spans.
  for (const match of source.matchAll(SETTLE_CALL)) {
    const start = match.index + match[0].length;
    regions.push({ text: balancedSpan(source, start, '(', ')'), offset: start });
  }
  // Form three: the body of a helper that returns a code, from just past its opening brace.
  for (const match of source.matchAll(CODE_RETURNING_FUNCTION)) {
    const start = match.index + match[0].length;
    regions.push({ text: balancedSpan(source, start, '{', '}'), offset: start });
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
          // A literal being compared is an input, not a code being written: form three's
          // body reads `error.reason === 'member_cap'`, and `member_cap` is a
          // `CreditLimitReason` that never reaches `GenerationJob.errorCode`.
          if (match[1]) continue;
          const code = match[2];
          const at = region.offset + match.index;
          const line = source.slice(0, at).split('\n').length;
          const where = `${relative}:${line}`;
          const seen = found.get(code) ?? [];
          if (!seen.includes(where)) found.set(code, [...seen, where]);
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

  // Control for form two of the scan: a code handed to a helper positionally
  // appears nowhere near an `errorCode:`, and the first walker read straight
  // past that shape.
  it('control: the scan finds a code passed positionally, not just via errorCode:', () => {
    const locations = scanWrittenErrorCodes().get('settle_write_failed') ?? [];
    expect(locations.length, 'positional settle-call scan found nothing').toBeGreaterThanOrEqual(1);
  });

  // Control for form three: the codes the credit paths write are chosen inside a helper
  // that returns `JobErrorCode`, so they sit next to no `errorCode:` and inside no settle
  // call. Without that form the scan reported `credits_exhausted` as written nowhere.
  it('control: the scan finds codes returned from a JobErrorCode helper', () => {
    const written = scanWrittenErrorCodes();
    for (const code of ['credits_exhausted', 'member_cap_reached', 'credit_charge_failed']) {
      expect([...written.keys()], `helper-body scan did not find ${code}`).toContain(code);
    }
    // And the `CreditLimitReason` it compares against is not mistaken for a job code.
    expect([...written.keys()], 'a compared reason was read as a written code').not.toContain(
      'member_cap',
    );
  });

  // A member-cap refusal used to arrive as `credits_exhausted`: the panel replaced the one
  // sentence naming the remedy with "This month's credits are used up" — telling a workspace
  // with thousands of credits left to buy more — and `NO_RETRY_CODES` removed Try-again, the
  // one action that works once an admin raises the cap.
  it('a member-cap refusal shows the recorded remedy and offers a retry', () => {
    const recorded = creditDenialMessage('member_cap');
    expect(recoveryCauseLine('member_cap_reached', recorded)).toBe(recorded);
    expect(recorded).toMatch(/ask an admin/i);
    expect(recoveryCauseLine('member_cap_reached', recorded).toLowerCase()).not.toContain(
      "this month's credits",
    );
    expect(offersRecoveryRetry({ kind: 'BUILD', errorCode: 'member_cap_reached' })).toBe(true);
    expect(recoveryNextStepLine({ kind: 'BUILD', errorCode: 'member_cap_reached' })).toMatch(
      /admin/i,
    );
    expect(
      recoveryNextStepLine({ kind: 'BUILD', errorCode: 'member_cap_reached' }).toLowerCase(),
    ).not.toMatch(/add credits/);
  });

  // Contrast, so the test above is not just asserting "the credit codes are all retryable":
  // a genuinely exhausted workspace keeps its non-retryable buy-credits copy.
  it('control: a workspace-exhausted refusal still suppresses retry and says add credits', () => {
    expect(recoveryCauseLine('credits_exhausted')).toBe("This month's credits are used up");
    expect(offersRecoveryRetry({ kind: 'BUILD', errorCode: 'credits_exhausted' })).toBe(false);
    expect(recoveryNextStepLine({ kind: 'BUILD', errorCode: 'credits_exhausted' })).toMatch(
      /add credits/i,
    );
  });

  // The debit itself failing is not a refusal: nothing ran, so the copy must not claim the
  // credits are gone and must leave Try-again available.
  it('a failed credit charge is retryable and does not claim the credits are gone', () => {
    expect(offersRecoveryRetry({ kind: 'BUILD', errorCode: 'credit_charge_failed' })).toBe(true);
    const cause = recoveryCauseLine('credit_charge_failed');
    expect(cause).toMatch(/try again/i);
    expect(cause.toLowerCase()).not.toContain('used up');
  });

  // Both audit twins filed a deleted project as `provider_error`, so /admin/jobs read
  // "The AI service did not respond" for a row that no longer exists and sent the
  // operator to the provider dashboard (F-821).
  it('a project deleted mid-audit does not blame the AI provider and offers no retry', () => {
    const cause = recoveryCauseLine('project_deleted');
    expect(cause).toMatch(/deleted/i);
    expect(cause).not.toBe(recoveryCauseLine('provider_error'));
    expect(cause.toLowerCase()).not.toContain('ai service');
    expect(offersRecoveryRetry({ kind: 'AUDIT', errorCode: 'project_deleted' })).toBe(false);
  });

  it('neither audit twin still writes provider_error for a missing project row', () => {
    for (const file of ['lib/audit/actions.ts', 'lib/seo/actions.ts']) {
      const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      expect(source, `${file} still files a deleted project as provider_error`).not.toContain(
        "errorMessage: 'Audit did not run'",
      );
      expect(source, `${file} does not write project_deleted`).toContain(
        "errorCode: 'project_deleted'",
      );
    }
  });
});
