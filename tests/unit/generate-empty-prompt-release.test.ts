import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const routePath = path.join(
  fileURLToPath(new URL('../../', import.meta.url)),
  'app/api/generate-ai-code-stream/route.ts',
);

const source = readFileSync(routePath, 'utf8');

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
    // The guard is now `readUserPrompt` (lib/generation/user-prompt.ts), which also bounds
    // the length — see tests/unit/generation-prompt-intake.test.ts for what it accepts.
    // What matters here is unchanged: it runs before anything is acquired.
    const guardAt = source.indexOf('readUserPrompt(promptInput)');
    expect(guardAt).toBeGreaterThan(0);
    // The guard sits after the body parse …
    expect(source.indexOf('await request.json()')).toBeLessThan(guardAt);
    // … and ahead of every acquisition in setup order: credits, lock, job row,
    // queue slot, heartbeat.
    for (const acquisition of [
      'await checkCredits(',
      'await holdProjectLock(',
      'await createOrReuseJob(',
      'getDefaultProviderQueue().acquire(',
      'beginJobHeartbeat(',
    ]) {
      const acquisitionAt = source.indexOf(acquisition);
      expect(acquisitionAt, `${acquisition} must come after the prompt guard`).toBeGreaterThan(
        guardAt,
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
