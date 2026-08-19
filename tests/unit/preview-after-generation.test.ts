import { describe, expect, it } from 'vitest';
import {
  LIVE_MODE_START_FAILED,
  PREVIEW_EMPTY,
  PREVIEW_NOT_READY_NOTICE,
} from '../../lib/preview/labels';
import {
  capturePreviewAfterGeneration,
  noticeForLiveModeStart,
  noticeForPreviewAfterGeneration,
  previewPaneKind,
} from '../../lib/preview/after-generation';

describe('preview after a successful generation', () => {
  it('is silent when the preview built', () => {
    expect(noticeForPreviewAfterGeneration({ ok: true })).toBeNull();
  });

  it('says the preview is not ready — not that the build failed — when preview fails or is skipped', () => {
    expect(noticeForPreviewAfterGeneration({ ok: false, error: 'export failed' })).toBe(
      PREVIEW_NOT_READY_NOTICE,
    );
    expect(
      noticeForPreviewAfterGeneration({ ok: false, skipped: true, reason: 'no_live_sandbox' }),
    ).toBe(PREVIEW_NOT_READY_NOTICE);
    expect(PREVIEW_NOT_READY_NOTICE).toMatch(/not ready/i);
    expect(PREVIEW_NOT_READY_NOTICE).not.toMatch(/build failed/i);
    // Names the published snapshot specifically, so it cannot be read as
    // "your site is gone" — the site renders in the workspace either way.
    expect(PREVIEW_NOT_READY_NOTICE).toMatch(/snapshot/i);
  });

  it('captures a thrown preview build as the same user notice', async () => {
    const captured = await capturePreviewAfterGeneration(async () => {
      throw new Error('preview exploded');
    });
    expect(captured.notice).toBe(PREVIEW_NOT_READY_NOTICE);
    expect(captured.error).toBeInstanceOf(Error);
  });
});

describe('live mode start and empty preview pane', () => {
  it('explains a failed Live mode start instead of returning silently', () => {
    expect(noticeForLiveModeStart(true)).toBeNull();
    expect(noticeForLiveModeStart(false)).toBe(LIVE_MODE_START_FAILED);
  });

  it('is empty only when the project has no files at all', () => {
    expect(
      previewPaneKind({
        phase: 'COMPLETE',
        hasFiles: false,
        previewUrl: null,
        preparing: false,
        previewBuildFailed: false,
      }),
    ).toBe('empty');
    expect(PREVIEW_EMPTY).toMatch(/nothing to preview/i);
  });

  it('is ready on stored files alone — the preview compiles them in the browser', () => {
    // Keying this off a sandbox preview URL made every finished project fall
    // through to the empty state once the VMs were gone.
    expect(previewPaneKind({ phase: 'COMPLETE', hasFiles: true, previewUrl: null })).toBe('ready');
  });

  it('keeps the planning empty state and a ready preview distinct', () => {
    expect(previewPaneKind({ phase: 'PLANNING', planTrigger: 'initial', previewUrl: null })).toBe(
      'planning',
    );
    expect(previewPaneKind({ phase: 'COMPLETE', previewUrl: '/preview-static/p/index.html' })).toBe(
      'ready',
    );
  });
});
