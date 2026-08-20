import { describe, expect, it } from 'vitest';
import { RunUsage } from '@/lib/consumption/run-usage';
import { CHARS_PER_TOKEN, estimateTokens } from '@/lib/generation/token-estimate';

/**
 * Every provider call in one generation costs money, and the route used to
 * record exactly one of them.
 *
 * `result` was assigned to the main stream and the usage read was
 * `await result?.usage`, so the corrective ask — a full second generation with
 * the whole message list plus 2 000 characters of echo — and every truncation
 * recovery call, one per truncated file, were not counted at all. When the main
 * stream threw, `inputTokens` stayed 0, `outputTokens` stayed undefined, and
 * `recordJobUsage` was handed those: `estimateTokenCostUsd` returned 0 and
 * `accrueSpend` was skipped entirely. The paths that cost the most reported the
 * least, always in the same direction, and `Workspace.spendUsd` — which drives
 * the auto-pause ceiling — under-reported with them (F-027).
 *
 * `RunUsage` is the invariant: announce a call before it is made, settle it when
 * its usage is known, and a call that never settles is still charged from the
 * prompt it uploaded.
 */

const usageOf = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });

describe('RunUsage', () => {
  it('sums the main stream and the corrective ask, not just the first call', () => {
    const run = new RunUsage();

    run.willSend('the first prompt');
    run.settle(usageOf(1200, 400), 'a reply with no files in it');

    // The corrective ask: same message list, plus the echo and the correction.
    run.willSend('the first prompt + echo + correction');
    run.settle(usageOf(1800, 900), '```tsx {path=app/page.tsx}\nexport default null\n```');

    expect(run.totals).toEqual({
      tokensIn: 3000,
      tokensOut: 1300,
      calls: 2,
      estimatedCalls: 0,
    });
  });

  it('counts one recovery call per truncated file', () => {
    const run = new RunUsage();
    run.willSend('main');
    run.settle(usageOf(1000, 5000), 'two truncated files');

    for (const file of ['app/page.tsx', 'app/layout.tsx']) {
      run.willSend(`complete ${file}`);
      run.settle(usageOf(300, 700), 'the completed file');
    }

    expect(run.totals.calls).toBe(3);
    expect(run.totals.tokensIn).toBe(1600);
    expect(run.totals.tokensOut).toBe(6400);
  });

  it('charges an announced call that never settled — a failure still burned the prompt', () => {
    const run = new RunUsage();
    const prompt = 'x'.repeat(8 * CHARS_PER_TOKEN);

    run.willSend(prompt);
    // The provider threw: no usage, no output.
    run.close();

    expect(run.totals.tokensIn).toBe(estimateTokens(prompt));
    expect(run.totals.tokensOut).toBe(0);
    expect(run.totals.calls).toBe(1);
    // Flagged, because an estimate is not a provider reading.
    expect(run.totals.estimatedCalls).toBe(1);
  });

  it('keeps a failed recovery call and still charges the next one', () => {
    const run = new RunUsage();
    run.willSend('main');
    run.settle(usageOf(1000, 200), 'reply');

    // First recovery throws, so it is never settled; announcing the next call
    // closes it by estimate rather than dropping it.
    const failed = 'y'.repeat(4 * CHARS_PER_TOKEN);
    run.willSend(failed);
    run.willSend('second recovery');
    run.settle(usageOf(150, 350), 'completed');
    run.close();

    expect(run.totals.calls).toBe(3);
    expect(run.totals.tokensIn).toBe(1000 + estimateTokens(failed) + 150);
    expect(run.totals.tokensOut).toBe(200 + 350);
    expect(run.totals.estimatedCalls).toBe(1);
  });

  it('estimates from the streamed text when the provider omits output tokens', () => {
    const run = new RunUsage();
    const reply = 'z'.repeat(12 * CHARS_PER_TOKEN);
    run.willSend('prompt');
    run.settle({ inputTokens: 500 }, reply);

    expect(run.totals.tokensIn).toBe(500);
    expect(run.totals.tokensOut).toBe(estimateTokens(reply));
    // The input came from the provider, the output did not.
    expect(run.totals.estimatedCalls).toBe(1);
  });

  it('is a no-op when nothing was ever sent, so a run that never called a provider records zero', () => {
    const run = new RunUsage();
    run.close();
    expect(run.totals).toEqual({ tokensIn: 0, tokensOut: 0, calls: 0, estimatedCalls: 0 });
  });

  it('ignores a settle with no call open rather than inventing one', () => {
    const run = new RunUsage();
    run.settle(usageOf(999, 999), 'orphan');
    expect(run.totals.calls).toBe(0);
    expect(run.totals.tokensIn).toBe(0);
  });

  it('reads promptTokens / completionTokens as well as the v5 names', () => {
    const run = new RunUsage();
    run.willSend('prompt');
    run.settle({ promptTokens: 700, completionTokens: 250 }, 'reply');
    expect(run.totals).toEqual({
      tokensIn: 700,
      tokensOut: 250,
      calls: 1,
      estimatedCalls: 0,
    });
  });

  it('hands the totals to one caller only, so a run cannot be billed twice', () => {
    const run = new RunUsage();
    run.willSend('prompt');
    run.settle(usageOf(800, 200), 'reply');

    // The successful settle bills the run.
    expect(run.claim()).toEqual({
      tokensIn: 800,
      tokensOut: 200,
      calls: 1,
      estimatedCalls: 0,
    });
    // Something after it threw and the catch reached for the same numbers.
    // `accrueSpend` adds unconditionally, so a second write would push the
    // auto-pause ceiling on spend that never happened.
    expect(run.claim()).toBeNull();
    // The totals themselves are still readable — only the right to bill is spent.
    expect(run.totals.tokensIn).toBe(800);
  });

  it('charges an unsettled call before handing the totals over', () => {
    const run = new RunUsage();
    const prompt = 'q'.repeat(6 * CHARS_PER_TOKEN);
    run.willSend(prompt);

    expect(run.claim()).toEqual({
      tokensIn: estimateTokens(prompt),
      tokensOut: 0,
      calls: 1,
      estimatedCalls: 1,
    });
  });
});
