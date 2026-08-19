/**
 * The self-hosted image worker, and how it is asked for a picture with no text.
 *
 * Every rule here was measured against the live endpoint, because the obvious
 * approaches do not work:
 * - "no text, no words, no letters … no typography of any kind" produced a
 *   storefront with an illuminated sign reading "PITZZRIA PIZZEA IZZA". The
 *   worker passes only `prompt` to `env.AI.run`, and the model ignores negation.
 * - `negative_prompt: 'text, letters, words, signage …'` produced signs reading
 *   "WOOD" and "PIZZERA"; the worker does not forward the field at all.
 * - Appending a reframing *hint* still produced "WOOD & PIZZERIA" under
 *   `lucid-origin`, which follows the subject noun literally.
 * - Replacing the subject noun ("storefront" → "interior") produced a clean
 *   interior with no signage anywhere.
 *
 * So the strategy is substitution, and these tests pin it — including pinning
 * *out* the two phrasings that were disproven.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generateWithImageWorker,
  imageWorkerPrompt,
  type WorkerImageConfig,
} from '@/lib/assets/image-worker';

const CONFIG: WorkerImageConfig = { url: 'https://worker.example/', token: 'tok_test' };

// A minimal PNG header is all the byte sniffing inspects.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);

type WorkerRequestInit = { method: string; headers: Record<string, string>; body: string };
type WorkerReply = {
  ok: boolean;
  status: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
  json: () => Promise<unknown>;
};

function reply(body: Buffer | string, status = 200): WorkerReply {
  const payload = typeof body === 'string' ? Buffer.from(body) : body;
  return {
    ok: status < 400,
    status,
    arrayBuffer: async () =>
      payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
    json: async () => JSON.parse(payload.toString()) as unknown,
  };
}

/** Typed like the calls the module makes, so `.mock.calls` needs no assertion. */
function stubFetch(answer: (init: WorkerRequestInit) => WorkerReply) {
  const mock = vi.fn(async (_url: string, init: WorkerRequestInit) => answer(init));
  // The stub is narrower than `fetch`; the module only ever passes these two.
  const asFetch = mock as unknown as typeof fetch;
  vi.stubGlobal('fetch', asFetch);
  return mock;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('imageWorkerPrompt', () => {
  it('states the absence of lettering as a property of the scene', () => {
    const prompt = imageWorkerPrompt('A bowl of ramen on a counter', '16:9');

    expect(prompt).toContain('Blank unmarked walls');
    expect(prompt).toContain('plain undecorated surfaces');
    // The disproven phrasings must not come back: the models ignored both.
    expect(prompt).not.toMatch(/no text, no words, no letters/);
    expect(prompt).not.toMatch(/typography of any kind/);
  });

  it('replaces a subject that carries writing instead of asking for it politely', () => {
    // Verbatim the description that produced "PITZZRIA PIZZEA IZZA", then
    // "WOOD & PIZZERIA" when only a hint was appended.
    const prompt = imageWorkerPrompt(
      'Storefront of a wood-fired pizzeria at dusk with warm light spilling out',
      '16:9',
    );

    expect(prompt).not.toMatch(/storefront/i);
    expect(prompt).toContain('interior of a wood-fired pizzeria');
    expect(prompt).toContain('Shot from inside as a close detail');
  });

  it('substitutes every kind of subject that is normally covered in writing', () => {
    const cases: Array<[string, RegExp]> = [
      ['A menu board above the counter', /serving counter/],
      ['A neon sign above the bar', /plain wall/],
      ['Coffee bags with printed packaging', /unmarked container/],
      ['A laptop on a desk showing the dashboard', /hands at work/],
      ['A newspaper on a cafe table', /folded cloth/],
      ['Street view of the bakery', /interior/],
    ];

    for (const [description, expected] of cases) {
      const prompt = imageWorkerPrompt(description, '1:1');
      expect(prompt).toMatch(expected);
      expect(prompt).toContain('Shot from inside as a close detail');
    }
  });

  it('leaves a harmless subject completely alone', () => {
    const prompt = imageWorkerPrompt('A glowing brick oven with a pizza inside', '16:9');

    expect(prompt).toContain('A glowing brick oven with a pizza inside');
    expect(prompt).not.toContain('Shot from inside as a close detail');
  });

  it('does not leak regex state between calls', () => {
    // The substitution patterns are global and module-level: a `.test()` would
    // leave `lastIndex` behind and make the second call miss the same word.
    expect(imageWorkerPrompt('a storefront', '1:1')).toContain('interior');
    expect(imageWorkerPrompt('a storefront', '1:1')).toContain('interior');
  });

  it('asks for the shape the caller wanted', () => {
    expect(imageWorkerPrompt('a loaf', '16:9')).toContain('wide 16:9 landscape');
    expect(imageWorkerPrompt('a loaf', '1:1')).toContain('square 1:1');
    expect(imageWorkerPrompt('a loaf', '4:5')).toContain('vertical 4:5 portrait');
    expect(imageWorkerPrompt('a loaf', '1200x630')).toContain('1200x630 banner');
  });
});

describe('generateWithImageWorker', () => {
  it('sends the bearer token, the prompt and the configured model', async () => {
    const fetchMock = stubFetch(() => reply(PNG));

    await generateWithImageWorker({
      config: { ...CONFIG, model: 'lucid-origin' },
      description: 'A glowing oven',
      aspect: '16:9',
    });

    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe(CONFIG.url);
    expect(call[1].method).toBe('POST');
    expect(call[1].headers.Authorization).toBe('Bearer tok_test');
    const body = JSON.parse(call[1].body) as { prompt: string; model?: string };
    expect(body.prompt).toBe(imageWorkerPrompt('A glowing oven', '16:9'));
    expect(body.model).toBe('lucid-origin');
  });

  it('omits the model entirely when none is chosen, so the worker uses its default', async () => {
    const fetchMock = stubFetch(() => reply(PNG));

    await generateWithImageWorker({ config: CONFIG, description: 'A loaf', aspect: '1:1' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as Record<string, unknown>;
    expect('model' in body).toBe(false);
  });

  it('accepts raw bytes, which the FLUX klein models return', async () => {
    stubFetch(() => reply(PNG));

    const buffer = await generateWithImageWorker({
      config: CONFIG,
      description: 'A loaf',
      aspect: '16:9',
    });

    expect(buffer.subarray(1, 4).toString()).toBe('PNG');
  });

  it('decodes base64, which lucid-origin and schnell return', async () => {
    // Verified live: `lucid-origin` answers base64 text labelled `image/jpeg`,
    // because the worker forwards `result.image` straight into a Response.
    stubFetch(() => reply(JPEG.toString('base64')));

    const buffer = await generateWithImageWorker({
      config: { ...CONFIG, model: 'lucid-origin' },
      description: 'A loaf',
      aspect: '16:9',
    });

    expect(buffer.subarray(0, 2).toString('hex')).toBe('ffd8');
  });

  it('refuses a JSON error answered as an image', async () => {
    // The worker labels every answer `image/jpeg`, including this one. Storing it
    // would put a broken picture on the finished site.
    stubFetch(() => reply('{"error":"Unexpected model output format"}'));

    await expect(
      generateWithImageWorker({ config: CONFIG, description: 'x', aspect: '16:9' }),
    ).rejects.toThrow(/not an image/);
  });

  it("repeats the worker's own words when it refuses", async () => {
    // A bare 500 sends an operator hunting; "5006 … multipart" does not.
    stubFetch(() =>
      reply('{"error":"Failed to generate image","details":"5006: are \'multipart\'"}', 500),
    );

    await expect(
      generateWithImageWorker({ config: CONFIG, description: 'x', aspect: '16:9' }),
    ).rejects.toThrow(/500.*Failed to generate image.*multipart/);
  });

  it('gives up rather than hanging a build forever', async () => {
    const mock = vi.fn(async (_url: string, init: { signal?: AbortSignal }) => {
      const { promise, reject } = Promise.withResolvers<WorkerReply>();
      init.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
      return promise;
    });
    vi.stubGlobal('fetch', mock as unknown as typeof fetch);

    await expect(
      generateWithImageWorker({ config: CONFIG, description: 'x', aspect: '16:9', timeoutMs: 10 }),
    ).rejects.toThrow(/did not answer in time/);
  });
});
