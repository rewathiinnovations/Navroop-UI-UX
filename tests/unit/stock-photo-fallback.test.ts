import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

/**
 * A verified generated site ("Tilt & Tamp", 22 files) shipped a grey box where its
 * hero photo belonged: the `src` was byte-for-byte `placeholderImageDataUri`. The
 * model had done its job — it emitted NEED_IMAGE tokens exactly as instructed —
 * but the only configured provider could not answer, so every token fell through
 * to a placeholder. Worse, the page carried a "Photo via Unsplash" caption
 * crediting a photograph that did not exist, and the only trace of the whole
 * failure was one `console.warn`.
 *
 * These tests pin the three fixes: a keyless fallback provider so a photo source
 * always exists, an ordered chain whose failure names every provider it tried,
 * and an unfulfilled count the caller can actually report.
 */

const settings = vi.hoisted(() => ({ getSetting: vi.fn() }));
const persist = vi.hoisted(() => ({ persistOptimizedAsset: vi.fn() }));
const credits = vi.hoisted(() => ({ checkCredits: vi.fn(), consumeCredits: vi.fn() }));

vi.mock('@/lib/settings/resolve', () => ({ getSetting: settings.getSetting }));

/** Not under test, and it pulls sharp and prisma in for real. */
vi.mock('@/lib/assets/persist', () => ({
  persistOptimizedAsset: persist.persistOptimizedAsset,
}));
vi.mock('@/lib/storage/usage', () => ({
  WORKSPACE_ROW_ID: 'default',
  adjustStorageBytes: vi.fn(),
}));
vi.mock('@/lib/plans/limits', () => ({
  checkCredits: credits.checkCredits,
  consumeCredits: credits.consumeCredits,
}));
vi.mock('@/lib/assets/generate-image', () => ({ generateImage: vi.fn() }));
vi.mock('@/lib/observability/track', () => ({ trackFailure: vi.fn() }));

import { fulfillNeedImages } from '@/lib/assets/fulfill';
import { openverseKeywords, parseOpenverseResults } from '@/lib/assets/openverse';
import { searchStockPhoto } from '@/lib/assets/stock-photo';

const PROJECT = 'p-stock';
const UNSPLASH = /api\.unsplash\.com/;
const OPENVERSE = /api\.openverse\.org/;

/**
 * One record captured verbatim from the live API on 2026-08-19 —
 * `GET https://api.openverse.org/v1/images/?q=espresso+coffee+bar&page_size=1
 * &license=cc0,pdm&size=large&aspect_ratio=wide` — with only the long `tags`
 * array trimmed. This is a REAL payload, not a hand-written fixture: it is here
 * so a field rename upstream (`url`, `license`, `creator`, `filetype`) fails a
 * test instead of silently producing placeholders again.
 */
const REAL_OPENVERSE_PAYLOAD = {
  result_count: 11,
  page_count: 6,
  page_size: 1,
  page: 1,
  results: [
    {
      id: '2ca68772-a692-4db8-b6c1-dc8f4934d4dc',
      title: 'Espresso Coffee',
      indexed_on: '2021-11-01T23:12:09.897557Z',
      foreign_landing_url: 'https://stocksnap.io/photo/espresso-coffee-T2DS9PUWRZ',
      url: 'https://cdn.stocksnap.io/img-thumbs/960w/T2DS9PUWRZ.jpg',
      creator: 'Burst',
      creator_url: 'https://burst.shopify.com',
      license: 'cc0',
      license_version: '1.0',
      license_url: 'https://creativecommons.org/publicdomain/zero/1.0/',
      provider: 'stocksnap',
      source: 'stocksnap',
      category: 'photograph',
      filesize: 663251,
      filetype: 'jpg',
      tags: [
        { name: 'bar', accuracy: null, unstable__provider: 'stocksnap' },
        { name: 'coffee', accuracy: null, unstable__provider: 'stocksnap' },
        { name: 'espresso', accuracy: null, unstable__provider: 'stocksnap' },
      ],
      attribution:
        '"Espresso Coffee" by Burst is marked with CC0 1.0. To view the terms, visit https://creativecommons.org/publicdomain/zero/1.0/.',
      fields_matched: ['title', 'tags.name'],
      mature: false,
      height: 3648,
      width: 5472,
      thumbnail: 'https://api.openverse.org/v1/images/2ca68772-a692-4db8-b6c1-dc8f4934d4dc/thumb/',
      detail_url: 'https://api.openverse.org/v1/images/2ca68772-a692-4db8-b6c1-dc8f4934d4dc/',
      related_url:
        'https://api.openverse.org/v1/images/2ca68772-a692-4db8-b6c1-dc8f4934d4dc/related/',
      unstable__sensitivity: [],
    },
  ],
};

const UNSPLASH_PAYLOAD = {
  results: [
    {
      alt_description: 'a barista pulling an espresso shot',
      description: null,
      urls: { regular: 'https://images.unsplash.com/photo-1?w=1080', full: 'https://x/full' },
      user: { name: 'Ada Lovelace', username: 'ada' },
      links: { html: 'https://unsplash.com/photos/1' },
    },
  ],
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: new Headers({ 'content-type': 'application/json' }),
  } as unknown as Response;
}

function imageResponse() {
  const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'image/jpeg' }),
    arrayBuffer: async () => bytes.buffer,
  } as unknown as Response;
}

let fetchMock: Mock;

/** Routes by URL so a test states only the providers it cares about. */
function route(handlers: Array<[RegExp, (url: string) => Response]>) {
  fetchMock.mockImplementation(async (input: unknown) => {
    const url = input instanceof URL ? input.toString() : String(input);
    for (const [pattern, respond] of handlers) {
      if (pattern.test(url)) return respond(url);
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
}

function calledUrls(pattern: RegExp) {
  return fetchMock.mock.calls
    .map(([input]) => (input instanceof URL ? input.toString() : String(input)))
    .filter((url) => pattern.test(url));
}

beforeEach(() => {
  settings.getSetting.mockReset();
  persist.persistOptimizedAsset.mockReset();
  persist.persistOptimizedAsset.mockImplementation(
    async (input: { kind: string; altText: string; prompt?: string | null }) => ({
      id: 'asset-1',
      url: `/uploads/projects/${PROJECT}/assets/asset-1.webp`,
      kind: input.kind,
      altText: input.altText,
      prompt: input.prompt ?? null,
    }),
  );
  credits.checkCredits.mockResolvedValue({ ok: true });
  credits.consumeCredits.mockResolvedValue(undefined);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('searchStockPhoto provider chain', () => {
  it('serves a real photo from Openverse when no Unsplash key is configured', async () => {
    // Set explicitly: the deployment now HAS a key, so "no key" is a state a test
    // must ask for rather than inherit as a default.
    settings.getSetting.mockResolvedValue(null);
    route([
      [OPENVERSE, () => jsonResponse(REAL_OPENVERSE_PAYLOAD)],
      [/cdn\.stocksnap\.io/, () => imageResponse()],
    ]);

    const asset = await searchStockPhoto({ projectId: PROJECT, query: 'espresso bar interior' });

    expect(asset.kind).toBe('stock');
    expect(calledUrls(UNSPLASH)).toHaveLength(0);
    const persisted = persist.persistOptimizedAsset.mock.calls[0]?.[0];
    expect(persisted).toMatchObject({ projectId: PROJECT, kind: 'stock' });
    expect(persisted.altText).toBe('Espresso Coffee');
    expect(persisted.buffer.byteLength).toBeGreaterThan(0);
  });

  it('keeps Unsplash first when a key is configured and never reaches Openverse', async () => {
    settings.getSetting.mockResolvedValue('a-configured-key');
    route([
      [UNSPLASH, () => jsonResponse(UNSPLASH_PAYLOAD)],
      [/images\.unsplash\.com/, () => imageResponse()],
    ]);

    const asset = await searchStockPhoto({ projectId: PROJECT, query: 'espresso bar interior' });

    expect(asset.kind).toBe('stock');
    expect(calledUrls(OPENVERSE)).toHaveLength(0);
    // Unchanged Unsplash behaviour: landscape, one result, credited photographer.
    const search = calledUrls(UNSPLASH)[0];
    expect(search).toContain('orientation=landscape');
    expect(search).toContain('per_page=1');
    expect(persist.persistOptimizedAsset.mock.calls[0]?.[0]).toMatchObject({
      kind: 'stock',
      altText: 'a barista pulling an espresso shot',
      prompt: 'espresso bar interior — Photo by Ada Lovelace on Unsplash',
    });
  });

  it('falls through to Openverse when Unsplash matches nothing', async () => {
    settings.getSetting.mockResolvedValue('a-configured-key');
    route([
      [UNSPLASH, () => jsonResponse({ results: [] })],
      [OPENVERSE, () => jsonResponse(REAL_OPENVERSE_PAYLOAD)],
      [/cdn\.stocksnap\.io/, () => imageResponse()],
    ]);

    const asset = await searchStockPhoto({ projectId: PROJECT, query: 'espresso bar interior' });

    expect(asset.kind).toBe('stock');
    expect(calledUrls(OPENVERSE).length).toBeGreaterThan(0);
  });

  it('requests only licences that carry no attribution obligation', async () => {
    settings.getSetting.mockResolvedValue(null);
    route([
      [OPENVERSE, () => jsonResponse(REAL_OPENVERSE_PAYLOAD)],
      [/cdn\.stocksnap\.io/, () => imageResponse()],
    ]);

    await searchStockPhoto({ projectId: PROJECT, query: 'espresso bar interior' });

    const search = new URL(calledUrls(OPENVERSE)[0]);
    expect(search.searchParams.get('license')).toBe('cc0,pdm');
    expect(search.searchParams.get('category')).toBe('photograph');
    // Landscape and large are requested where the API supports it.
    expect(search.searchParams.get('aspect_ratio')).toBe('wide');
    expect(search.searchParams.get('size')).toBe('large');
  });

  it('names every provider and its reason when Openverse is rate limited', async () => {
    settings.getSetting.mockResolvedValue('a-configured-key');
    route([
      [UNSPLASH, () => jsonResponse({ errors: ['boom'] }, 500)],
      [OPENVERSE, () => jsonResponse({ detail: 'throttled' }, 429)],
    ]);

    await expect(
      searchStockPhoto({ projectId: PROJECT, query: 'espresso bar interior' }),
    ).rejects.toThrow(/unsplash: Unsplash search failed \(500\).*openverse: .*429/s);
    // A 429 must not be answered by widening the query into more requests.
    expect(calledUrls(OPENVERSE)).toHaveLength(1);
  });

  it('names every provider when Openverse matches nothing either', async () => {
    settings.getSetting.mockResolvedValue('a-configured-key');
    route([
      [UNSPLASH, () => jsonResponse({ results: [] })],
      [OPENVERSE, () => jsonResponse({ result_count: 0, results: [] })],
    ]);

    await expect(
      searchStockPhoto({ projectId: PROJECT, query: 'espresso bar interior' }),
    ).rejects.toThrow(/unsplash: No Unsplash photo matched.*openverse: no CC0 or public-domain/s);
    // The query widens before it gives up, but only a bounded number of times.
    expect(calledUrls(OPENVERSE)).toHaveLength(3);
    expect(persist.persistOptimizedAsset).not.toHaveBeenCalled();
  });

  it('stops asking Unsplash for the rest of a generation once it answers 429', async () => {
    settings.getSetting.mockResolvedValue('a-configured-key');
    route([
      [UNSPLASH, () => jsonResponse({ detail: 'Rate Limit Exceeded' }, 429)],
      [OPENVERSE, () => jsonResponse(REAL_OPENVERSE_PAYLOAD)],
      [/cdn\.stocksnap\.io/, () => imageResponse()],
    ]);

    const out = await fulfillNeedImages({
      projectId: PROJECT,
      userId: 'u-1',
      sourceOverride: 'stock',
      files: [
        {
          path: 'index.html',
          content:
            '<img src="NEED_IMAGE: espresso bar interior | 16:9">' +
            '<img src="NEED_IMAGE: sourdough bread counter | 4:5">',
        },
      ],
    });

    // Both photos sourced, and the limited endpoint was asked exactly once.
    expect(calledUrls(UNSPLASH)).toHaveLength(1);
    expect(out.unfulfilled).toEqual([]);
    expect(out[0]?.content).not.toContain('data:image/svg+xml');
    expect(out[0]?.content).not.toContain('NEED_IMAGE');
  });
});

describe('openverse response parsing', () => {
  it('reads the fields of a real Openverse payload', () => {
    const candidates = parseOpenverseResults(REAL_OPENVERSE_PAYLOAD);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      url: 'https://cdn.stocksnap.io/img-thumbs/960w/T2DS9PUWRZ.jpg',
      title: 'Espresso Coffee',
      creator: 'Burst',
      license: 'cc0',
      width: 5472,
      height: 3648,
    });
    // Tags feed relevance scoring, so they must survive the parse.
    expect(candidates[0].haystack).toContain('espresso');
  });

  it('drops any licence that would oblige the site owner to credit', () => {
    const candidates = parseOpenverseResults({
      results: [
        { url: 'https://cdn.example.com/by.jpg', license: 'by', filetype: 'jpg', title: 'CC-BY' },
        { url: 'https://cdn.example.com/bysa.jpg', license: 'by-sa', filetype: 'jpg', title: 'SA' },
        { url: 'https://cdn.example.com/ok.jpg', license: 'pdm', filetype: 'jpg', title: 'Public' },
      ],
    });

    expect(candidates.map((candidate) => candidate.license)).toEqual(['pdm']);
  });

  it('tolerates a body that is not a search result at all', () => {
    expect(parseOpenverseResults(null)).toEqual([]);
    expect(parseOpenverseResults({ detail: 'Not found' })).toEqual([]);
  });

  it('puts the subject noun ahead of framing words', () => {
    // Position-based truncation searched "interior artisan" and returned porcelain
    // bowls; the subject word has to come first for a conjunctive search.
    expect(
      openverseKeywords(
        'warm interior of an artisan coffee bar with a barista pulling an espresso shot',
      )[0],
    ).toBe('espresso');
    expect(openverseKeywords('a plate of fresh sourdough bread on a rustic wooden table')[0]).toBe(
      'sourdough',
    );
  });
});

describe('fulfillNeedImages reporting', () => {
  const files = [{ path: 'index.html', content: '<img src="NEED_IMAGE: espresso bar | 16:9">' }];

  it('reports the unfulfilled image and why, instead of only warning', async () => {
    settings.getSetting.mockResolvedValue('a-configured-key');
    route([
      [UNSPLASH, () => jsonResponse({ results: [] })],
      [OPENVERSE, () => jsonResponse({ result_count: 0, results: [] })],
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = await fulfillNeedImages({
      projectId: PROJECT,
      userId: 'u-1',
      sourceOverride: 'stock',
      files,
    });

    warn.mockRestore();
    // The placeholder still ships — one missing photo must not fail the build —
    // but the caller can now say why rather than presenting a grey box as success.
    expect(out[0]?.content).toContain('data:image/svg+xml');
    expect(out.unfulfilled).toHaveLength(1);
    expect(out.unfulfilled[0]).toMatchObject({ description: 'espresso bar', aspect: '16:9' });
    expect(out.unfulfilled[0].reason).toMatch(/unsplash: .*openverse: /s);
  });

  it('reports nothing unfulfilled when every photo was sourced', async () => {
    settings.getSetting.mockResolvedValue(null);
    route([
      [OPENVERSE, () => jsonResponse(REAL_OPENVERSE_PAYLOAD)],
      [/cdn\.stocksnap\.io/, () => imageResponse()],
    ]);

    const out = await fulfillNeedImages({
      projectId: PROJECT,
      userId: 'u-1',
      sourceOverride: 'stock',
      files,
    });

    expect(out.unfulfilled).toEqual([]);
    expect(out[0]?.content).toContain('/uploads/projects/');
  });

  it('leaves a file with no directives untouched and reports nothing', async () => {
    const out = await fulfillNeedImages({
      projectId: PROJECT,
      userId: 'u-1',
      files: [{ path: 'index.html', content: '<p>no images here</p>' }],
    });

    expect(out.unfulfilled).toEqual([]);
    expect(out[0]?.content).toBe('<p>no images here</p>');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
