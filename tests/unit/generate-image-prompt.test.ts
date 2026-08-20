import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-122: the measured no-text treatment (`imageWorkerPrompt` — subject
 * substitution plus the plain-surfaces framing) applied to the worker only.
 * OpenAI and Imagen received the bare description, which is exactly the
 * subject the module comment records producing invented signage
 * ("PITZZRIA PIZZEA IZZA"). Every provider must receive the built prompt;
 * the stored asset row keeps the user's own description.
 */

const keys = vi.hoisted(() => ({ getEffectiveApiKey: vi.fn() }));
vi.mock('@/lib/api-keys', () => keys);

/** Not under test, and it pulls sharp and prisma in for real. */
const persist = vi.hoisted(() => ({ persistOptimizedAsset: vi.fn() }));
vi.mock('@/lib/assets/persist', () => persist);

vi.mock('@/lib/usage-costs', () => ({ logGenerationEvent: vi.fn() }));

/** No worker configured — the finding's trigger: keys present, worker unset. */
vi.mock('@/lib/settings/resolve', () => ({ getSettings: vi.fn(async () => ({})) }));

const { generateImage } = await import('@/lib/assets/generate-image');
const { imageWorkerPrompt } = await import('@/lib/assets/image-worker');

const DESCRIPTION = 'storefront of an artisan pizzeria';
const ASSET = {
  id: 'asset_1',
  projectId: 'p-1',
  url: '/uploads/a.webp',
  storageKey: 'projects/p-1/assets/a.webp',
  kind: 'generated',
  prompt: DESCRIPTION,
  altText: 'alt',
  width: 1600,
  height: 900,
  sizeBytes: 10,
  createdAt: new Date(),
};

const fetchMock = vi.fn();

function providerRequest(url: string) {
  const call = fetchMock.mock.calls.find(([target]) => String(target).includes(url));
  expect(call, `expected a fetch to ${url}`).toBeDefined();
  return JSON.parse((call?.[1] as RequestInit).body as string) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  persist.persistOptimizedAsset.mockResolvedValue(ASSET);
  fetchMock.mockImplementation(async (target: RequestInfo | URL) => {
    const url = String(target);
    if (url.includes('images/generations')) {
      return new Response(
        JSON.stringify({ data: [{ b64_json: Buffer.from('img').toString('base64') }] }),
        { status: 200 },
      );
    }
    if (url.includes(':predict')) {
      return new Response(
        JSON.stringify({
          predictions: [{ bytesBase64Encoded: Buffer.from('img').toString('base64') }],
        }),
        { status: 200 },
      );
    }
    // Alt-text calls (chat/completions, generateContent) fail closed: the
    // fallback alt path is not what this file tests.
    return new Response('nope', { status: 500 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('generateImage applies the no-text prompt treatment to every provider', () => {
  it('sends the built prompt — not the bare description — to OpenAI', async () => {
    keys.getEffectiveApiKey.mockImplementation(async (_user: unknown, provider: string) =>
      provider === 'openai' ? 'test-key' : null,
    );

    const result = await generateImage({
      projectId: 'p-1',
      userId: null,
      prompt: DESCRIPTION,
      aspectRatio: '16:9',
    });

    const body = providerRequest('images/generations');
    expect(body.prompt).toBe(imageWorkerPrompt(DESCRIPTION, '16:9'));
    expect(body.prompt).not.toBe(DESCRIPTION);
    // The two halves of the treatment: subject substitution and plain surfaces.
    expect(String(body.prompt)).toContain('interior');
    expect(String(body.prompt)).not.toContain('storefront');
    expect(String(body.prompt)).toContain('Blank unmarked walls');
    expect(result.provider).toBe('openai');
    // The asset row keeps the user's own words, not the styled prompt.
    expect(persist.persistOptimizedAsset).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: DESCRIPTION }),
    );
  });

  it('sends the built prompt to Google Imagen', async () => {
    keys.getEffectiveApiKey.mockImplementation(async (_user: unknown, provider: string) =>
      provider === 'gemini' ? 'test-key' : null,
    );

    const result = await generateImage({
      projectId: 'p-1',
      userId: null,
      prompt: DESCRIPTION,
      aspectRatio: '1:1',
    });

    const body = providerRequest(':predict') as {
      instances: Array<{ prompt: string }>;
    };
    expect(body.instances[0]?.prompt).toBe(imageWorkerPrompt(DESCRIPTION, '1:1'));
    expect(body.instances[0]?.prompt).toContain('Blank unmarked walls');
    expect(result.provider).toBe('imagen');
  });
});
