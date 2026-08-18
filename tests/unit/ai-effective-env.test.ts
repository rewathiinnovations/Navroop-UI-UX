import { describe, expect, it } from 'vitest';
import { overlayProviderKeys } from '../../lib/ai/effective-env';

describe('overlayProviderKeys', () => {
  it('lets an admin-store key fill a blank env slot without exposing the value', () => {
    const env = overlayProviderKeys(
      { GEMINI_API_KEY: '', OPENAI_API_KEY: undefined },
      { GEMINI_API_KEY: 'admin-gemini', OPENAI_API_KEY: 'admin-openai' },
    );
    expect(Boolean(env.GEMINI_API_KEY?.trim())).toBe(true);
    expect(Boolean(env.OPENAI_API_KEY?.trim())).toBe(true);
    expect(env.GEMINI_API_KEY).toBe('admin-gemini');
    expect(env.OPENAI_API_KEY).toBe('admin-openai');
  });

  it('does not treat a blank admin value as configured', () => {
    const env = overlayProviderKeys({ OPENAI_API_KEY: 'from-env' }, { OPENAI_API_KEY: '   ' });
    expect(env.OPENAI_API_KEY).toBe('from-env');
  });

  it('an admin-store key wins over a present env value for the same vendor', () => {
    const env = overlayProviderKeys(
      { GEMINI_API_KEY: 'from-env' },
      { GEMINI_API_KEY: 'from-admin' },
    );
    expect(env.GEMINI_API_KEY).toBe('from-admin');
  });
});
