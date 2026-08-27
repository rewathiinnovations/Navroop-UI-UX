import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createCircuitBreaker } from '../../lib/ai/circuit';
import { executeWithCompletionFailover, executeWithFailover } from '../../lib/ai/run';
import type { ProviderEntry } from '../../lib/ai/providers';

const routePath = path.join(
  fileURLToPath(new URL('../../', import.meta.url)),
  'app/api/generate-ai-code-stream/route.ts',
);

const routeSource = readFileSync(routePath, 'utf8');

const twoProviders: ProviderEntry[] = [
  { id: 'google', provider: 'google', model: 'gemini-2.5-flash', apiKeyEnv: 'GEMINI_API_KEY' },
  { id: 'openai', provider: 'openai', model: 'gpt-4o-mini', apiKeyEnv: 'OPENAI_API_KEY' },
];

/**
 * F-022: Cancel / Start over flips the Job row, but nothing aborted the in-flight
 * provider stream — tokens and spend continued to the end. The run needs an external
 * cancellation signal that reaches the provider-facing AbortSignal mid-collection,
 * and a cancel must be neither a failover (next vendor retries the cancelled work)
 * nor a circuit failure (a user click is not provider health).
 */
describe('executeWithCompletionFailover honours an external cancel signal (F-022)', () => {
  it('aborts the provider-facing signal mid-collection and does not fail over', async () => {
    const circuit = createCircuitBreaker();
    const recordFailure = vi.spyOn(circuit, 'recordFailure');
    const started: string[] = [];
    const cancel = new AbortController();

    const run = executeWithCompletionFailover(
      twoProviders,
      async (entry, ctx) => {
        started.push(entry.provider);
        return ctx;
      },
      async (ctx) => {
        // Collection parks until the provider-facing signal aborts — the AI SDK shape.
        const parked = new Promise<never>((_, reject) => {
          ctx.signal.addEventListener(
            'abort',
            () => reject(ctx.signal.reason ?? new Error('aborted')),
            { once: true },
          );
        });
        // The job row is observed settled while the stream is mid-collection.
        cancel.abort(new Error('The build was cancelled'));
        return parked;
      },
      () => true,
      { circuit, signal: cancel.signal },
    );

    await expect(run).rejects.toThrow('The build was cancelled');
    // The second provider was never asked to redo cancelled work.
    expect(started).toEqual(['google']);
    // A cancel is not a provider failure; it must not count toward tripping the breaker.
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it('refuses to start an attempt when the signal is already aborted', async () => {
    const called: string[] = [];
    await expect(
      executeWithFailover(
        twoProviders,
        async (entry) => {
          called.push(entry.provider);
          return 'never';
        },
        { circuit: createCircuitBreaker(), signal: AbortSignal.abort(new Error('cancelled')) },
      ),
    ).rejects.toThrow('cancelled');
    expect(called).toEqual([]);
  });
});

describe('the generate route wires job cancellation to the provider stream (F-022, F-032)', () => {
  it('holds a per-run AbortController aborted when the heartbeat sees the row settle', () => {
    // The heartbeat already polls the row every 10s; when a write observes the row is no
    // longer QUEUED/RUNNING — Cancel / Start over flipped it — the route's controller
    // must abort so the provider stream stops buying tokens.
    expect(routeSource).toMatch(/jobCancelled = new AbortController\(\)/);
    expect(routeSource).toMatch(/onInactive:\s*\(\)\s*=>\s*jobCancelled\.abort\(/);
    // The signal reaches the failover run…
    expect(routeSource).toMatch(/signal:\s*jobCancelled\.signal/);
    // …and the per-attempt signal still reaches streamText.
    expect(routeSource).toMatch(/abortSignal:\s*ctx\.signal/);
  });

  it('does not overwrite the CANCELLED row when the abort unwinds the stream worker', () => {
    // The cancel write already settled the job. The stream worker's catch must
    // short-circuit instead of failing (failJob only touches an active row, but the
    // error frame and the failure diagnosis are wrong for a cancel either way).
    expect(routeSource).toMatch(/if \(jobCancelled\.signal\.aborted\)/);
  });

  it('no longer claims request.signal stops the heartbeat (F-032)', () => {
    // beginJobHeartbeat deliberately keeps beating when the client disconnects — the
    // work finishes and persists server-side. The route comment used to describe the
    // opposite behaviour.
    expect(routeSource).not.toMatch(/the row goes stale\s*\n?\s*\/\/ within a minute/);
    expect(routeSource).not.toMatch(/disconnects stops\s*\n\s*\/\/ vouching/);
  });
});
