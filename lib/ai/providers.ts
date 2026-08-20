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

/** Plain refusal text. Names the id the caller sent and the ids it could have sent. */
export function unknownModelMessage(model: string): string {
  const offered = DEEPSEEK_MODELS.map((row) => row.id).join(', ');
  return `"${model}" is not an available model. Choose one of: ${offered}.`;
}

/**
 * Thrown instead of forwarding a model the operator never configured (F-003).
 *
 * The old `resolveModel` returned the requested string verbatim, so `client(entry.model)`
 * sent whatever the request body carried to DeepSeek: any authenticated member could
 * select an unconfigured — and unpriced — model on every build, and a nonexistent id
 * came back as `request_rejected`, which reads as an outage rather than a bad choice.
 */
export class UnknownModelError extends Error {
  readonly code = 'unknown_model' as const;
  readonly requestedModel: string;

  constructor(requestedModel: string) {
    super(unknownModelMessage(requestedModel));
    this.name = 'UnknownModelError';
    this.requestedModel = requestedModel;
  }
}

/**
 * A stored or remembered model, but only while the product still offers it (F-004).
 *
 * `Project.model` is a user preference: the workspace seeds its model state from the
 * row, and a requested model is pushed to the FRONT of the chain, so a row holding a
 * legacy id outranked `ai.primaryModel` from Admin → Configuration for the life of
 * that project. A value that is no longer offered is not a preference — it becomes
 * `undefined` here, which is "no explicit choice", and the chain resumes at the
 * configured primary. An offered value is kept: choosing Pro on a project whose admin
 * primary is Flash is a real choice, not drift.
 *
 * Unlike `resolveModel` this never throws, and it takes `unknown` because both callers
 * are boundaries — a request body and a database column. A stale row must not brick the
 * project; only a live request that names a bad model is refused.
 */
export function offeredModel(model: unknown): string | undefined {
  const candidate = typeof model === 'string' ? model.trim() : '';
  if (!candidate || !isDeepSeekModel(candidate)) return undefined;
  return candidate;
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

/**
 * The one place a model id becomes the model that will serve.
 *
 * A requested model is validated, not passed through: this is the shared entry point
 * for plan and build, and it is the only thing between the request body and
 * `client(entry.model)`. It stays explicit-only — an omitted or blank request resolves
 * to the configured primary rather than to a default, because a "default" that
 * participates in *ranking* is an override, not a default.
 */
export function resolveModel(
  env: Record<string, string | undefined> = process.env,
  requestedModel?: string,
): string {
  const requested = requestedModel?.trim();
  if (requested) {
    if (!isDeepSeekModel(requested)) throw new UnknownModelError(requested);
    return requested;
  }
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
 *
 * 32768 still did not fit one. A five-page Next.js build stopped dead at the
 * cap: `SectionHeading.tsx` ended mid-identifier and four components that
 * `app/page.tsx` imported were never written, so the preview could not resolve
 * them. There is no continuation pass — whatever one reply holds is the site —
 * so this has to leave room for the largest build a plan permits, and
 * `maxTokensPerJob` remains the real ceiling.
 */
export function maxOutputTokensForEntry(_entry?: Pick<ProviderEntry, 'provider'>): number {
  return 128_000;
}
