import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import { getProviderApiKey, type ProviderEntry } from './providers';

export const AI_GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh/v1';

/**
 * Builds the AI SDK client for a chain entry from an explicit env — the same
 * env the chain was selected from, which for a signed-in user is the
 * effective-env overlay (personal key → org key → process.env).
 *
 * This used to live only inside the generate route, so the plan path built
 * clients from `process.env` alone: a deployment configured entirely through
 * /admin/config could run builds but could not create a project, because
 * planning never saw the stored keys.
 */
export function clientForEntry(
  entry: ProviderEntry,
  env: Record<string, string | undefined>,
) {
  const gateway = env.AI_GATEWAY_API_KEY?.trim();
  const apiKey = gateway || getProviderApiKey(entry, env);
  const gatewayUrl = gateway ? AI_GATEWAY_BASE_URL : undefined;
  if (entry.provider === 'openai') {
    return createOpenAI({ apiKey, baseURL: gatewayUrl ?? env.OPENAI_BASE_URL });
  }
  if (entry.provider === 'anthropic') {
    return createAnthropic({
      apiKey,
      baseURL: gatewayUrl ?? (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1'),
    });
  }
  if (entry.provider === 'google') {
    return createGoogleGenerativeAI({ apiKey, baseURL: gatewayUrl ?? env.GEMINI_BASE_URL });
  }
  return createGroq({ apiKey, baseURL: gatewayUrl ?? env.GROQ_BASE_URL });
}
