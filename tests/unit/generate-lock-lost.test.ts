import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { offersRecoveryRetry, recoveryCauseLine } from '@/lib/jobs/copy';
import { LOCK_LOST_MESSAGE } from '@/lib/projects/lock';

const routePath = path.join(
  fileURLToPath(new URL('../../', import.meta.url)),
  'app/api/generate-ai-code-stream/route.ts',
);
const source = readFileSync(routePath, 'utf8');

/** Source with comments stripped: a "this is gone" assertion must not read the prose. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * F-730: a generation streams for minutes and writes `Project.lastCode` at the end. If the
 * lock's renewal fails for a whole TTL — or another writer takes it — the project becomes
 * acquirable while this run is still holding files in memory. The heartbeat now aborts the
 * hold's `lost` signal; the route has to act on it: stop buying tokens, refuse to persist,
 * and report the run as failed rather than closing with a `complete` frame over a write it
 * never made.
 */
describe('generate-ai-code-stream stops when it loses the project lock (F-730)', () => {
  it('takes the hold’s loss signal and aborts the in-flight provider stream with it', () => {
    expect(code).toMatch(/const lockLost = hold\.lost;/);
    // Same controller the job's `onInactive` aborts, so the provider stream unwinds the
    // same way a Cancel does — the difference is what the catch then reports.
    expect(code).toMatch(/lockLost\.addEventListener\('abort'/);
    expect(code).toMatch(/jobCancelled\.abort\(lockLost\.reason\)/);
  });

  it('refuses to persist before it reaches the settle', () => {
    const guardAt = code.indexOf('if (lockLost.aborted) throw new ProjectLockLostError(');
    expect(guardAt).toBeGreaterThan(0);
    // Ahead of every write this run would otherwise make: the site itself
    // (`settleStreamedGeneration`), the answer-turn settle, and the `complete` frame that
    // tells the client the build landed.
    for (const write of [
      'settleStreamedGeneration({',
      'await succeedJob(generationJob.id, {',
      "type: 'complete',",
    ]) {
      expect(code.indexOf(write), `${write} must come after the lock-loss guard`).toBeGreaterThan(
        guardAt,
      );
    }
  });

  it('reports the loss as a failure, not as the cancel it shares a signal with', () => {
    // The cancel branch returns quietly — the person asked for that stop. A lost lock did
    // not ask for anything, so it must not be absorbed by that branch.
    expect(code).toMatch(/const lostLock = lockLost\.aborted;\s*\n\s*if \(lostLock\) \{/);
    expect(code).toMatch(/\} else if \(jobCancelled\.signal\.aborted\) \{/);
    expect(code).toMatch(/lostLock\s*\?\s*'project_lock_lost'/);
    expect(code).toMatch(/lostLock\s*\?\s*LOCK_LOST_MESSAGE/);
  });

  it('has curated recovery copy, and offers Try again, for the new code', () => {
    expect(recoveryCauseLine('project_lock_lost')).toBe(LOCK_LOST_MESSAGE);
    // Nothing about the request was wrong: whatever took the project is finished by the
    // time the panel is read, so retrying is the remedy.
    expect(
      offersRecoveryRetry({ errorCode: 'project_lock_lost', errorMessage: null, kind: 'BUILD' }),
    ).toBe(true);
  });
});
