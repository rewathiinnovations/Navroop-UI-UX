/**
 * DeepSeek is the only AI provider.
 *
 * This used to be a four-vendor chain (google/openai/anthropic/groq) with
 * cross-vendor failover. That is gone: one key, one model, chosen in
 * Admin → Configuration. The chain shape survives as a single-element list so
 * the retry/queue machinery around it keeps working unchanged.
 */

export type ProviderName = 'deepseek';

export type ProviderEntry = {
  id: string;
  provider: ProviderName;
  model: string;
  apiKeyEnv: string;
};

export const DEEPSEEK_API_KEY_ENV = 'DEEPSEEK_API_KEY';
export const DEEPSEEK_BASE_URL_ENV = 'DEEPSEEK_BASE_URL';
/** OpenAI-format endpoint (https://api-docs.deepseek.com). */
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';

/**
 * Models offered in the admin dropdown. DeepSeek keeps these two aliases
 * pointing at the current snapshot (V4-Flash-0731 / V4-Pro-0813), so pinning
 * dated ids here would go stale on their next release.
 */
export const DEEPSEEK_MODELS = [
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash — faster, cheaper' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro — strongest' },
] as const;

export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash';

export const NO_PROVIDER_CONFIGURED_MESSAGE =
  'DeepSeek is not configured — add an API key in Admin → Configuration.';

export class ProviderNotConfiguredError extends Error {
  readonly code = 'provider_not_configured' as const;
  readonly namedProvider: ProviderName | null;

  constructor(message: string, namedProvider: ProviderName | null = null) {
    super(message);
    this.name = 'ProviderNotConfiguredError';
    this.namedProvider = namedProvider;
  }
}

export type LoadProviderChainOptions = {
  requestedModel?: string;
};

export function isDeepSeekModel(model: string): boolean {
  return DEEPSEEK_MODELS.some((row) => row.id === model);
}

export function hasUsableCredential(
  _provider: ProviderName = 'deepseek',
  env: Record<string, string | undefined> = process.env,
) {
  return Boolean(env[DEEPSEEK_API_KEY_ENV]?.trim());
}

export function modelIdForEntry(entry: ProviderEntry) {
  return entry.model;
}

export function providerDisplayName(_provider: ProviderName = 'deepseek') {
  return 'DeepSeek';
}

export function resolveModel(
  env: Record<string, string | undefined> = process.env,
  requestedModel?: string,
): string {
  const requested = requestedModel?.trim();
  if (requested) return requested;
  const configured = env.AI_PRIMARY_MODEL?.trim();
  return configured || DEFAULT_DEEPSEEK_MODEL;
}

export function loadProviderChain(
  env: Record<string, string | undefined> = process.env,
  options: LoadProviderChainOptions = {},
): ProviderEntry[] {
  if (!hasUsableCredential('deepseek', env)) return [];
  return [
    {
      id: 'deepseek',
      provider: 'deepseek',
      model: resolveModel(env, options.requestedModel),
      apiKeyEnv: DEEPSEEK_API_KEY_ENV,
    },
  ];
}

export function requireUsableProviderChain(
  env: Record<string, string | undefined> = process.env,
  options: LoadProviderChainOptions = {},
): ProviderEntry[] {
  const chain = loadProviderChain(env, options);
  if (chain.length === 0) {
    throw new ProviderNotConfiguredError(NO_PROVIDER_CONFIGURED_MESSAGE, 'deepseek');
  }
  return chain;
}

export function getProviderApiKey(
  _entry: ProviderEntry,
  env: Record<string, string | undefined> = process.env,
) {
  return env[DEEPSEEK_API_KEY_ENV]?.trim() || undefined;
}

export function providerConcurrency(env: Record<string, string | undefined> = process.env) {
  const raw = Number.parseInt(env.AI_PROVIDER_CONCURRENCY || '2', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 2;
}

/**
 * Output-token budget for site generation. The old flat 8192 truncated real
 * multi-file sites mid-file, and the completion check then discarded the whole
 * stream as "no files". V4 allows far more (384K max output, 1M context), so a
 * whole site fits in one response.
 */
export function maxOutputTokensForEntry(_entry?: Pick<ProviderEntry, 'provider'>): number {
  return 32768;
}
