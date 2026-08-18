export type ProviderName = 'openai' | 'anthropic' | 'groq' | 'google';

export type ProviderEntry = {
  id: string;
  provider: ProviderName;
  model: string;
  apiKeyEnv: string;
};

export const NO_PROVIDER_CONFIGURED_MESSAGE =
  'No AI provider is configured — set GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, or GROQ_API_KEY on the server.';

const KEY_ENV: Record<ProviderName, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  groq: 'GROQ_API_KEY',
  google: 'GEMINI_API_KEY',
};

const DEFAULT_MODELS: Record<ProviderName, string> = {
  groq: 'moonshotai/kimi-k2-instruct-0905',
  // gpt-4o-mini half-follows the stack prompts (single-file Next.js output for
  // a Vite project); code generation needs a current flagship-tier model.
  openai: 'gpt-5.6-luna',
  anthropic: 'claude-sonnet-4-20250514',
  google: 'gemini-2.0-flash',
};

const PROVIDER_ORDER: ProviderName[] = ['google', 'openai', 'anthropic', 'groq'];

const DISPLAY_NAME: Record<ProviderName, string> = {
  google: 'Gemini',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  groq: 'Groq',
};

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

function isProviderName(value: string): value is ProviderName {
  return value === 'openai' || value === 'anthropic' || value === 'groq' || value === 'google';
}

function parseNamedProvider(value: string | undefined): ProviderName | null {
  if (!value?.trim()) return null;
  const key = value.trim().toLowerCase();
  return isProviderName(key) ? key : null;
}

export function hasUsableCredential(
  provider: ProviderName,
  env: Record<string, string | undefined> = process.env,
) {
  if (env.AI_GATEWAY_API_KEY?.trim()) return true;
  return Boolean(env[KEY_ENV[provider]]?.trim());
}

export function providerForModel(modelId: string): ProviderName {
  const id = modelId.trim();
  if (id.startsWith('google/')) return 'google';
  if (id.startsWith('openai/')) return 'openai';
  if (id.startsWith('anthropic/')) return 'anthropic';
  if (id === 'moonshotai/kimi-k2-instruct-0905' || id.startsWith('moonshotai/')) return 'groq';
  return 'groq';
}

export function bareModelName(modelId: string, provider: ProviderName) {
  const stripped = modelId.replace(/^(google|openai|anthropic)\//, '').trim();
  return stripped || DEFAULT_MODELS[provider];
}

export function modelIdForEntry(entry: ProviderEntry) {
  if (entry.provider === 'groq') return entry.model;
  if (entry.provider === 'google') return `google/${entry.model}`;
  if (entry.provider === 'openai') return `openai/${entry.model}`;
  return `anthropic/${entry.model}`;
}

export function providerDisplayName(provider: ProviderName) {
  return DISPLAY_NAME[provider];
}

export function failoverNotice(from: ProviderName, to: ProviderName) {
  return `${DISPLAY_NAME[from]} was unavailable, so this used ${DISPLAY_NAME[to]} instead.`;
}

function makeEntry(provider: ProviderName, model: string): ProviderEntry {
  return {
    id: provider,
    provider,
    model,
    apiKeyEnv: KEY_ENV[provider],
  };
}

export function loadProviderChain(
  env: Record<string, string | undefined> = process.env,
  options: LoadProviderChainOptions = {},
): ProviderEntry[] {
  const rawPrimary = env.AI_PRIMARY_PROVIDER?.trim();
  if (rawPrimary) {
    const named = parseNamedProvider(rawPrimary);
    if (!named) {
      throw new ProviderNotConfiguredError(
        `AI_PRIMARY_PROVIDER is set to "${rawPrimary}" which is not a supported provider (google, openai, anthropic, groq)`,
        null,
      );
    }
    if (!hasUsableCredential(named, env)) {
      throw new ProviderNotConfiguredError(
        `AI_PRIMARY_PROVIDER is set to ${named} but ${KEY_ENV[named]} is missing or blank`,
        named,
      );
    }
  }

  const seen = new Set<ProviderName>();
  const chain: ProviderEntry[] = [];

  const push = (provider: ProviderName, model: string) => {
    if (seen.has(provider)) return;
    if (!hasUsableCredential(provider, env)) return;
    seen.add(provider);
    chain.push(makeEntry(provider, model));
  };

  const requested = options.requestedModel?.trim();
  if (requested) {
    const provider = providerForModel(requested);
    push(provider, bareModelName(requested, provider));
  }

  const primary = parseNamedProvider(env.AI_PRIMARY_PROVIDER) ?? 'google';
  push(primary, env.AI_PRIMARY_MODEL?.trim() || DEFAULT_MODELS[primary]);

  const fallback = parseNamedProvider(env.AI_FALLBACK_PROVIDER) ?? 'openai';
  push(fallback, env.AI_FALLBACK_MODEL?.trim() || DEFAULT_MODELS[fallback]);

  for (const provider of PROVIDER_ORDER) {
    push(provider, DEFAULT_MODELS[provider]);
  }

  return chain;
}

export function requireUsableProviderChain(
  env: Record<string, string | undefined> = process.env,
  options: LoadProviderChainOptions = {},
): ProviderEntry[] {
  const chain = loadProviderChain(env, options);
  if (chain.length === 0) {
    throw new ProviderNotConfiguredError(NO_PROVIDER_CONFIGURED_MESSAGE);
  }
  return chain;
}

export function getProviderApiKey(
  entry: ProviderEntry,
  env: Record<string, string | undefined> = process.env,
) {
  return env[entry.apiKeyEnv]?.trim() || undefined;
}

export function providerConcurrency(env: Record<string, string | undefined> = process.env) {
  const raw = Number.parseInt(env.AI_PROVIDER_CONCURRENCY || '2', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 2;
}

/**
 * Output-token budget per provider for site generation. The route used a
 * flat 8192, which truncates a real multi-file site mid-file (three open
 * <file> blocks, zero closed) — the completion failover then discards the
 * whole stream as "no files". Give each vendor its real headroom; Gemini
 * 2.0 Flash genuinely caps at 8192.
 */
export function maxOutputTokensForEntry(entry: Pick<ProviderEntry, 'provider'>): number {
  switch (entry.provider) {
    case 'google':
      return 8192;
    case 'groq':
      return 16384;
    case 'openai':
    case 'anthropic':
      return 32768;
    default:
      return 16384;
  }
}
