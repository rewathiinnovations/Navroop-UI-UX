import { extractReasoningMiddleware, wrapLanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

/** Derived from wrapLanguageModel's parameter so we don't need @ai-sdk/provider as a direct dep. */
type LanguageModelV2 = Parameters<typeof wrapLanguageModel>[0]['model'];
import { createDeepSeekReasoningFetch } from './deepseek-reasoning-sse';
import {
  DEEPSEEK_BASE_URL_ENV,
  DEEPSEEK_DEFAULT_BASE_URL,
  getProviderApiKey,
  type ProviderEntry,
} from './providers';

/**
 * `DEEPSEEK_THINKING` ("enabled" | "disabled") is the admin-level kill switch
 * for the request-body injection. It defaults to enabled so existing
 * deployments behave the same until an operator opts out.
 */
export function thinkingEnabledFromEnv(env: Record<string, string | undefined>): boolean {
  const raw = (env.DEEPSEEK_THINKING || '').trim().toLowerCase();
  if (!raw) return true;
  return raw !== 'disabled' && raw !== 'off' && raw !== 'false' && raw !== '0';
}

/** The endpoint every DeepSeek client is built against: the admin/env override, else the documented default. */
function baseUrlFromEnv(env: Record<string, string | undefined>): string {
  return env[DEEPSEEK_BASE_URL_ENV]?.trim() || DEEPSEEK_DEFAULT_BASE_URL;
}

/**
 * Builds the AI SDK client from an explicit env — the same env the chain was
 * selected from, which for a signed-in user is the effective-env overlay
 * (personal key → admin setting → process.env).
 *
 * DeepSeek serves an OpenAI-compatible API, so this uses the OpenAI client
 * with DeepSeek's base URL rather than @ai-sdk/deepseek: the dedicated package
 * tracks a different AI SDK model-spec version than the `ai` release this app
 * is on, and mixing them fails to typecheck at every call site.
 *
 * Thinking tokens arrive as `delta.reasoning_content`, which this OpenAI
 * client drops. The fetch rewrite turns SSE reasoning into `<think>` content;
 * {@link wrapReasoningModel} splits that back into reasoning parts so a
 * generate can rearm its idle bound and show the Code pane something.
 *
 * Every value this reads out of `env` is read ONCE, here, and closed over for
 * the life of the returned object — the thinking flag most of all, because it
 * is baked into the `fetch`. Anything cacheing this client has to key on all of
 * them: see {@link clientIdentityForEntry}, which is the list.
 */
export function clientForEntry(entry: ProviderEntry, env: Record<string, string | undefined>) {
  return createOpenAI({
    apiKey: getProviderApiKey(entry, env),
    baseURL: baseUrlFromEnv(env),
    fetch: createDeepSeekReasoningFetch(undefined, { enabled: thinkingEnabledFromEnv(env) }),
  });
}

/**
 * Everything {@link clientForEntry} reads, as one comparable string — the cache key for
 * any caller that holds a client across requests.
 *
 * `provider-manager` keyed its process-wide client on `apiKey + ':' + baseURL`, which was
 * the whole story until the client started baking in a third input. `DEEPSEEK_THINKING`
 * (Admin → Configuration, "Thinking / reasoning") is read at construction and closed over
 * by the fetch, so switching it to Disabled changed nothing the old key could see: the
 * cached client was never retired, and every `getProviderForModel` caller — the audit AI
 * review, follow-up edit-intent planning, skill matching, memory extraction, URL-import
 * sectioning — kept sending `thinking: { type: 'enabled' }` until the container restarted.
 * (What effort tier that thinking asks for is no longer a constant: `reasoningEffortFor`
 * in `deepseek-reasoning-sse.ts` derives it from whether the request is a stream.)
 * Generation builds a fresh client per call through `chatModelForEntry`, so it obeyed the
 * toggle immediately: one setting, live on half the product and stuck on the other.
 *
 * The key lives beside the constructor it describes precisely so that stops happening —
 * adding an input to `clientForEntry` and forgetting the cache is now one edit in one file,
 * not a change here and a matching change nobody makes over in `provider-manager`.
 * `entry` is in the signature for the same reason: it mirrors `clientForEntry`, so the two
 * are read as a pair.
 */
export function clientIdentityForEntry(
  entry: ProviderEntry,
  env: Record<string, string | undefined>,
): string {
  // JSON rather than a `:`-joined string: a base URL contains colons, and a key that can be
  // spelled two ways by two different envs is a cache that serves the wrong client.
  return JSON.stringify([
    getProviderApiKey(entry, env) ?? '',
    baseUrlFromEnv(env),
    thinkingEnabledFromEnv(env),
  ]);
}

/**
 * The provider object `clientForEntry` hands back. Derived rather than imported
 * so this module keeps its single `@ai-sdk/openai` import; it is the same type
 * `provider-manager` exports as `ProviderClient`.
 */
type OpenAiCompatibleProvider = ReturnType<typeof clientForEntry>;

/**
 * The chat-completions model for an already-built provider.
 *
 * `@ai-sdk/openai` v2 defaults the callable provider to the *Responses* API:
 * `provider(modelId)` is `provider.languageModel(modelId)` is
 * `createResponsesModel(modelId)`, which POSTs `${baseURL}/responses`.
 * DeepSeek does not implement that endpoint. `provider.chat` is the
 * chat-completions accessor — the only path DeepSeek serves.
 *
 * Both spellings of the mistake are silent in different ways. On the streaming
 * path DeepSeek returned a malformed completion and the stream produced no
 * text (it spent the whole budget on reasoning). On the helper paths that go
 * through `getProviderForModel` the base URL is DeepSeek's, so /responses is a
 * flat 404 — and every one of those callers either swallows the throw or
 * degrades to a heuristic, so the feature just stops working. That is how the
 * audit's AI review, follow-up edit planning, skill matching, memory
 * extraction and URL-import sectioning all ran dead at once without a single
 * error reaching a user. Never call the provider object itself, and never
 * reach for `.responses` / `.languageModel`; `tests/unit/no-callable-provider.test.ts`
 * walks the tree and fails on a new one.
 */
export function chatModelForProvider(client: OpenAiCompatibleProvider, modelId: string) {
  return client.chat(modelId as never);
}

/** {@link chatModelForProvider} for a chain entry, building the client first. */
export function chatModelForEntry(
  entry: ProviderEntry,
  env: Record<string, string | undefined>,
  modelId: string,
) {
  return chatModelForProvider(clientForEntry(entry, env), modelId);
}

/** Apply on `streamText` only — `generateObject` / `generateText` are JSON, not SSE. */
export function wrapReasoningModel(model: LanguageModelV2) {
  return wrapLanguageModel({
    model,
    middleware: extractReasoningMiddleware({ tagName: 'think' }),
  });
}
