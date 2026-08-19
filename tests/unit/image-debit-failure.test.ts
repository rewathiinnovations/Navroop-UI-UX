import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateProjectImage } from '@/lib/assets/actions';
import { fulfillNeedImages } from '@/lib/assets/fulfill';

/**
 * Image generation pays a provider, persists a ProjectAsset and only then debits
 * the workspace. Both paths used to run the debit inside the same try as the
 * generation, so a `consumeCredits` throw — a CreditLimitError because a
 * concurrent request took the last credit between the pre-flight and the debit,
 * or a plain connection blip — was reported as a failed generation. The asset row
 * and its stored file stayed behind (or, in the NEED_IMAGE path, the finished
 * image was replaced by a placeholder), the user was told nothing happened, and
 * real provider spend was never billed to anyone.
 *
 * The debit now has its own catch: the paid work is kept and the uncharged spend
 * is logged as `credits.image_debit_failed` so it can be reconciled. A refusal
 * *before* the provider call must still fail the request — that is the case that
 * saves money. Both are asserted here, alongside the healthy controls.
 */

const db = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  assetDelete: vi.fn(),
}));
const auth = vi.hoisted(() => ({ getSessionUser: vi.fn() }));
const images = vi.hoisted(() => ({ generateImage: vi.fn(), searchStockPhoto: vi.fn() }));
const credits = vi.hoisted(() => ({ checkCredits: vi.fn(), consumeCredits: vi.fn() }));

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findFirst: db.projectFindFirst },
    projectAsset: { delete: db.assetDelete },
  },
}));

/** next-auth cannot resolve `next/server` outside the Next runtime. */
vi.mock('@/lib/auth', () => ({ getSessionUser: auth.getSessionUser }));

vi.mock('@/lib/assets/generate-image', () => ({ generateImage: images.generateImage }));
vi.mock('@/lib/assets/stock-photo', () => ({ searchStockPhoto: images.searchStockPhoto }));

/** Not under test, and it pulls sharp in for real. */
vi.mock('@/lib/assets/persist', () => ({ persistOptimizedAsset: vi.fn() }));
vi.mock('@/lib/storage', () => ({ deleteObject: vi.fn() }));

vi.mock('@/lib/plans/limits', () => ({
  checkCredits: credits.checkCredits,
  consumeCredits: credits.consumeCredits,
}));

const OWNER = { id: 'u-owner', email: 'owner@example.com', name: 'Owner', role: 'MEMBER' as const };
const PROJECT = 'p-assets';

const ASSET = {
  id: 'a-generated',
  url: '/uploads/projects/p-assets/assets/a-generated.webp',
  kind: 'generated',
  prompt: 'a bakery hero',
  altText: 'A bakery storefront at sunrise',
  width: 1536,
  height: 1024,
  sizeBytes: 140_000,
  createdAt: new Date('2026-08-19T10:00:00.000Z'),
};

/** The message a racing debit raises: see CreditLimitError in lib/plans/limits.ts. */
const EXHAUSTED = "This month's credits are used up";

let lines: string[];

function loggedEvent(event: string) {
  const line = lines.find((text) => text.includes(`"event":"${event}"`));
  return line ? (JSON.parse(line) as Record<string, unknown>) : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  lines = [];
  const capture = (line: unknown) => lines.push(String(line));
  vi.spyOn(console, 'error').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);

  auth.getSessionUser.mockResolvedValue(OWNER);
  db.projectFindFirst.mockResolvedValue({ id: PROJECT, ownerId: OWNER.id });
  images.generateImage.mockResolvedValue(ASSET);
  credits.checkCredits.mockResolvedValue({ ok: true, cost: 1 });
  credits.consumeCredits.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('generateProjectImage when the debit fails after the provider was paid', () => {
  it('keeps the asset, tells the caller it worked, and logs the uncharged spend', async () => {
    credits.consumeCredits.mockRejectedValue(new Error(EXHAUSTED));

    const result = await generateProjectImage(PROJECT, 'a bakery hero', '16:9');

    expect(result).toMatchObject({ ok: true, data: { id: ASSET.id, url: ASSET.url } });
    // The asset the caller was just handed must still exist.
    expect(db.assetDelete).not.toHaveBeenCalled();
    expect(loggedEvent('credits.image_debit_failed')).toMatchObject({
      level: 'error',
      projectId: PROJECT,
      assetId: ASSET.id,
      error: EXHAUSTED,
    });
  });

  it('reports success with no log when the debit lands', async () => {
    const result = await generateProjectImage(PROJECT, 'a bakery hero', '16:9');

    expect(result).toMatchObject({ ok: true, data: { id: ASSET.id } });
    expect(credits.consumeCredits).toHaveBeenCalledTimes(1);
    expect(loggedEvent('credits.image_debit_failed')).toBeNull();
  });

  it('still refuses before the provider call when the pre-flight denies', async () => {
    credits.checkCredits.mockResolvedValue({
      ok: false,
      reason: 'workspace_exhausted',
      used: 100,
      limit: 100,
      message: EXHAUSTED,
    });

    const result = await generateProjectImage(PROJECT, 'a bakery hero', '16:9');

    expect(result).toMatchObject({ ok: false, error: EXHAUSTED });
    expect(images.generateImage).not.toHaveBeenCalled();
    expect(credits.consumeCredits).not.toHaveBeenCalled();
  });

  it('still reports a genuine generation failure as a failure', async () => {
    images.generateImage.mockRejectedValue(new Error('No image generation provider configured'));

    const result = await generateProjectImage(PROJECT, 'a bakery hero', '16:9');

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: 'No image generation provider configured',
    });
    expect(credits.consumeCredits).not.toHaveBeenCalled();
  });
});

describe('fulfillNeedImages when the debit fails after the provider was paid', () => {
  const files = [
    { path: 'src/App.jsx', content: '<img src="NEED_IMAGE: a bakery hero | 16:9" alt="" />' },
  ];

  it('keeps the generated image in the file and logs the uncharged spend', async () => {
    credits.consumeCredits.mockRejectedValue(new Error(EXHAUSTED));

    const out = await fulfillNeedImages({
      projectId: PROJECT,
      userId: OWNER.id,
      files,
      sourceOverride: 'generated',
    });

    expect(out[0]?.content).toContain(ASSET.url);
    // Not the neutral panel the outer catch used to fall through to.
    expect(out[0]?.content).not.toContain('data:image/svg+xml');
    expect(loggedEvent('credits.image_debit_failed')).toMatchObject({
      level: 'error',
      projectId: PROJECT,
      error: EXHAUSTED,
    });
  });

  it('keeps the generated image with no log when the debit lands', async () => {
    const out = await fulfillNeedImages({
      projectId: PROJECT,
      userId: OWNER.id,
      files,
      sourceOverride: 'generated',
    });

    expect(out[0]?.content).toContain(ASSET.url);
    expect(credits.consumeCredits).toHaveBeenCalledTimes(1);
    expect(loggedEvent('credits.image_debit_failed')).toBeNull();
  });

  it('skips the provider entirely when the pre-flight denies', async () => {
    credits.checkCredits.mockResolvedValue({
      ok: false,
      reason: 'workspace_exhausted',
      used: 100,
      limit: 100,
      message: EXHAUSTED,
    });

    const out = await fulfillNeedImages({
      projectId: PROJECT,
      userId: OWNER.id,
      files,
      sourceOverride: 'generated',
    });

    expect(images.generateImage).not.toHaveBeenCalled();
    expect(out[0]?.content).toContain('data:image/svg+xml');
  });
});
