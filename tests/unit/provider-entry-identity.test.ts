import { describe, expect, it } from 'vitest';
import { createCircuitBreaker } from '@/lib/ai/circuit';
import { executeWithCompletionFailover, executeWithFailover, ProviderRunError } from '@/lib/ai/run';
import type { ProviderEntry } from '@/lib/ai/providers';

/**
 * The chain is matched back to its served entry by identity, not by provider name
 * (F-055).
 *
 * `ProviderEntry.provider` is not a key: the chain shape explicitly allows two
 * entries for the same provider — two DeepSeek models — and
 * `chain.find((row) => row.provider === started.provider)` resolves to the first of
 * them whatever served. That handed `collect` the wrong model, and the failover
 * cursor advanced past the *first* entry rather than the one that had just failed,
 * so the loop restarted the model it had already given up on.
 *
 * The live chain is length 1 (`loadProviderChain`), so this is the latent half of
 * the bug pinned before a second entry makes it real. Goes red if either lookup
 * goes back to comparing provider names.
 */

function twoDeepSeekModels(): ProviderEntry[] {
  return [
    {
      id: 'flash',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    },
    { id: 'pro', provider: 'deepseek', model: 'deepseek-v4-pro', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  ];
}

function httpError(status: number, message = 'error') {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

describe('executeWithFailover reports which entry served', () => {
  it('returns the entry object, not just its provider name', async () => {
    const chain = twoDeepSeekModels();
    const result = await executeWithFailover(chain, async (entry) => entry.model, {
      circuit: createCircuitBreaker(),
    });
    expect(result.entry).toBe(chain[0]);
    expect(result.model).toBe('deepseek-v4-flash');
  });

  it('returns the second entry when the first one fails', async () => {
    const chain = twoDeepSeekModels();
    const result = await executeWithFailover(
      chain,
      async (entry) => {
        if (entry.id === 'flash') throw httpError(500, 'internal error');
        return entry.model;
      },
      { circuit: createCircuitBreaker() },
    );
    expect(result.entry).toBe(chain[1]);
    expect(result.model).toBe('deepseek-v4-pro');
  });
});

describe('executeWithCompletionFailover walks two entries of one provider', () => {
  it('hands collect the entry that served, so the second model can complete', async () => {
    const chain = twoDeepSeekModels();
    const collected: string[] = [];
    const result = await executeWithCompletionFailover(
      chain,
      async (entry) => ({ model: entry.model }),
      async (_started, entry) => {
        collected.push(entry.model);
        // Only the second model returns a site. Under the provider-name lookup
        // `collect` was told "flash" on both passes, so this never fired and the
        // whole run failed with an empty completion.
        return { files: entry.model === 'deepseek-v4-pro' ? ['app/page.tsx'] : [] };
      },
      (result) => result.files.length > 0,
      { circuit: createCircuitBreaker() },
    );
    expect(collected).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
    expect(result.entry).toBe(chain[1]);
    expect(result.model).toBe('deepseek-v4-pro');
    expect(result.result.files).toEqual(['app/page.tsx']);
  });

  it('never restarts the entry that just failed', async () => {
    const chain = twoDeepSeekModels();
    const started: string[] = [];
    await expect(
      executeWithCompletionFailover(
        chain,
        async (entry) => {
          started.push(entry.model);
          // The first entry fails at start, so the *second* one is what served —
          // the case the name lookup got wrong.
          if (entry.id === 'flash') throw httpError(500, 'internal error');
          return { model: entry.model };
        },
        async () => ({ files: [] as string[] }),
        (result) => result.files.length > 0,
        { circuit: createCircuitBreaker() },
      ),
    ).rejects.toBeInstanceOf(ProviderRunError);
    // Pro exactly once. The old cursor advance moved one past `flash`, leaving
    // `pro` in `remaining` for a second, pointless attempt.
    expect(started).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
  });
});
