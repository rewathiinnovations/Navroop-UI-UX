import type { OpenAIProvider } from '@ai-sdk/openai';
import { log } from '@/lib/logger';
import { clientForEntry, clientIdentityForEntry, thinkingEnabledFromEnv } from './client-for-entry';
import { loadEffectiveProviderEnv } from './effective-env';
import { isDeepSeekModel, requireUsableProviderChain, type ProviderEntry } from './providers';

/**
 * Resolves the client for the app's own AI helpers (edit planning, import
 * sectioning, skill matching, memory extraction, audit review).
 *
 * This used to read `process.env.DEEPSEEK_API_KEY` and `AI_PRIMARY_MODEL`
 * directly while generation read the settings overlay, so an operator who did
 * exactly what /admin/config asks — paste the key there, set no environment
 * variable — got a system where the first build worked and everything else
 * quietly did not: follow-up edits failed at "Plan the edit", URL import could
 * not section a page, skill matching returned nothing, memory extraction was
 * dead, and the audit AI review errored, all while the key showed green as
 * "Set here". Nothing hydrates settings into `process.env` at boot, so the
 * only correct source is the overlay generation itself uses.
 *
 * Everything here goes through `loadEffectiveProviderEnv` for that reason.
 * There is no `null`-returning variant on purpose: an unconfigured install
 * must raise `ProviderNotConfiguredError`, whose message names the page to
 * fix, rather than let each caller invent its own silence.
 *
 * DeepSeek is the only provider and its API is OpenAI-compatible, so this is
 * one cached client. Model ids that still carry an old vendor prefix
 * (`openai/…`, `anthropic/…`) fall back to the configured model rather than
 * failing — those ids are scattered through config defaults.
 */

/** DeepSeek speaks the OpenAI wire format, so the client is the OpenAI one. */
export type ProviderClient = OpenAIProvider;

export interface ProviderResolution {
  client: ProviderClient;
  actualModel: string;
  /**
   * Whether the client this resolution returns sends `thinking: { type: 'enabled' }`.
   *
   * Read from the same `env` the client was built from, and returned rather than
   * left for the caller to re-derive: a thinking model rejects a request that also
   * carries a `temperature`, so the two decisions have to come from one reading.
   * A caller that guessed would send both and be refused.
   */
  thinking: boolean;
}

let cachedClient: ProviderClient | null = null;
let cachedKey = '';

function clientFor(entry: ProviderEntry, env: Record<string, string | undefined>): ProviderClient {
  // Keyed on everything the client was built from, not on process.env: changing any of it
  // in Admin → Configuration must retire this client, not keep serving one built from the
  // superseded values for the life of the process. The key is computed by the module that
  // builds the client (`clientIdentityForEntry`) rather than spelled out again here — the
  // hand-written `apiKey + ':' + baseURL` version stopped covering the client the moment
  // the thinking flag was baked into its fetch, so the "Thinking / reasoning" toggle was
  // obeyed by generation and ignored by every helper that comes through this cache.
  const key = clientIdentityForEntry(entry, env);
  if (!cachedClient || cachedKey !== key) {
    cachedClient = clientForEntry(entry, env);
    cachedKey = key;
  }
  return cachedClient;
}

/**
 * `modelId` is a model the caller genuinely wants, or `null` for "no
 * preference — use the configured primary". Passing a constant nobody chose
 * (this used to be `appConfig.ai.defaultModel`, a Google id) is not a request:
 * DeepSeek is the only provider, so the id was discarded by the chain and
 * logged a spurious substitution warning on every audit review, URL import,
 * memory extraction and skill match (F-737).
 *
 * `userId` is the acting user of the request, or null for a genuinely
 * user-less context. It must be the SAME subject the generation call resolves
 * with: hard-coding null here made one request use two credentials against
 * two quotas, and let the two halves disagree about whether a key exists at
 * all (F-073).
 */
export async function getProviderForModel(
  modelId: string | null,
  userId: string | null,
): Promise<ProviderResolution> {
  const env = await loadEffectiveProviderEnv(userId, process.env);
  const bare = modelId?.includes('/') ? modelId.split('/').slice(1).join('/') : modelId;
  // An unknown id is not a request for a model: let the chain pick the
  // configured one (`ai.primaryModel` → AI_PRIMARY_MODEL → the built-in).
  const known = bare !== null && isDeepSeekModel(bare);
  const [entry] = requireUsableProviderChain(env, {
    requestedModel: known ? bare : undefined,
  });
  if (modelId !== null && !known) {
    // Surfaced, not silent (F-082): config defaults still carry legacy vendor
    // ids, and the substitution used to be invisible on both sides.
    log.warn('ai.unknown_model_substituted', { requestedModel: modelId, actualModel: entry.model });
  }
  return {
    client: clientFor(entry, env),
    actualModel: entry.model,
    thinking: thinkingEnabledFromEnv(env),
  };
}

export default getProviderForModel;
