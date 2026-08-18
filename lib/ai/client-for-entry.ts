import { createOpenAI } from '@ai-sdk/openai';
import {
  DEEPSEEK_BASE_URL_ENV,
  DEEPSEEK_DEFAULT_BASE_URL,
  getProviderApiKey,
  type ProviderEntry,
} from './providers';

/**
 * Builds the AI SDK client from an explicit env — the same env the chain was
 * selected from, which for a signed-in user is the effective-env overlay
 * (personal key → admin setting → process.env).
 *
 * DeepSeek serves an OpenAI-compatible API, so this uses the OpenAI client
 * with DeepSeek's base URL rather than @ai-sdk/deepseek: the dedicated package
 * tracks a different AI SDK model-spec version than the `ai` release this app
 * is on, and mixing them fails to typecheck at every call site.
 */
export function clientForEntry(entry: ProviderEntry, env: Record<string, string | undefined>) {
  return createOpenAI({
    apiKey: getProviderApiKey(entry, env),
    baseURL: env[DEEPSEEK_BASE_URL_ENV]?.trim() || DEEPSEEK_DEFAULT_BASE_URL,
  });
}
