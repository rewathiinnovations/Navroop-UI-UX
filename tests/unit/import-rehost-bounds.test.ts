import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_REHOST_ASSETS,
  MAX_REHOST_MS,
  REHOST_CONCURRENCY,
  rehostImportAssets,
} from '@/lib/import/rehost-assets';
import type { CapturedImage, RehostedAsset } from '@/lib/import/types';

/**
 * F-125: `document.images` was captured unbounded (the background-image path is
 * capped at 400 DOM nodes, that one was not) and `rehostImportAssets` then
 * looped the whole list serially — one network fetch of up to 10 MB, one sharp
 * re-encode and one storage upload each. Importing a gallery or a catalogue
 * meant an import that ran for many minutes, could not be cancelled (the job
 * heartbeat keeps it alive, so the reaper never clears it), and wrote hundreds
 * of asset rows.
 */

function images(count: number): CapturedImage[] {
  return Array.from({ length: count }, (_, index) => ({
    url: `https://cdn.example.com/photo-${index}.png`,
    width: 100,
    height: 80,
  }));
}

function okResponse() {
  return new Response(new Uint8Array(64), {
    status: 200,
    headers: { 'content-type': 'image/png' },
  });
}

function persistStub() {
  return vi.fn(
    async (_buffer: Buffer, altText: string, sourceUrl: string): Promise<RehostedAsset> => ({
      url: `/uploads/${altText}.webp`,
      altText,
      width: 100,
      height: 80,
      sourceUrl,
    }),
  );
}

describe('rehostImportAssets is bounded', () => {
  it('stops at the asset cap and says how many it left', async () => {
    const persist = persistStub();
    const fetchImpl = vi.fn(async () => okResponse());

    const result = await rehostImportAssets({
      projectId: 'proj_test',
      images: images(MAX_REHOST_ASSETS + 20),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      persist,
    });

    expect(result.assets).toHaveLength(MAX_REHOST_ASSETS);
    // The cap is a cap on work, not only on rows: the images past it are never
    // fetched and never re-encoded.
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_REHOST_ASSETS);
    expect(persist).toHaveBeenCalledTimes(MAX_REHOST_ASSETS);
    expect(result.warnings).toContain(
      `skipped 20 more images (limit ${MAX_REHOST_ASSETS} per import)`,
    );
  });

  it('stops when the time budget is spent, whatever the count', async () => {
    let elapsed = 0;
    const persist = persistStub();
    const fetchImpl = vi.fn(async () => {
      // One slow host is enough: each image costs a third of the whole budget.
      elapsed += MAX_REHOST_MS / 3;
      return okResponse();
    });

    const result = await rehostImportAssets({
      projectId: 'proj_test',
      images: images(30),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      persist,
      clock: () => elapsed,
    });

    expect(result.assets).toHaveLength(REHOST_CONCURRENCY);
    expect(fetchImpl).toHaveBeenCalledTimes(REHOST_CONCURRENCY);
    // The images it did not get to are named, not silently dropped.
    expect(result.warnings.some((warning) => /stopped after \d+s/.test(warning))).toBe(true);
    expect(result.warnings.join(' ')).toContain(`${30 - REHOST_CONCURRENCY} images`);
  });

  it('fetches in bounded batches rather than one at a time', async () => {
    let live = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async () => {
      live += 1;
      peak = Math.max(peak, live);
      // A yield, no timer: a serial loop would let each call finish here, so
      // `live` could never exceed 1.
      await Promise.resolve();
      live -= 1;
      return okResponse();
    });

    await rehostImportAssets({
      projectId: 'proj_test',
      images: images(REHOST_CONCURRENCY * 2),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      persist: persistStub(),
    });

    expect(peak).toBe(REHOST_CONCURRENCY);
  });

  it('still de-duplicates and still reports a data URL', async () => {
    const persist = persistStub();

    const result = await rehostImportAssets({
      projectId: 'proj_test',
      images: [
        { url: 'https://cdn.example.com/a.png', width: 10, height: 10 },
        { url: 'https://cdn.example.com/a.png', width: 10, height: 10 },
        { url: 'data:image/png;base64,AAAA', width: 10, height: 10 },
      ],
      fetchImpl: (async () => okResponse()) as unknown as typeof fetch,
      persist,
    });

    expect(persist).toHaveBeenCalledTimes(1);
    expect(result.warnings).toContain('skipped data URL');
  });
});

describe('the capture stage does not hand over more than the rehost stage will use', () => {
  it('caps the images collected in the page evaluate', () => {
    const source = readFileSync(path.join(process.cwd(), 'lib/import/capture.ts'), 'utf8');

    // Verified here rather than behaviourally: the cap lives inside the
    // `page.evaluate` body, which only runs in a real browser context.
    expect(source).toMatch(/MAX_REHOST_ASSETS/);
    expect(source).toMatch(/images\.length\s*>=\s*maxImages/);
  });
});
