import { describe, expect, it } from 'vitest';
import { recoveryCauseLine } from '../../lib/jobs/copy';
import {
  NO_PROVIDER_CONFIGURED_MESSAGE,
  ProviderNotConfiguredError,
  failoverNotice,
  loadProviderChain,
  requireUsableProviderChain,
} from '../../lib/ai/providers';

const GEMINI_MODEL = 'google/gemini-2.5-flash';

const geminiAndOpenAI = {
  GEMINI_API_KEY: 'test-gemini',
  OPENAI_API_KEY: 'test-openai',
  GROQ_API_KEY: '',
  ANTHROPIC_API_KEY: undefined,
};

describe('loadProviderChain skips unusable credentials', () => {
  it('chooses Gemini first when Groq has no key and the requested model is Gemini', () => {
    const chain = loadProviderChain(geminiAndOpenAI, { requestedModel: GEMINI_MODEL });

    expect(chain.map((entry) => entry.provider)).toEqual(['google', 'openai']);
    expect(chain[0]?.model).toBe('gemini-2.5-flash');
    expect(chain.some((entry) => entry.provider === 'groq')).toBe(false);
  });

  it('never selects a provider whose key is missing or blank', () => {
    const chain = loadProviderChain({
      ...geminiAndOpenAI,
      GROQ_API_KEY: '   ',
      ANTHROPIC_API_KEY: '',
    });

    expect(chain.every((entry) => entry.provider === 'google' || entry.provider === 'openai')).toBe(
      true,
    );
    expect(chain.some((entry) => entry.provider === 'groq' || entry.provider === 'anthropic')).toBe(
      false,
    );
  });

  it('throws a named error when AI_PRIMARY_PROVIDER has no key', () => {
    expect(() =>
      loadProviderChain({
        ...geminiAndOpenAI,
        AI_PRIMARY_PROVIDER: 'groq',
      }),
    ).toThrow(ProviderNotConfiguredError);

    try {
      loadProviderChain({
        ...geminiAndOpenAI,
        AI_PRIMARY_PROVIDER: 'groq',
      });
      expect.fail('expected ProviderNotConfiguredError');
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderNotConfiguredError);
      const named = error as ProviderNotConfiguredError;
      expect(named.namedProvider).toBe('groq');
      expect(named.message).toMatch(/AI_PRIMARY_PROVIDER/i);
      expect(named.message).toMatch(/GROQ_API_KEY/);
      expect(named.message.toLowerCase()).not.toMatch(/did not respond|is down|unavailable/);
    }
  });

  it('fails immediately with the no-provider sentence when nothing is usable', () => {
    expect(() => requireUsableProviderChain({})).toThrow(ProviderNotConfiguredError);
    expect(() => requireUsableProviderChain({})).toThrow(NO_PROVIDER_CONFIGURED_MESSAGE);
    expect(NO_PROVIDER_CONFIGURED_MESSAGE).toMatch(/No AI provider is configured/);
    expect(NO_PROVIDER_CONFIGURED_MESSAGE).toMatch(/GEMINI_API_KEY/);
    expect(NO_PROVIDER_CONFIGURED_MESSAGE.toLowerCase()).not.toMatch(
      /did not respond|is down|outage/,
    );
    expect(recoveryCauseLine('provider_not_configured')).toBe(NO_PROVIDER_CONFIGURED_MESSAGE);
  });

  it('keeps a two-vendor chain when the operator names usable primary and fallback', () => {
    const chain = loadProviderChain({
      AI_PRIMARY_PROVIDER: 'groq',
      AI_PRIMARY_MODEL: 'moonshotai/kimi-k2-instruct-0905',
      AI_FALLBACK_PROVIDER: 'openai',
      AI_FALLBACK_MODEL: 'gpt-4o-mini',
      GROQ_API_KEY: 'test-groq',
      OPENAI_API_KEY: 'test-openai',
    });
    expect(chain[0]?.provider).toBe('groq');
    expect(chain[1]?.provider).toBe('openai');
  });
});

describe('failover notice', () => {
  it('is one plain-English line naming the fallback, not a failure', () => {
    const line = failoverNotice('google', 'openai');
    expect(line).toMatch(/Gemini/i);
    expect(line).toMatch(/OpenAI/i);
    expect(line.toLowerCase()).not.toMatch(/failed to build|could not generate|build failed/);
  });
});
