import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROUTE = fileURLToPath(
  new URL('../../app/api/generate-ai-code-stream/route.ts', import.meta.url),
);

function routeSource() {
  return readFileSync(ROUTE, 'utf8');
}

/**
 * The wiring the pure classifiers cannot see.
 *
 * `classifyReplyOutcome` decides what a fileless reply means (covered behaviourally in
 * generation-fileless-reply.test.ts); this file pins that the route acts on that decision —
 * an answer ends the run cleanly, the corrective ask happens at most once, and neither path
 * charges the user again. The route is a 2000-line streaming handler with no seam to invoke
 * in a unit test, so its wiring is asserted on the source, as elsewhere in tests/unit.
 */
describe('a conversational reply ends the turn instead of failing it', () => {
  it('completes the answer turn without an error frame', () => {
    const source = routeSource();
    const branchAt = source.indexOf('if (chatAnswer) {');
    expect(branchAt).toBeGreaterThan(0);
    // The terminal branch: log, the lost-settle guard, one `complete` frame, return.
    const terminalAt = source.indexOf('if (chatAnswer) {', branchAt + 1);
    expect(terminalAt).toBeGreaterThan(branchAt);
    const terminal = source.slice(terminalAt, source.indexOf('if (noChangeReason) {', terminalAt));
    expect(terminal).toMatch(/generation\.chat_answer/);
    expect(terminal).toMatch(/type:\s*'complete'/);
    // An `error` frame is what threw on the client, set `lastError` and drew the recovery
    // panel over a model that had answered correctly. The only one left in this branch
    // belongs to the lost-settle guard, which returns before the completion frame: the
    // answer is in chat but the turn was not recorded, and the workspace has to be told.
    const errorAt = terminal.indexOf("type: 'error'");
    expect(errorAt).toBeGreaterThan(0);
    expect(terminal.slice(0, errorAt)).toMatch(/if \(answerSettleFailure\) \{/);
    expect(terminal.indexOf("type: 'complete'")).toBeGreaterThan(errorAt);
    expect(terminal).toMatch(/\breturn;/);
  });

  it('reports a lost answer settle instead of unwinding it as a provider failure', () => {
    const source = routeSource();
    const settleAt = source.indexOf('await succeedJob(generationJob.id');
    const block = source.slice(settleAt - 200, settleAt + 900);
    // `reportSettleFailure` logs it, records a `settle-job` step and falls back to
    // `ensureJobSettled`; letting it throw instead would describe a database failure with
    // the provider-failure sentence the outer catch produces.
    expect(block).toMatch(/try \{/);
    expect(block).toMatch(/reportSettleFailure\(\{/);
    expect(block).toMatch(/intended:\s*'succeeded'/);
    expect(block).toMatch(/answerSettleFailure =/);
  });

  it('does not record a conversation edit or a generation success for an answer', () => {
    // An answer generated nothing. `trackSuccess` and the ConversationEdit record both sit
    // after the answer branch returns, so neither can claim work that never happened.
    const source = routeSource();
    const terminalAt = source.lastIndexOf('if (chatAnswer) {');
    expect(source.indexOf("trackSuccess('generation.success'")).toBeGreaterThan(terminalAt);
    expect(source.indexOf('const editRecord: ConversationEdit')).toBeGreaterThan(terminalAt);
  });

  it('never charges credits after the model call — the job is charged once, before it', () => {
    const source = routeSource();
    // The only charge in this route: one `markJobRunning({ chargeCredits: true })` on a
    // QUEUED row, before any provider call. The corrective ask and the answer turn are part
    // of that same job, so a retry cannot bill a second time.
    const startCalls = source.match(/await markJobRunning\(/g) ?? [];
    expect(startCalls).toHaveLength(1);
    const startAt = source.indexOf('await markJobRunning(');
    expect(source.slice(startAt, startAt + 200)).toMatch(/chargeCredits:\s*true/);
    expect(source).not.toMatch(/chargeJobCreditsOnce\(/);
    expect(startAt).toBeLessThan(source.indexOf('executeWithCompletionFailover('));
  });
});

describe('the corrective ask for owed files is bounded and visible', () => {
  it('asks at most once, and only when the reply owed files', () => {
    const source = routeSource();
    const askAt = source.indexOf('let askedForFilesAgain = false;');
    expect(askAt).toBeGreaterThan(0);
    const askBlock = source.slice(askAt, source.indexOf('// Extract explanation', askAt));
    // The gate is the classifier, so a question, a greeting or a request for direction can
    // never start a second generation.
    expect(askBlock).toMatch(/classifyReplyOutcome\(\{/);
    expect(askBlock).toMatch(/askedAgain:\s*false,\s*\}\)\s*===\s*'ask_again'/);
    // Nobody listening means nobody to show a build to; the first call is skipped for the
    // same reason.
    expect(askBlock).toMatch(/!clientDisconnected/);
    // Exactly one attempt: the flag is set before the ask and is what the final
    // classification reads, so a second miss is reported instead of asked again.
    expect(askBlock).toMatch(/askedForFilesAgain = true;/);
    expect(source).toMatch(/askedAgain:\s*askedForFilesAgain,/);
  });

  it('tells the user and records the miss on the job', () => {
    const source = routeSource();
    const askAt = source.indexOf('let askedForFilesAgain = false;');
    const askBlock = source.slice(askAt, source.indexOf('// Extract explanation', askAt));
    expect(askBlock).toMatch(/MISSING_FILES_ASKED_AGAIN/);
    expect(askBlock).toMatch(/recordJobStepFailure\(/);
    expect(askBlock).toMatch(/key:\s*'return-files'/);
    // A failed ask is recorded under its own key so it cannot overwrite the miss that
    // prompted it — `recordJobStepFailure` merges by key.
    expect(askBlock).toMatch(/key:\s*'ask-files-again'/);
  });

  it('repeats the prompt’s own fenced contract and keeps the first reply on a miss', () => {
    const source = routeSource();
    const askAt = source.indexOf('let askedForFilesAgain = false;');
    const askBlock = source.slice(askAt, source.indexOf('// Extract explanation', askAt));
    expect(askBlock).toMatch(/MISSING_FILES_CORRECTION/);
    // The reply is adopted only when it actually produced files; otherwise the first reply
    // stands, so a nudged second helping of prose cannot pass as the answer.
    expect(askBlock).toMatch(/if \(correctedFiles\.length > 0\) \{/);
    expect(askBlock).toMatch(/generatedCode = correctedCode;/);
    // Same discipline as the main call: the captured stream error is surfaced, and the
    // per-job token cap still applies to the second stream.
    expect(askBlock).toMatch(/surfaceStreamFailure\(/);
    expect(askBlock).toMatch(/capTracker\.addChunk\(/);
  });
});
