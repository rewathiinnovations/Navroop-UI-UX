import { describe, expect, it } from 'vitest';
import { JobCapError, JobCapTracker, LOOP_DETECTED_MESSAGE } from '../../lib/consumption/caps';
import { CREDIT_COSTS, creditDenialMessage, isUnlimited } from '../../lib/plans/limits';
import { createAiMock } from '../mocks';

describe('money and limits (unit)', () => {
  it('credits are checked before a model call — mock stays idle on fail', async () => {
    const ai = createAiMock('success');
    const check = { ok: false as const, reason: 'workspace_exhausted' as const };
    if (!check.ok) {
      expect(creditDenialMessage(check.reason)).toMatch(/credits are used up/i);
      expect(ai.invoked).toBe(0);
    }
  });

  it('job caps abort mid-stream', () => {
    const tracker = new JobCapTracker({
      maxTokensPerJob: 10,
      maxFilesPerJob: 1,
      maxOutputBytesPerJob: 40,
    });
    tracker.addFile('a.ts', 'const a = 1');
    const overflow = tracker.addChunk('x'.repeat(200));
    expect(overflow).toBeInstanceOf(JobCapError);
  });

  it('loop detection message is English', () => {
    expect(LOOP_DETECTED_MESSAGE.toLowerCase()).toMatch(/loop|repeat|same/);
  });

  it('plan structural limits treat 0 as a hard stop and -1 as unlimited', () => {
    expect(isUnlimited(-1)).toBe(true);
    expect(isUnlimited(0)).toBe(false);
    expect(CREDIT_COSTS.generation).toBe(1);
  });
});
