import { describe, expect, it } from 'vitest';
import { createAiMock } from '../mocks';

/**
 * F-604: this file used to loop over seven mock factories that nothing else imported,
 * with two assertions that could not fail — `expect(name).toBeTruthy()` on a string
 * literal from a `const` array, and `expect(ai.invoked).toBe(0)` immediately after
 * construction, which is true by construction. The six unused factories are gone; what
 * remains covers the one double with a real consumer
 * (`tests/unit/money-limits.test.ts`), and covers the property that consumer depends
 * on: `invoked` counts calls, so "the provider was never reached" is observable.
 */
describe('the AI mock', () => {
  it('counts calls, so a refusal before the provider is observable', async () => {
    const ai = createAiMock('success');
    expect(ai.invoked).toBe(0);
    await ai.complete('build me a landing page');
    expect(ai.invoked).toBe(1);
    await ai.complete('again');
    expect(ai.invoked).toBe(2);
  });

  it('counts a call that threw — a failed provider call still reached the provider', async () => {
    const ai = createAiMock('failure');
    await expect(ai.complete('hi')).rejects.toThrow('AI provider failed');
    expect(ai.invoked).toBe(1);
  });

  it('returns one complete file on success and a truncated one on partial', async () => {
    const success = await createAiMock('success').complete('hi');
    expect(success.truncated).toBe(false);
    expect(success.text).toContain('<file path="src/App.tsx">');
    expect(success.text).toContain('</file>');

    const partial = await createAiMock('partial').complete('hi');
    expect(partial.truncated).toBe(true);
    // The point of the partial outcome: the closing tag is missing, so a parser that
    // trusts the stream ships half a file.
    expect(partial.text).not.toContain('</file>');
  });

  it('distinguishes timeout and rate-limit failures by their carried metadata', async () => {
    const timeout = await createAiMock('timeout')
      .complete('hi')
      .catch((error: unknown) => error);
    expect((timeout as { code?: string }).code).toBe('ETIMEDOUT');

    const limited = await createAiMock('rate_limit')
      .complete('hi')
      .catch((error: unknown) => error);
    expect((limited as { status?: number }).status).toBe(429);
  });

  it('echoes the prompt back, so a suite can assert what was sent', async () => {
    const result = await createAiMock('success').complete('a specific prompt');
    expect(result.prompt).toBe('a specific prompt');
  });
});
