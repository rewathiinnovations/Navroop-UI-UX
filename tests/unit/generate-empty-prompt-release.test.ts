import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const readSource = (rel: string) =>
  readFileSync(path.join(fileURLToPath(new URL('../../', import.meta.url)), rel), 'utf8');

const source = readSource('app/api/generate-ai-code-stream/route.ts');
/** The boundary guards moved here out of the handler; the acquisitions did not. */
const intakeSource = readSource('lib/generation/intake.ts');

/**
 * F-001: `if (!prompt)` used to be the LAST setup check, after the credit check, the
 * project lock (with its 60s renew timer), the Job row (RUNNING, credit charged), the
 * provider-queue slot and the job heartbeat — and its bare `return` skipped every
 * cleanup, leaving all five leaked for the life of the process. The guard must run
 * before anything is acquired, and every setup exit must go through one exhaustive,
 * idempotent release.
 */
describe('generate-ai-code-stream validates the prompt before acquiring anything (F-001)', () => {
  it('rejects a missing, non-string or whitespace-only prompt right after the body parse', () => {
    // The guard is `readUserPrompt` (lib/generation/user-prompt.ts), which also bounds
    // the length — see tests/unit/generation-prompt-intake.test.ts for what it accepts.
    // It now runs inside `intakeGenerationRequest` rather than inline in the handler.
    // What matters here is unchanged: it runs before anything is acquired.
    const guardAt = intakeSource.indexOf('readUserPrompt(input.promptInput)');
    expect(guardAt).toBeGreaterThan(0);
    // First in intake, and ahead of the two things intake itself acquires.
    for (const acquisition of ['await checkCredits(', 'await holdProjectLock(']) {
      expect(
        intakeSource.indexOf(acquisition),
        `${acquisition} must come after the prompt guard`,
      ).toBeGreaterThan(guardAt);
    }
    // The handler parses the body, then hands it straight to intake — so the guard
    // still sits after the parse and ahead of the acquisitions left in the route.
    const intakeAt = source.indexOf('await intakeGenerationRequest(');
    expect(intakeAt).toBeGreaterThan(0);
    expect(source.indexOf('await request.json()')).toBeLessThan(intakeAt);
    for (const acquisition of [
      'await createOrReuseJob(',
      'getDefaultProviderQueue().acquire(',
      'beginJobHeartbeat(',
    ]) {
      expect(source.indexOf(acquisition), `${acquisition} must come after intake`).toBeGreaterThan(
        intakeAt,
      );
    }
  });

  it('leaves no late prompt guard behind once the stream machinery starts', () => {
    const streamAt = source.indexOf('new TransformStream()');
    expect(streamAt).toBeGreaterThan(0);
    expect(source.indexOf('Prompt is required', streamAt)).toBe(-1);
  });

  it('routes every early setup exit and the outer catch through one idempotent release', () => {
    const helperAt = source.indexOf('const releaseSetup = async');
    expect(helperAt).toBeGreaterThan(0);
    const helper = source.slice(helperAt, helperAt + 2000);
    // Exhaustive: heartbeat, queue slot, job settle, project lock.
    expect(helper).toMatch(/jobHeartbeat\?\.stop\(\)/);
    expect(helper).toMatch(/providerSlot\?\.release\(\)/);
    expect(helper).toMatch(/failJob\(/);
    expect(helper).toMatch(/releaseGenerationLock\?\.\(\)/);
    // Idempotent: a released flag so a second call is a no-op.
    expect(helper).toMatch(/if \(setupReleased\) return/);
    // Reused-job return, provider-not-configured, queue timeout, and the outer catch
    // all release through it.
    const calls = source.match(/await releaseSetup\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });

  it('never decrements the queue on the timeout path — the waiter never took a slot', () => {
    const timeoutAt = source.indexOf('if (!started.ok)');
    expect(timeoutAt).toBeGreaterThan(0);
    // `release()` decrements the running count unconditionally; the timed-out waiter
    // was removed from the wait list without ever taking a slot, so the handle must be
    // dropped before any cleanup path can call it.
    const block = source.slice(timeoutAt, timeoutAt + 800);
    expect(block).toMatch(/providerSlot = null/);
  });
});
