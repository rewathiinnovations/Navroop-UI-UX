import { createOpenAI } from '@ai-sdk/openai';
import {
  DEEPSEEK_API_KEY_ENV,
  DEEPSEEK_BASE_URL_ENV,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
  isDeepSeekModel,
} from './providers';

/**
 * Resolves the client for the app's own AI helpers (audit review, import
 * sectioning, skill matching, memory extraction).
 *
 * DeepSeek is the only provider, and its API is OpenAI-compatible, so this is
 * one cached client. Model ids that still carry an old vendor prefix
 * (`openai/…`, `anthropic/…`) fall back to the configured DeepSeek model
 * rather than failing — those ids are scattered through config defaults.
 */

export type ProviderClient = ReturnType<typeof createOpenAI>;

export interface ProviderResolution {
  client: ProviderClient;
  actualModel: string;
}

let cachedClient: ProviderClient | null = null;
let cachedKey = '';

function getClient(): ProviderClient {
  const apiKey = process.env[DEEPSEEK_API_KEY_ENV]?.trim();
  const baseURL = process.env[DEEPSEEK_BASE_URL_ENV]?.trim() || DEEPSEEK_DEFAULT_BASE_URL;
  const key = `${apiKey ?? ''}:${baseURL}`;
  if (!cachedClient || cachedKey !== key) {
    cachedClient = createOpenAI({ apiKey, baseURL });
    cachedKey = key;
  }
  return cachedClient;
}

export function getProviderForModel(modelId: string): ProviderResolution {
  const bare = modelId.includes('/') ? modelId.split('/').slice(1).join('/') : modelId;
  const actualModel = isDeepSeekModel(bare)
    ? bare
    : process.env.AI_PRIMARY_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL;
  return { client: getClient(), actualModel };
}

export default getProviderForModel;
