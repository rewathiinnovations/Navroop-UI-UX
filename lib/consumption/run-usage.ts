import { estimateTokens, readProviderInputTokens } from '@/lib/generation/token-estimate';

/**
 * Tokens spent by every provider call in one generation run.
 *
 * The route used to hold a single `result` handle — the main stream — and read
 * `await result?.usage` once. The corrective ask (a full second generation with
 * the whole message list plus 2 000 characters of echo) and every truncation
 * recovery call (one per truncated file) therefore cost money and reported
 * none, and a main stream that threw left `inputTokens` at 0, so
 * `estimateTokenCostUsd` returned 0 and `accrueSpend` was skipped outright. The
 * most expensive paths reported the least, always downward, and
 * `Workspace.spendUsd` — the auto-pause spend ceiling — under-reported with
 * them (F-027).
 *
 * The contract is two calls per provider call: `willSend` before the request
 * goes out, `settle` once its usage is readable. Anything still open when the
 * run ends is charged from the prompt it uploaded, because a provider that
 * accepted a request and then failed still billed for the prompt. Those calls
 * are counted in `estimatedCalls` so a reader can tell a provider reading from
 * an estimate.
 */

/** Reads the v5 name, the v4 name, and the wire name, like `readProviderInputTokens`. */
export function readProviderOutputTokens(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object') return null;
  const record = usage as Record<string, unknown>;
  const raw = record.outputTokens ?? record.completionTokens ?? record.output_tokens;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
  return Math.round(raw);
}

export type RunUsageTotals = {
  tokensIn: number;
  tokensOut: number;
  /** Provider calls charged, settled or not. */
  calls: number;
  /** Of those, how many carry a character estimate rather than a provider reading. */
  estimatedCalls: number;
};

export class RunUsage {
  private tokensIn = 0;
  private tokensOut = 0;
  private calls = 0;
  private estimatedCalls = 0;
  /** The prompt of the call in flight, kept so a failure can still be charged. */
  private openInputText: string | null = null;
  /** Set by `claim`, so only one caller ever bills this run. */
  private claimed = false;

  /**
   * A provider call is going out with this prompt.
   *
   * Charges any previously-open call first. That is what keeps a recovery loop
   * honest: the call for the first truncated file throws, the loop moves to the
   * second file, and the failed one is charged rather than replaced.
   */
  willSend(inputText: string) {
    this.close();
    this.openInputText = inputText;
  }

  /**
   * The open call's usage is readable. `outputText` is what was streamed, used
   * only when the provider omitted its own count.
   *
   * A settle with nothing open is ignored rather than counted: inventing a call
   * would overstate spend exactly as badly as dropping one understates it.
   */
  settle(usage: unknown, outputText: string) {
    const inputText = this.openInputText;
    if (inputText == null) return;
    this.openInputText = null;

    const reportedIn = readProviderInputTokens(usage);
    const reportedOut = readProviderOutputTokens(usage);
    this.tokensIn += reportedIn ?? estimateTokens(inputText);
    this.tokensOut += reportedOut ?? estimateTokens(outputText);
    this.calls += 1;
    if (reportedIn == null || reportedOut == null) this.estimatedCalls += 1;
  }

  /**
   * Charge an open call that will never settle — the provider threw, the stream
   * was aborted, the run unwound. Idempotent, so the failure path and the happy
   * path can both call it.
   */
  close() {
    const inputText = this.openInputText;
    if (inputText == null) return;
    this.openInputText = null;
    this.tokensIn += estimateTokens(inputText);
    this.calls += 1;
    this.estimatedCalls += 1;
  }

  /**
   * The totals to bill, handed out once.
   *
   * A generation has two places that record usage — the settle after a
   * successful stream, and the catch that reports a failed one — and a run can
   * reach both: the stream finishes, usage is recorded, and something after it
   * throws. `accrueSpend` adds to `Workspace.spendUsd` unconditionally, so
   * billing the same run twice would push the auto-pause ceiling on spend that
   * never happened. Whichever path gets here first owns the write; the other
   * gets null and records nothing.
   */
  claim(): RunUsageTotals | null {
    this.close();
    if (this.claimed) return null;
    this.claimed = true;
    return this.totals;
  }

  get totals(): RunUsageTotals {
    return {
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      calls: this.calls,
      estimatedCalls: this.estimatedCalls,
    };
  }
}
