import { appConfig } from '@/config/app.config';
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
  const chain = requireUsableProviderChain(opts.env ?? process.env, {
    requestedModel: opts.requestedModel ?? appConfig.ai.defaultModel,
  });
  return executeWithFailover(chain, opts.run, {
    circuit: opts.circuit ?? getDefaultCircuit(),
    timeoutMs: opts.timeoutMs,
  });
}
