import { getDefaultCircuit, type CircuitBreaker } from './circuit';
import { executeWithFailover, type ProviderRunResult } from './run';
import { requireUsableProviderChain, type ProviderEntry } from './providers';

/**
 * Shared plan/build entry: honour the requested model, skip keyless providers,
 * and switch immediately on a provider-side failure.
 */
export async function completeWithProviderFailover<T>(opts: {
  requestedModel?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  circuit?: CircuitBreaker;
  run: (entry: ProviderEntry, ctx: { signal: AbortSignal }) => Promise<T>;
}): Promise<ProviderRunResult<T>> {
  // No silent fallback to appConfig.ai.defaultModel here: a requestedModel is
  // pushed to the FRONT of the chain, so defaulting it demoted the operator's
  // configured primary (AI_PRIMARY_* / Admin → Configuration) on every call.
  // With no explicit request the chain itself starts at the configured primary.
  const chain = requireUsableProviderChain(opts.env ?? process.env, {
    requestedModel: opts.requestedModel,
  });
  return executeWithFailover(chain, opts.run, {
    circuit: opts.circuit ?? getDefaultCircuit(),
    timeoutMs: opts.timeoutMs,
  });
}
