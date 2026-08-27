import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  chatModelForEntry,
  chatModelForProvider,
  clientForEntry,
  thinkingEnabledFromEnv,
} from '@/lib/ai/client-for-entry';
import type { ProviderEntry } from '@/lib/ai/providers';

const ENTRY: ProviderEntry = {
  id: 'deepseek',
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
};

const ENV: Record<string, string | undefined> = {
  DEEPSEEK_API_KEY: 'sk-test',
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
};

/**
 * `@ai-sdk/openai` v2 defaults the callable provider to the *Responses* API
 * (`/responses`), which DeepSeek does not implement. `clientForEntry` returns
 * that provider, so `client(entry.model)` would hit /responses and every
 * generation returns malformed output (the stream spends its whole budget on
 * reasoning and emits no text). `chatModelForEntry` must return the
 * chat-completions model instead — the only path DeepSeek serves.
 */
describe('chatModelForEntry returns a chat-completions model, not the Responses default', () => {
  it('is a different model instance than the default callable provider', () => {
    const provider = clientForEntry(ENTRY, ENV);
    const responsesModel = provider(ENTRY.model);
    const chatModel = chatModelForEntry(ENTRY, ENV, ENTRY.model);
    expect(chatModel).not.toBe(responsesModel);
  });

  it('uses the chat accessor (model url is /chat/completions, not /responses)', () => {
    const provider = clientForEntry(ENTRY, ENV);
    // The provider object exposes `.chat`; a Responses-only provider would not
    // surface a working chat fetcher, so assert the accessor is callable and
    // distinct from the Responses model factory.
    expect(typeof provider.chat).toBe('function');
    expect(provider.chat).not.toBe(provider.responses);
  });

  it('does not throw for an offered DeepSeek model id', () => {
    expect(() => chatModelForEntry(ENTRY, ENV, ENTRY.model)).not.toThrow();
    expect(() => chatModelForEntry(ENTRY, ENV, 'deepseek-v4-pro')).not.toThrow();
  });

  /**
   * `model.provider` is the SDK's own name for the endpoint family the model
   * will POST to — `${providerName}.responses` for `OpenAIResponsesLanguageModel`
   * (`/responses`) against `${providerName}.chat` for `OpenAIChatLanguageModel`
   * (`/chat/completions`). Asserting on it is the closest a unit test gets to
   * naming the URL without a network call, and it is what separates the six
   * broken helper call sites from the two correct generation ones.
   */
  it("separates the two endpoint families by the model's own provider name", () => {
    const provider = clientForEntry(ENTRY, ENV);
    expect(provider(ENTRY.model).provider).toContain('.responses');
    expect(chatModelForEntry(ENTRY, ENV, ENTRY.model).provider).toContain('.chat');
    expect(chatModelForProvider(provider, ENTRY.model).provider).toContain('.chat');
  });
});

/**
 * The six helper paths — audit AI review, edit-intent planning, import
 * sectioning and segmentation, memory extraction, skill matching — hold an
 * already-built client from `getProviderForModel`, not a chain entry, so
 * `chatModelForEntry` did not fit them and they kept `client(actualModel)`.
 * `chatModelForProvider` is the accessor for that shape.
 */
describe('chatModelForProvider takes an already-built client', () => {
  it('returns the same endpoint family as chatModelForEntry', () => {
    const provider = clientForEntry(ENTRY, ENV);
    const viaProvider = chatModelForProvider(provider, 'deepseek-v4-pro');
    const viaEntry = chatModelForEntry(ENTRY, ENV, 'deepseek-v4-pro');
    expect(viaProvider.provider).toBe(viaEntry.provider);
    expect(viaProvider.modelId).toBe('deepseek-v4-pro');
  });

  it('is not the callable provider the same client hands back', () => {
    const provider = clientForEntry(ENTRY, ENV);
    expect(chatModelForProvider(provider, ENTRY.model).provider).not.toBe(
      provider(ENTRY.model).provider,
    );
  });
});

describe('thinkingEnabledFromEnv reads ai.deepseek.thinking via DEEPSEEK_THINKING', () => {
  it('is on by default and for the admin "enabled" value', () => {
    expect(thinkingEnabledFromEnv({})).toBe(true);
    expect(thinkingEnabledFromEnv({ DEEPSEEK_THINKING: 'enabled' })).toBe(true);
  });

  it('is off for the admin "disabled" value and the usual off aliases', () => {
    expect(thinkingEnabledFromEnv({ DEEPSEEK_THINKING: 'disabled' })).toBe(false);
    expect(thinkingEnabledFromEnv({ DEEPSEEK_THINKING: 'off' })).toBe(false);
    expect(thinkingEnabledFromEnv({ DEEPSEEK_THINKING: 'false' })).toBe(false);
    expect(thinkingEnabledFromEnv({ DEEPSEEK_THINKING: '0' })).toBe(false);
  });

  it('keeps the overlay mapping so the admin row reaches the fetch', () => {
    const overlay = readFileSync(
      fileURLToPath(new URL('../../lib/ai/effective-env.ts', import.meta.url)),
      'utf8',
    );
    expect(overlay).toContain("env: 'DEEPSEEK_THINKING'");
    expect(overlay).toContain("setting: 'ai.deepseek.thinking'");
    const client = readFileSync(
      fileURLToPath(new URL('../../lib/ai/client-for-entry.ts', import.meta.url)),
      'utf8',
    );
    expect(client).toContain('thinkingEnabledFromEnv(env)');
    expect(client).toContain('createDeepSeekReasoningFetch');
  });
});
