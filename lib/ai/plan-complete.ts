import { getDefaultCircuit, type CircuitBreaker } from './circuit';
import { loadEffectiveProviderEnv } from './effective-env';
import { executeWithFailover, type ProviderRunResult } from './run';
import { requireUsableProviderChain, type ProviderEntry } from './providers';

/**
 * Shared plan/build entry: honour the requested model, skip keyless providers,
 * and switch immediately on a provider-side failure.
 *
 * The credential store is not a parameter. It used to be an optional `env` that
 * fell back to the raw environment, so a caller who omitted it selected and paid
 * with blank env slots while the admin-settings overlay — the whole reason an
 * admin-UI-only deployment works at all — sat unread (F-083). The overlay is
 * loaded here from `userId` and handed to `run` as `ctx.env`, so the store the
 * chain was selected from is the only one a client can be built with.
 */
export async function completeWithProviderFailover<T>(opts: {
  userId: string | null | undefined;
  requestedModel?: string;
  timeoutMs?: number;
  circuit?: CircuitBreaker;
  run: (
    entry: ProviderEntry,
    ctx: { signal: AbortSignal; env: Record<string, string | undefined> },
  ) => Promise<T>;
}): Promise<ProviderRunResult<T>> {
  const env = await loadEffectiveProviderEnv(opts.userId);
  // No silent fallback to appConfig.ai.defaultModel here: a requestedModel is
  // pushed to the FRONT of the chain, so defaulting it demoted the operator's
  // configured primary (AI_PRIMARY_* / Admin → Configuration) on every call.
  // With no explicit request the chain itself starts at the configured primary.
  const chain = requireUsableProviderChain(env, {
    requestedModel: opts.requestedModel,
  });
  return executeWithFailover(chain, (entry, ctx) => opts.run(entry, { ...ctx, env }), {
    circuit: opts.circuit ?? getDefaultCircuit(),
    timeoutMs: opts.timeoutMs,
  });
}
