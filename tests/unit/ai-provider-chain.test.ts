import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEEPSEEK_MODEL,
  loadProviderChain,
  NO_PROVIDER_CONFIGURED_MESSAGE,
  ProviderNotConfiguredError,
  requireUsableProviderChain,
  resolveModel,
} from '@/lib/ai/providers';

/**
 * DeepSeek is the only provider. The chain survives as a single entry so the
 * retry and queue machinery around it is unchanged, but there is no longer any
 * cross-vendor selection or failover to get wrong.
 */
describe('loadProviderChain', () => {
  it('returns one DeepSeek entry when a key is present', () => {
    const chain = loadProviderChain({ DEEPSEEK_API_KEY: 'sk-test' });
    expect(chain).toEqual([
      {
        id: 'deepseek',
        provider: 'deepseek',
        model: DEFAULT_DEEPSEEK_MODEL,
        apiKeyEnv: 'DEEPSEEK_API_KEY',
      },
    ]);
  });

  it('is empty when the key is missing or blank', () => {
    expect(loadProviderChain({})).toEqual([]);
    expect(loadProviderChain({ DEEPSEEK_API_KEY: '   ' })).toEqual([]);
  });

  it('uses the admin-selected model', () => {
    const [entry] = loadProviderChain({
      DEEPSEEK_API_KEY: 'sk-test',
      AI_PRIMARY_MODEL: 'deepseek-v4-pro',
    });
    expect(entry.model).toBe('deepseek-v4-pro');
  });

  it('lets an explicitly requested model win over the configured one', () => {
    const [entry] = loadProviderChain(
      { DEEPSEEK_API_KEY: 'sk-test', AI_PRIMARY_MODEL: 'deepseek-v4-flash' },
      { requestedModel: 'deepseek-v4-pro' },
    );
    expect(entry.model).toBe('deepseek-v4-pro');
  });

  it('falls back to the default model when nothing is configured', () => {
    expect(resolveModel({})).toBe(DEFAULT_DEEPSEEK_MODEL);
  });
});

describe('requireUsableProviderChain', () => {
  it('throws the configuration sentence when there is no key', () => {
    expect(() => requireUsableProviderChain({})).toThrow(ProviderNotConfiguredError);
    expect(() => requireUsableProviderChain({})).toThrow(NO_PROVIDER_CONFIGURED_MESSAGE);
  });

  it('returns the chain when configured', () => {
    expect(requireUsableProviderChain({ DEEPSEEK_API_KEY: 'sk-test' })).toHaveLength(1);
  });
});
