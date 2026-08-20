/**
 * Two ways a run could hang or lie about why it stopped.
 *
 * F-030: `PROVIDER_ATTEMPT_TIMEOUT_MS` bounds only `start` — the call that returns the lazy
 * stream handle. `collect` (the `for await` over `textStream`) was untimed, so a provider
 * that accepted the request and then went quiet held the request handler, the
 * provider-queue slot and the project lock until the 20-minute job reaper — and the
 * reaper only fires on a stale heartbeat, which a `setInterval` never produces.
 * F-031: with a single-provider chain, one tripped breaker skipped the only entry, the loop
 * ended with `tried === 0`, and the throw carried the initial `lastError` — "No healthy
 * provider is configured", classified `unavailable` → `provider_error` → "The AI service
 * did not respond". Every generation in the installation failed for five minutes behind a
 * message that named neither the cause nor the fact that it clears on its own.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CircuitOpenError, circuitOpenMessage, createCircuitBreaker } from '@/lib/ai/circuit';
import { StreamStalledError } from '@/lib/ai/empty-completion';
import { jobErrorCodeForProviderFailure, providerFailureMessage } from '@/lib/ai/failover';
import { offersRecoveryRetry, recoveryCauseLine } from '@/lib/jobs/copy';
import { JOB_TIMEOUT_MS } from '@/lib/jobs/poll';
import {
  executeWithCompletionFailover,
  executeWithFailover,
  ProviderRunError,
  STREAM_IDLE_TIMEOUT_MS,
} from '@/lib/ai/run';
import type { ProviderEntry } from '@/lib/ai/providers';

const soleProvider: ProviderEntry[] = [
  { provider: 'deepseek', model: 'deepseek-v4', apiKeyEnv: 'DEEPSEEK_API_KEY' },
];

afterEach(() => {
  vi.useRealTimers();
});

describe('an open breaker is not an outage and not a misconfiguration (F-031)', () => {
  it('reports the remaining rest time instead of "no healthy provider is configured"', async () => {
    const clock = 1_000_000;
    const circuit = createCircuitBreaker({ now: () => clock });
    for (let i = 0; i < 5; i += 1) circuit.recordFailure('deepseek');
    expect(circuit.isHealthy('deepseek')).toBe(false);

    const called: string[] = [];
    const failure = await executeWithFailover(
      soleProvider,
      async (entry) => {
        called.push(entry.provider);
        return { text: 'ok' };
      },
      { circuit, now: () => new Date(clock) },
    ).catch((error: unknown) => error);

    expect(called).toEqual([]);
    expect(failure).toBeInstanceOf(ProviderRunError);
    const cause = (failure as ProviderRunError).causeError;
    expect(cause).toBeInstanceOf(CircuitOpenError);
    expect((cause as CircuitOpenError).retryAfterMs).toBeGreaterThan(0);
    expect((cause as CircuitOpenError).message).not.toMatch(/no healthy provider/i);
  });

  it('carries its own job error code and copy that says when to retry', () => {
    const error = new CircuitOpenError('deepseek', 4 * 60_000);
    expect(jobErrorCodeForProviderFailure(error)).toBe('provider_resting');
    expect(providerFailureMessage(error)).toBe(error.message);
    expect(error.message.toLowerCase()).not.toMatch(/did not respond|is down|configured/);
    expect(error.message).toMatch(/minute/);

    const line = recoveryCauseLine('provider_resting');
    expect(line.length).toBeGreaterThan(0);
    expect(line.toLowerCase()).not.toMatch(/did not respond/);
    // It clears on its own, so Try again is the right button to keep.
    expect(offersRecoveryRetry({ kind: 'BUILD', errorCode: 'provider_resting' })).toBe(true);
  });

  it('rounds the wait up to whole minutes so it never says "in 0 minutes"', () => {
    expect(circuitOpenMessage(1)).toMatch(/1 minute\b/);
    expect(circuitOpenMessage(60_000)).toMatch(/1 minute\b/);
    expect(circuitOpenMessage(61_000)).toMatch(/2 minutes/);
  });

  it('still reports a real failure as a real failure once the breaker closes', async () => {
    let clock = 1_000_000;
    const circuit = createCircuitBreaker({ now: () => clock });
    for (let i = 0; i < 5; i += 1) circuit.recordFailure('deepseek');
    clock += 5 * 60_000 + 1;
    expect(circuit.isHealthy('deepseek')).toBe(true);

    const failure = await executeWithFailover(
      soleProvider,
      async () => {
        throw new Error('connect ETIMEDOUT');
      },
      { circuit, now: () => new Date(clock) },
    ).catch((error: unknown) => error);
    expect((failure as ProviderRunError).causeError).not.toBeInstanceOf(CircuitOpenError);
    expect(jobErrorCodeForProviderFailure((failure as ProviderRunError).causeError)).toBe(
      'provider_error',
    );
  });
});

describe('a stream that goes quiet is cut instead of held (F-030)', () => {
  it('aborts collection after the idle timeout and says the stream stalled', async () => {
    vi.useFakeTimers();
    let abortReason: unknown = null;
    const run = executeWithCompletionFailover(
      soleProvider,
      async (entry, ctx) => ({ provider: entry.provider, signal: ctx.signal }),
      async (started) => {
        // A provider that accepted the request and then never sends a chunk. Only the
        // abort can end this wait — which is the whole point: before the idle bound
        // there was nothing to end it.
        const { promise, reject } = Promise.withResolvers<{ files: string[] }>();
        started.signal.addEventListener('abort', () => {
          abortReason = started.signal.reason;
          reject(started.signal.reason ?? new Error('aborted'));
        });
        return promise;
      },
      (collected) => collected.files.length > 0,
      { circuit: createCircuitBreaker(), idleTimeoutMs: 30_000 },
    );
    const settled = run.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(abortReason).toBeNull();
    await vi.advanceTimersByTimeAsync(2);

    const failure = await settled;
    expect(failure).toBeInstanceOf(ProviderRunError);
    expect((failure as ProviderRunError).causeError).toBeInstanceOf(StreamStalledError);
    expect(abortReason).toBeInstanceOf(StreamStalledError);
    expect(providerFailureMessage((failure as ProviderRunError).causeError)).toMatch(
      /stopped sending/i,
    );
  });

  it('does not cut a slow but live stream — each chunk rearms the timer', async () => {
    vi.useFakeTimers();
    const run = executeWithCompletionFailover(
      soleProvider,
      async (entry) => ({ provider: entry.provider }),
      async (_started, _entry, ctx) => {
        // Six gaps of 20s each: four times the 30s idle bound in total, never in one gap.
        for (let i = 0; i < 6; i += 1) {
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, 20_000);
          await promise;
          ctx.progress();
        }
        return { files: ['app/page.tsx'] };
      },
      (collected) => collected.files.length > 0,
      { circuit: createCircuitBreaker(), idleTimeoutMs: 30_000 },
    );
    await vi.advanceTimersByTimeAsync(6 * 20_000 + 1);

    const result = await run;
    expect(result.result.files).toEqual(['app/page.tsx']);
  });

  it('clears the idle timer once collection finishes', async () => {
    vi.useFakeTimers();
    // A leaked timer would abort the attempt controller after the run had already
    // succeeded — the signal the caller may still be holding.
    let abortedAfterSuccess = false;
    const run = executeWithCompletionFailover(
      soleProvider,
      async (entry, ctx) => {
        ctx.signal.addEventListener('abort', () => {
          abortedAfterSuccess = true;
        });
        return { provider: entry.provider };
      },
      async () => ({ files: ['app/page.tsx'] }),
      (collected) => collected.files.length > 0,
      { circuit: createCircuitBreaker(), idleTimeoutMs: 30_000 },
    );
    await vi.advanceTimersByTimeAsync(0);
    const result = await run;
    expect(result.result.files).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(abortedAfterSuccess).toBe(false);
  });

  it('the route declares a maxDuration that agrees with the job timeout', () => {
    // The generation route had no `maxDuration` at all while the import route next door
    // set 300, so the platform bound and the job's own hard timeout could disagree
    // silently. Next needs a literal in the route, so the two numbers are reconciled here.
    const routeSource = readFileSync(
      path.join(process.cwd(), 'app/api/generate-ai-code-stream/route.ts'),
      'utf8',
    );
    const declared = routeSource.match(/export const maxDuration = (\d+);/);
    expect(declared, 'the route must declare maxDuration').not.toBeNull();
    expect(Number(declared?.[1]) * 1000).toBe(JOB_TIMEOUT_MS);
  });

  it('bounds the run from one place: idle < maxDuration === job timeout', () => {
    // The three timeouts on one run used to be unrelated numbers. The idle bound has to
    // leave room for the rest of the build, and has to be generous enough that a
    // thinking-mode model's silent reasoning phase is not mistaken for a dead stream.
    expect(STREAM_IDLE_TIMEOUT_MS).toBe(JOB_TIMEOUT_MS / 4);
    expect(STREAM_IDLE_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 60_000);
    expect(STREAM_IDLE_TIMEOUT_MS).toBeLessThan(JOB_TIMEOUT_MS);
  });
});
