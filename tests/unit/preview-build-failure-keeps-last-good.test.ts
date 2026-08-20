import { describe, expect, it, vi } from 'vitest';
import { buildStaticPreview } from '@/lib/preview/build';
import type { BuildStaticPreviewDeps, PreviewMode } from '@/lib/preview/types';

/**
 * A build that failed is not a build. Two rules, one place:
 *
 * - Only a READY build is ever adopted as `Project.activePreviewBuildId`, so a
 *   failed rebuild leaves the last good build serving. The status read used to
 *   derive its URL from "any READY build for this project" while
 *   `/preview-static` serves `activePreviewBuildId`, so the two could disagree
 *   and the product handed out a link its own route answers 404 (F-147).
 * - A throw from storage mid-upload must land on the same failure path. It used
 *   to propagate out of `buildStaticPreview`, leaving the row BUILDING forever —
 *   `getPreviewStatus` then reported `preparing` and the workspace polled every
 *   two seconds for the life of the tab (F-146).
 */

type Recorded = {
  setProjectPreview: Array<{ activePreviewBuildId: string | null; fromBuildId?: string }>;
  failed: Array<{ id: string; storagePrefix?: string | null }>;
  ready: string[];
};

function deps(over: { upload?: BuildStaticPreviewDeps['storage']['upload'] } = {}) {
  const recorded: Recorded = { setProjectPreview: [], failed: [], ready: [] };
  const built: BuildStaticPreviewDeps = {
    stack: 'STATIC_HTML',
    files: { 'index.html': '<html><body>Hi</body></html>' },
    store: {
      createBuilding: async () => ({ id: 'b2', status: 'BUILDING', mode: 'STATIC' as PreviewMode }),
      markFailed: async (id, input) => {
        recorded.failed.push({ id, storagePrefix: input.storagePrefix });
      },
      markReady: async (id) => {
        recorded.ready.push(id);
      },
      setProjectPreview: async (_projectId, input) => {
        recorded.setProjectPreview.push(input);
      },
    },
    storage: { upload: over.upload ?? (async () => {}) },
  };
  return { recorded, built };
}

describe('a failed preview build', () => {
  it('does not touch the project pointer, so the last good build stays active', async () => {
    const { recorded, built } = deps();
    // No index.html for the STATIC_HTML stack: the assembler refuses before any
    // upload, which is the ordinary "the new code does not build" failure.
    built.files = { 'README.md': '# nothing to serve' };

    const result = await buildStaticPreview('p1', 'cp2', built);

    expect(result).toMatchObject({ ok: false, buildId: 'b2' });
    expect(recorded.failed).toEqual([{ id: 'b2', storagePrefix: null }]);
    // The one thing that must not happen: unseating a build that works.
    expect(recorded.setProjectPreview).toEqual([]);
  });

  it('marks the row FAILED when storage throws mid-upload instead of leaving it BUILDING', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { recorded, built } = deps({
      upload: async () => {
        throw new Error('S3 503');
      },
    });

    const result = await buildStaticPreview('p1', 'cp3', built);

    expect(result).toMatchObject({ ok: false, buildId: 'b2' });
    expect(recorded.failed).toEqual([{ id: 'b2', storagePrefix: 'previews/p1/b2' }]);
    expect(recorded.ready).toEqual([]);
    expect(recorded.setProjectPreview).toEqual([]);
    vi.restoreAllMocks();
  });

  it('records the storage prefix on the failed row, so the pruner can find the bytes', async () => {
    const { recorded, built } = deps({
      upload: async () => {
        throw new Error('S3 503');
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await buildStaticPreview('p1', 'cp4', built);

    // A half-finished upload leaves objects behind, and the row is the only
    // thing in the product that names them.
    expect(recorded.failed[0]?.storagePrefix).toBe('previews/p1/b2');
    vi.restoreAllMocks();
  });
});

describe('a successful preview build', () => {
  it('adopts itself as the active build', async () => {
    const { recorded, built } = deps();

    const result = await buildStaticPreview('p1', 'cp5', built);

    expect(result).toMatchObject({ ok: true, buildId: 'b2' });
    expect(recorded.ready).toEqual(['b2']);
    expect(recorded.setProjectPreview).toEqual([
      { previewMode: 'STATIC', activePreviewBuildId: 'b2', fromBuildId: 'b2' },
    ]);
  });
});
