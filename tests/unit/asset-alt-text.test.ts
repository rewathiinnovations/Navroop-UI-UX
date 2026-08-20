import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-127: every generated image made a second model call for its alt text —
 * `gpt-4o-mini`, or Gemini when no OpenAI key was set — and that call was
 * unmetered and unlogged. Both provider branches ended in
 * `catch { /* fall through *\/ }`, and a non-OK response was ignored, so an
 * expired key turned the alt text into a prompt echo with no signal anywhere:
 * `base-rules.ts` tells the model to treat that text as authoritative.
 */

const keys = vi.hoisted(() => ({ getEffectiveApiKey: vi.fn() }));
const spend = vi.hoisted(() => ({ accrueSpend: vi.fn() }));
const rates = vi.hoisted(() => ({ loadOperatorTokenRate: vi.fn(), reportRateSource: vi.fn() }));
const track = vi.hoisted(() => ({ trackFailure: vi.fn() }));

vi.mock('@/lib/api-keys', () => keys);
vi.mock('@/lib/plans/spend', () => spend);
vi.mock('@/lib/consumption/rates', () => rates);
vi.mock('@/lib/observability/track', () => track);

// Imported after `vi.mock`, so the module graph is built against the mocks.
const { generateAltText } = await import('@/lib/assets/alt-text');

const PROMPT = 'storefront of an artisan pizzeria';
/** Per million tokens, so the expected spend is exact rather than approximate. */
const RATE = { input: 1_000, output: 2_000 };

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  rates.loadOperatorTokenRate.mockResolvedValue(RATE);
  spend.accrueSpend.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('generateAltText meters the call it makes', () => {
  it('charges the provider-reported tokens of a successful call', async () => {
    keys.getEffectiveApiKey.mockImplementation(async (_user: unknown, provider: string) =>
      provider === 'openai' ? 'test-key' : null,
    );
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'A warm artisan pizzeria storefront' } }],
          usage: { prompt_tokens: 40, completion_tokens: 12 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const altText = await generateAltText({
      userId: 'u-1',
      projectId: 'p-1',
      prompt: PROMPT,
    });

    expect(altText).toBe('A warm artisan pizzeria storefront');
    // (40 * 1000 + 12 * 2000) / 1_000_000
    expect(spend.accrueSpend).toHaveBeenCalledWith('default', 0.064);
    expect(track.trackFailure).not.toHaveBeenCalled();
  });

  it('charges the prompt and reports the failure when every provider refuses', async () => {
    keys.getEffectiveApiKey.mockResolvedValue('test-key');
    fetchMock.mockResolvedValue(new Response('rate limited', { status: 429 }));

    const altText = await generateAltText({
      userId: 'u-1',
      projectId: 'p-1',
      prompt: PROMPT,
    });

    // The prompt echo is still the fallback — a missing sentence must not fail a
    // paid image — but it is no longer indistinguishable from a good one.
    expect(altText).toBe(PROMPT);
    expect(track.trackFailure).toHaveBeenCalledWith(
      'assets.alt_text_failed',
      expect.any(Error),
      expect.objectContaining({ action: 'alt_text', projectId: 'p-1' }),
    );
    expect(String(track.trackFailure.mock.calls[0]?.[1])).toMatch(/429/);
    // A provider that accepted the request billed for the prompt it uploaded,
    // whatever it answered.
    const charged = spend.accrueSpend.mock.calls[0]?.[1] as number;
    expect(charged).toBeGreaterThan(0);
  });

  it('meters nothing and reports nothing when no provider is configured', async () => {
    keys.getEffectiveApiKey.mockResolvedValue(null);

    const altText = await generateAltText({
      userId: null,
      projectId: 'p-1',
      prompt: PROMPT,
    });

    expect(altText).toBe(PROMPT);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spend.accrueSpend).not.toHaveBeenCalled();
    expect(track.trackFailure).not.toHaveBeenCalled();
  });

  it('falls through to Gemini and meters that call instead', async () => {
    keys.getEffectiveApiKey.mockImplementation(async (_user: unknown, provider: string) =>
      provider === 'gemini' ? 'test-key' : null,
    );
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'Pizzeria shopfront at dusk' }] } }],
          usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 10 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const altText = await generateAltText({
      userId: 'u-1',
      projectId: 'p-1',
      prompt: PROMPT,
    });

    expect(altText).toBe('Pizzeria shopfront at dusk');
    // (30 * 1000 + 10 * 2000) / 1_000_000
    expect(spend.accrueSpend).toHaveBeenCalledWith('default', 0.05);
  });

  it('does not let a spend-accrual failure lose the alt text', async () => {
    keys.getEffectiveApiKey.mockImplementation(async (_user: unknown, provider: string) =>
      provider === 'openai' ? 'test-key' : null,
    );
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'A warm artisan pizzeria storefront' } }],
          usage: { prompt_tokens: 40, completion_tokens: 12 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    spend.accrueSpend.mockRejectedValue(new Error('workspace row locked'));

    const altText = await generateAltText({
      userId: 'u-1',
      projectId: 'p-1',
      prompt: PROMPT,
    });

    expect(altText).toBe('A warm artisan pizzeria storefront');
    expect(track.trackFailure).toHaveBeenCalledWith(
      'assets.alt_text_spend_failed',
      expect.any(Error),
      expect.objectContaining({ action: 'alt_text' }),
    );
  });
});
