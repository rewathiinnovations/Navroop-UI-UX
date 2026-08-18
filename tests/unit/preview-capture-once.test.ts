import { afterEach, describe, expect, it } from 'vitest';
import {
  capturePreviewAfterGeneration,
  previewCaptureKey,
  resetPreviewCaptureInflight,
  shouldAdoptPreviewBuild,
  shouldSkipPreviewCapture,
} from '../../lib/preview/after-generation';

describe('preview capture once per generation', () => {
  afterEach(() => {
    resetPreviewCaptureInflight();
  });

  it('runs the capture work once when the same generation is persisted twice', async () => {
    let calls = 0;
    const work = async () => {
      calls += 1;
      return { ok: true as const };
    };
    const opts = {
      projectId: 'proj-1',
      checkpointId: 'cp-1',
      checkpointCreatedAt: new Date('2026-08-18T08:00:00.000Z'),
    };

    await capturePreviewAfterGeneration(work, opts);
    await capturePreviewAfterGeneration(work, opts);

    expect(calls).toBe(1);
    expect(previewCaptureKey(opts.projectId, opts.checkpointId)).toBe('proj-1:cp-1');
  });

  it('joins an in-flight capture for the same checkpoint instead of starting a second sandbox build', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const work = async () => {
      calls += 1;
      await gate;
      return { ok: true as const };
    };
    const opts = {
      projectId: 'proj-1',
      checkpointId: 'cp-1',
      checkpointCreatedAt: new Date('2026-08-18T08:00:00.000Z'),
    };

    const first = capturePreviewAfterGeneration(work, opts);
    const second = capturePreviewAfterGeneration(work, opts);
    release();
    await Promise.all([first, second]);

    expect(calls).toBe(1);
  });

  it('captures again when a later persist has a newer checkpoint', async () => {
    let calls = 0;
    const work = async () => {
      calls += 1;
      return { ok: true as const };
    };

    await capturePreviewAfterGeneration(work, {
      projectId: 'proj-1',
      checkpointId: 'cp-1',
      checkpointCreatedAt: new Date('2026-08-18T08:00:00.000Z'),
    });
    await capturePreviewAfterGeneration(work, {
      projectId: 'proj-1',
      checkpointId: 'cp-2',
      checkpointCreatedAt: new Date('2026-08-18T08:01:00.000Z'),
    });

    expect(calls).toBe(2);
  });
});

describe('shouldSkipPreviewCapture', () => {
  it('skips a READY or BUILDING preview for this checkpoint', () => {
    expect(shouldSkipPreviewCapture({ status: 'READY' })).toBe(true);
    expect(shouldSkipPreviewCapture({ status: 'BUILDING' })).toBe(true);
    expect(shouldSkipPreviewCapture({ status: 'FAILED' })).toBe(false);
    expect(shouldSkipPreviewCapture(null)).toBe(false);
    expect(
      shouldSkipPreviewCapture({
        status: 'BUILDING',
        createdAt: new Date(Date.now() - 6 * 60 * 1000),
      }),
    ).toBe(false);
  });
});

describe('shouldAdoptPreviewBuild', () => {
  const older = new Date('2026-08-18T08:00:00.000Z');
  const newer = new Date('2026-08-18T08:01:00.000Z');

  it('adopts when there is no current active preview', () => {
    expect(
      shouldAdoptPreviewBuild({
        incomingId: 'new',
        incomingCreatedAt: newer,
        currentId: null,
        currentCreatedAt: null,
      }),
    ).toBe(true);
  });

  it('does not let an older build overwrite a newer activePreviewBuildId', () => {
    expect(
      shouldAdoptPreviewBuild({
        incomingId: 'stale',
        incomingCreatedAt: older,
        currentId: 'fresh',
        currentCreatedAt: newer,
      }),
    ).toBe(false);
  });

  it('adopts a newer build over an older active one', () => {
    expect(
      shouldAdoptPreviewBuild({
        incomingId: 'fresh',
        incomingCreatedAt: newer,
        currentId: 'stale',
        currentCreatedAt: older,
      }),
    ).toBe(true);
  });
});
