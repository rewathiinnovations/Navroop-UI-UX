import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type * as PinnedFetchModule from '@/lib/security/pinned-fetch';

/**
 * F-124: the two stock providers downloaded an image URL taken from a
 * third-party API response with the global `fetch` — no SSRF guard, no redirect
 * limit and no byte ceiling, so `Buffer.from(await image.arrayBuffer())` read
 * whatever arrived. `parseOpenverseResults` only checks `^https?://`, and the
 * Openverse corpus is publicly contributed, so a record's `url` is
 * attacker-influenced: a record pointing at `http://169.254.169.254/` was
 * rejected by the content-type check *after* the request had already been made.
 */

/** Keeps the SSRF guard off real DNS; every public hostname resolves here. */
vi.mock('node:dns', () => ({
  promises: { lookup: async () => [{ address: '93.184.216.34', family: 4 }] },
}));

/**
 * `safeFetch` no longer connects through global `fetch`: it pins the socket to
 * the address the SSRF guard approved and drives `node:http` itself, so a
 * rebinding second lookup cannot move the connection (F-308). The transport is
 * the interception point now — routed back at the stubbed global `fetch` here,
 * so every assertion below still reads the request that would have gone out.
 */
vi.mock('@/lib/security/pinned-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof PinnedFetchModule>()),
  pinnedFetch: (url: URL, _pinned: unknown, init: RequestInit) =>
    fetch(url.href, { ...init, redirect: 'manual' }),
}));

const persist = vi.hoisted(() => ({ persistOptimizedAsset: vi.fn() }));
const settings = vi.hoisted(() => ({ getSetting: vi.fn() }));

vi.mock('@/lib/assets/persist', () => persist);
vi.mock('@/lib/settings/resolve', () => ({ getSetting: settings.getSetting }));

// Imported after `vi.mock`, so the module graph is built against the mocks.
const { MAX_IMAGE_DOWNLOAD_BYTES, downloadImageBuffer } = await import('@/lib/assets/download');
const { searchOpenversePhoto } = await import('@/lib/assets/openverse');
const { searchStockPhoto } = await import('@/lib/assets/stock-photo');

const CDN = 'https://cdn.example.com/photo.jpg';
const METADATA = 'http://169.254.169.254/latest/meta-data/';

function openversePayload(url: string) {
  return {
    result_count: 1,
    results: [
      {
        id: 'a1',
        title: 'Espresso Coffee',
        url,
        creator: 'Burst',
        license: 'cc0',
        filetype: 'jpg',
        category: 'photograph',
        tags: [{ name: 'espresso' }],
      },
    ],
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function imageResponse(bytes = 64) {
  return new Response(new Uint8Array(bytes).fill(0x41), {
    status: 200,
    headers: { 'content-type': 'image/jpeg' },
  });
}

let fetchMock: Mock;

function route(handlers: Array<[RegExp, (url: string) => Response]>) {
  fetchMock.mockImplementation(async (input: unknown) => {
    const url = input instanceof URL ? input.toString() : String(input);
    for (const [pattern, respond] of handlers) {
      if (pattern.test(url)) return respond(url);
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
}

function calledUrls() {
  return fetchMock.mock.calls.map(([input]) =>
    input instanceof URL ? input.toString() : String(input),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  persist.persistOptimizedAsset.mockImplementation(async (input: { kind: string }) => ({
    id: 'asset-1',
    url: '/uploads/projects/p-1/assets/asset-1.webp',
    kind: input.kind,
  }));
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('downloadImageBuffer', () => {
  it('aborts a body over the byte ceiling instead of buffering it', async () => {
    route([
      [
        /cdn\.example\.com/,
        () =>
          new Response(new Uint8Array(MAX_IMAGE_DOWNLOAD_BYTES + 1024), {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
          }),
      ],
    ]);

    await expect(downloadImageBuffer(CDN)).rejects.toThrow(/too large/i);
  });

  it('refuses a declared over-size body before reading it', async () => {
    route([
      [
        /cdn\.example\.com/,
        () =>
          new Response(new Uint8Array(8), {
            status: 200,
            headers: {
              'content-type': 'image/jpeg',
              'content-length': String(MAX_IMAGE_DOWNLOAD_BYTES + 1),
            },
          }),
      ],
    ]);

    await expect(downloadImageBuffer(CDN)).rejects.toThrow(/too large/i);
  });

  it('never requests a link-local address', async () => {
    route([[/./, () => imageResponse()]]);

    await expect(downloadImageBuffer(METADATA)).rejects.toThrow(/private network/i);
    expect(calledUrls()).toEqual([]);
  });

  it('rejects a non-image body', async () => {
    route([
      [
        /cdn\.example\.com/,
        () => new Response('<html>nope</html>', { headers: { 'content-type': 'text/html' } }),
      ],
    ]);

    await expect(downloadImageBuffer(CDN)).rejects.toThrow(/content-type/i);
  });

  it('returns the bytes of a normal image', async () => {
    route([[/cdn\.example\.com/, () => imageResponse(128)]]);

    const buffer = await downloadImageBuffer(CDN);

    expect(buffer.byteLength).toBe(128);
  });
});

describe('the stock providers download through the guard', () => {
  it('never fetches an Openverse record that points at an internal address', async () => {
    route([
      [/api\.openverse\.org/, () => jsonResponse(openversePayload(METADATA))],
      [/./, () => imageResponse()],
    ]);

    await expect(
      searchOpenversePhoto({ projectId: 'p-1', query: 'espresso bar interior' }),
    ).rejects.toThrow(/download failed/i);

    expect(calledUrls().some((url) => url.includes('169.254.169.254'))).toBe(false);
    expect(persist.persistOptimizedAsset).not.toHaveBeenCalled();
  });

  it('aborts an oversized Openverse image instead of persisting it', async () => {
    route([
      [/api\.openverse\.org/, () => jsonResponse(openversePayload(CDN))],
      [
        /cdn\.example\.com/,
        () =>
          new Response(new Uint8Array(MAX_IMAGE_DOWNLOAD_BYTES + 1024), {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
          }),
      ],
    ]);

    await expect(
      searchOpenversePhoto({ projectId: 'p-1', query: 'espresso bar interior' }),
    ).rejects.toThrow(/too large/i);
    expect(persist.persistOptimizedAsset).not.toHaveBeenCalled();
  });

  it('aborts an oversized Unsplash image instead of persisting it', async () => {
    settings.getSetting.mockResolvedValue('test-key');
    route([
      [
        /api\.unsplash\.com/,
        () =>
          jsonResponse({
            results: [
              {
                alt_description: 'a barista pulling an espresso shot',
                urls: { regular: CDN },
                user: { name: 'Ada Lovelace' },
              },
            ],
          }),
      ],
      [
        /cdn\.example\.com/,
        () =>
          new Response(new Uint8Array(MAX_IMAGE_DOWNLOAD_BYTES + 1024), {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
          }),
      ],
      [/api\.openverse\.org/, () => jsonResponse({ result_count: 0, results: [] })],
    ]);

    await expect(
      searchStockPhoto({ projectId: 'p-1', query: 'espresso bar interior' }),
    ).rejects.toThrow(/unsplash: .*too large/is);
    expect(persist.persistOptimizedAsset).not.toHaveBeenCalled();
  });
});
