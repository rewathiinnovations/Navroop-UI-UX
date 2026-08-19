import { describe, expect, it } from 'vitest';
import { createCircuitBreaker } from '../../lib/ai/circuit';
import { EmptyCompletionError } from '../../lib/ai/empty-completion';
import { executeWithCompletionFailover, ProviderRunError } from '../../lib/ai/run';
import type { ProviderEntry } from '../../lib/ai/providers';
import { attemptProducedOutput } from '../../lib/generation/no-changes';

/**
 * The generate route hands `attemptProducedOutput` to the failover layer as its definition
 * of a finished attempt. These tests run the real failover with that predicate, because the
 * three cases below have to stay distinguishable:
 *
 *   - a conversational answer      → the provider worked; nothing else is tried
 *   - a silent stream              → the provider produced nothing; the chain is walked
 *   - a provider fault             → the chain is walked, exactly as before
 *
 * The middle and last cases are the reason failover exists. The first one is the live
 * incident (request `PhQfrFGYDYZo`): "files or nothing" made a chat answer a failed attempt,
 * so one "hello" was billed to every configured provider in turn and then reported as a
 * failed build.
 */

const twoProviders: ProviderEntry[] = [
  { id: 'deepseek', provider: 'deepseek', model: 'deepseek-chat', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  { id: 'openai', provider: 'openai', model: 'gpt-4o-mini', apiKeyEnv: 'OPENAI_API_KEY' },
];

const ANSWER = 'Hello! Your landing page is live. Tell me what to change and I will do it.';

type Collected = { generatedCode: string; files: { path: string }[]; stop: boolean };

function collected(generatedCode: string, files: { path: string }[] = []): Collected {
  return { generatedCode, files, stop: false };
}

describe('a conversational answer is not a failed provider attempt', () => {
  it('keeps the answer from the first provider and never calls the second', async () => {
    const called: string[] = [];
    const result = await executeWithCompletionFailover(
      twoProviders,
      async (entry) => {
        called.push(entry.provider);
        return { provider: entry.provider };
      },
      async () => collected(ANSWER),
      attemptProducedOutput,
      { circuit: createCircuitBreaker() },
    );

    expect(called).toEqual(['deepseek']);
    expect(result.provider).toBe('deepseek');
    expect(result.result.generatedCode).toBe(ANSWER);
    // Nothing failed, so nothing is reported as a retry and no circuit failure is recorded.
    expect(result.failedOver).toBe(false);
    expect(result.attempts.map((row) => ({ provider: row.provider, ok: row.ok }))).toEqual([
      { provider: 'deepseek', ok: true },
    ]);
  });

  it('walks the chain when the stream was silent, and ends as an empty completion', async () => {
    const called: string[] = [];
    await expect(
      executeWithCompletionFailover(
        twoProviders,
        async (entry) => {
          called.push(entry.provider);
          return { provider: entry.provider };
        },
        async () => collected('   \n '),
        attemptProducedOutput,
        { circuit: createCircuitBreaker() },
      ),
    ).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(ProviderRunError);
      expect((error as ProviderRunError).causeError).toBeInstanceOf(EmptyCompletionError);
      return true;
    });
    expect(called).toEqual(['deepseek', 'openai']);
  });

  it('still fails over on a genuine provider fault', async () => {
    const called: string[] = [];
    const result = await executeWithCompletionFailover(
      twoProviders,
      async (entry) => {
        called.push(entry.provider);
        if (entry.provider === 'deepseek') {
          const error = new Error('Service Unavailable') as Error & { status: number };
          error.status = 503;
          throw error;
        }
        return { provider: entry.provider };
      },
      async () => collected('done', [{ path: 'app/page.tsx' }]),
      attemptProducedOutput,
      { circuit: createCircuitBreaker() },
    );

    expect(called).toEqual(['deepseek', 'openai']);
    expect(result.provider).toBe('openai');
    expect(result.failedOver).toBe(true);
  });

  it('treats a reply carrying files as complete, and a disconnected client as finished', () => {
    expect(attemptProducedOutput({ stop: false, files: [{ path: 'a' }], generatedCode: '' })).toBe(
      true,
    );
    // The browser left mid-stream: that run is over on purpose, not incomplete, so it must
    // not be re-run against another vendor.
    expect(attemptProducedOutput({ stop: true, files: [], generatedCode: '' })).toBe(true);
    expect(attemptProducedOutput({ stop: false, files: [], generatedCode: '\n\t' })).toBe(false);
  });
});
