import type { OpenAIProvider } from '@ai-sdk/openai';
import { clientForEntry } from './client-for-entry';
import { loadEffectiveProviderEnv } from './effective-env';
import {
  DEEPSEEK_BASE_URL_ENV,
  DEEPSEEK_DEFAULT_BASE_URL,
  getProviderApiKey,
  isDeepSeekModel,
  requireUsableProviderChain,
  type ProviderEntry,
} from './providers';

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
}

let cachedClient: ProviderClient | null = null;
let cachedKey = '';

function clientFor(entry: ProviderEntry, env: Record<string, string | undefined>): ProviderClient {
  // Keyed on the resolved credential, not on process.env: changing the key in
  // Admin → Configuration must retire this client, not keep serving one built
  // from the superseded value for the life of the process.
  const baseURL = env[DEEPSEEK_BASE_URL_ENV]?.trim() || DEEPSEEK_DEFAULT_BASE_URL;
  const key = `${getProviderApiKey(entry, env) ?? ''}:${baseURL}`;
  if (!cachedClient || cachedKey !== key) {
    cachedClient = clientForEntry(entry, env);
    cachedKey = key;
  }
  return cachedClient;
}

export async function getProviderForModel(modelId: string): Promise<ProviderResolution> {
  const env = await loadEffectiveProviderEnv(null, process.env);
  const bare = modelId.includes('/') ? modelId.split('/').slice(1).join('/') : modelId;
  // An unknown id is not a request for a model: let the chain pick the
  // configured one (`ai.primaryModel` → AI_PRIMARY_MODEL → the built-in).
  const [entry] = requireUsableProviderChain(env, {
    requestedModel: isDeepSeekModel(bare) ? bare : undefined,
  });
  return { client: clientFor(entry, env), actualModel: entry.model };
}

export default getProviderForModel;
