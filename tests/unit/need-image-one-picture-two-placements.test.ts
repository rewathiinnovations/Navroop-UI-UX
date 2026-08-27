import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Two placements of one request must cost one image and rewrite both `src`s.
 *
 * `… | 1:1` and `… | 1:1 | About section` normalise to the same aspect, so they are
 * the same picture and the parser keeps one of them — correctly, because buying the
 * same photograph twice is exactly what `needImageKey` exists to prevent. What was
 * wrong is what happened next: fulfilment rewrote the text of the directive it kept,
 * and `content.split(token).join(url)` then matched the second occurrence only as far
 * as the two share, so the About section shipped
 * `src="https://cdn/x.png | About section"` — a URL with a space in it that resolves
 * to nothing. No placeholder, because `sweepNeedImageTokens` looks for the
 * `NEED_IMAGE:` marker and the marker had just been replaced; no `unfulfilled` entry,
 * because as far as the pipeline was concerned that image had been fulfilled.
 */

const images = vi.hoisted(() => ({
  generateImage: vi.fn(),
  imageWorkerConfig: vi.fn(),
  searchStockPhoto: vi.fn(),
}));

vi.mock('@/lib/assets/generate-image', () => ({ generateImage: images.generateImage }));
vi.mock('@/lib/assets/image-worker', () => ({ imageWorkerConfig: images.imageWorkerConfig }));
vi.mock('@/lib/assets/stock-photo', () => ({ searchStockPhoto: images.searchStockPhoto }));

/** Not under test, and they pull prisma in for real. */
vi.mock('@/lib/plans/limits', () => ({ checkCredits: vi.fn(), consumeCredits: vi.fn() }));
vi.mock('@/lib/storage/usage', () => ({ WORKSPACE_ROW_ID: 'default', adjustStorageBytes: vi.fn() }));
vi.mock('@/lib/observability/track', () => ({ trackFailure: vi.fn() }));

import {
  fulfillNeedImages,
  fulfillNeedImagesFromReply,
  MAX_REPLY_SOURCED_IMAGES,
} from '@/lib/assets/fulfill';

const PROJECT = 'p-placements';
const USER = 'u-placements';
const CDN = 'https://cdn.example.com/x.png';

/** Verbatim shape from the review: one subject, two sections, one annotation. */
const TWO_PLACEMENTS = [
  '<img src="NEED_IMAGE: cafe interior | 1:1">',
  '<img src="NEED_IMAGE: cafe interior | 1:1 | About section">',
].join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  // The operator's own worker, so nothing here is metered and no credit path runs.
  images.imageWorkerConfig.mockResolvedValue({
    url: 'https://worker.example.com',
    token: 't',
    model: 'lucid-origin',
  });
  images.generateImage.mockResolvedValue({ url: CDN, provider: 'worker' });
});

describe('one picture is bought once and placed everywhere it was asked for', () => {
  it('rewrites both occurrences in full, annotation and all', async () => {
    const out = await fulfillNeedImages({
      projectId: PROJECT,
      userId: USER,
      files: [{ path: 'index.html', content: TWO_PLACEMENTS }],
    });

    expect(images.generateImage).toHaveBeenCalledTimes(1);
    expect(out.requested).toBe(1);
    expect(out.fulfilled).toBe(1);
    expect(out.unfulfilled).toEqual([]);
    expect(out[0].content).toBe(`<img src="${CDN}">\n<img src="${CDN}">`);
  });

  it('generates at the aspect that was asked for, not the default', async () => {
    await fulfillNeedImages({
      projectId: PROJECT,
      userId: USER,
      files: [{ path: 'index.html', content: TWO_PLACEMENTS }],
    });

    expect(images.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'cafe interior', aspectRatio: '1:1' }),
    );
  });

  it('placeholders both occurrences when no provider can answer', async () => {
    images.generateImage.mockRejectedValue(new Error('worker unreachable'));
    images.searchStockPhoto.mockRejectedValue(new Error('no stock provider configured'));

    const out = await fulfillNeedImages({
      projectId: PROJECT,
      userId: USER,
      files: [{ path: 'index.html', content: TWO_PLACEMENTS }],
    });

    expect(out.unfulfilled).toHaveLength(1);
    expect(out[0].content).not.toContain('NEED_IMAGE');
    // The annotation belongs to the token, so it leaves with it rather than sitting
    // in the `src` beside a data URI.
    expect(out[0].content).not.toContain('About section');
  });
});

describe('a request written as prose buys the subject it names', () => {
  it('reads past an apostrophe and honours the aspect', async () => {
    // Verbatim from the review. Read with the file terminators, the description
    // stopped at the `'` and the aspect went with the rest of the line, so the credit
    // bought "a barista" at the default 16:9.
    const out = await fulfillNeedImagesFromReply({
      projectId: PROJECT,
      userId: USER,
      text: "- NEED_IMAGE: a barista's hands pouring chai | 1:1",
    });

    expect(out).toMatchObject({ requested: 1, attempted: 1, fulfilled: 1 });
    expect(images.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "a barista's hands pouring chai",
        aspectRatio: '1:1',
      }),
    );
  });

  /**
   * The cap is a spend ceiling, and a ceiling nothing imports is a ceiling a
   * refactor can raise or delete without a single test going red. A file-sourced
   * request is bounded by the site itself — the token has to sit in a `src` — but
   * reply prose has no such bound, so a chatty model listing a dozen "nice to
   * have" pictures would buy a dozen.
   */
  it('never buys more pictures than the cap, however many the reply lists', async () => {
    expect(MAX_REPLY_SOURCED_IMAGES).toBe(6);

    const asked = MAX_REPLY_SOURCED_IMAGES + 4;
    const text = Array.from(
      { length: asked },
      (_unused, index) => `- NEED_IMAGE: shopfront number ${index} | 16:9`,
    ).join('\n');

    const out = await fulfillNeedImagesFromReply({ projectId: PROJECT, userId: USER, text });

    // `requested` reports the truth about the reply; only `attempted` is capped,
    // so the log can say "asked for ten, bought six" rather than hiding the four.
    expect(out.requested).toBe(asked);
    expect(out.attempted).toBe(MAX_REPLY_SOURCED_IMAGES);
    expect(out.fulfilled).toBe(MAX_REPLY_SOURCED_IMAGES);
    expect(images.generateImage).toHaveBeenCalledTimes(MAX_REPLY_SOURCED_IMAGES);
  });
});
