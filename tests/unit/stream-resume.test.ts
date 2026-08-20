import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RESUME_NOTICE,
  applyResumedFiles,
  resumeStep,
  type ResumeSnapshot,
} from '../../lib/generation/stream-resume';
import { EMPTY_GENERATION_PROGRESS } from '../../lib/generation/types';
import {
  clearGeneration,
  executeGenerationJob,
  getGenerationState,
  setGenerationProjectId,
  startGeneration,
  subscribeGenerationJobs,
} from '../../lib/generation/generation-runtime';

/**
 * F-092 — the SSE consumer was a one-shot read of one fetch body. There were no event
 * ids, no `Last-Event-ID`, and no reconnect, so a dropped connection ended the live view
 * for the rest of the build: no more file names, no code-panel updates, nothing. Wave 1
 * made the drop *honest* (one system line, no invented status). It still went quiet.
 *
 * Resume is reattachment, not a new subsystem: the running job already persists its
 * partial files, its current step and a heartbeat, so after a drop the client polls that
 * row and replays what the build has written since. Token-level `stream` frames cannot be
 * replayed and are not pretended to be; the file set and the step can, and those are what
 * the finding says the user loses.
 */

const SNAPSHOT: ResumeSnapshot = {
  status: 'RUNNING',
  currentStep: 'Writing src/App.jsx',
  lastStep: null,
  heartbeatAt: new Date().toISOString(),
  files: [{ path: 'src/App.jsx', content: 'export default function App() { return null; }' }],
  errorCode: null,
  errorMessage: null,
};

describe('resumeStep', () => {
  const now = new Date('2026-08-21T10:00:00.000Z');
  const fresh = new Date(now.getTime() - 5_000).toISOString();

  it('replays while the job is running and its heartbeat is fresh', () => {
    const step = resumeStep({
      snapshot: { ...SNAPSHOT, heartbeatAt: fresh },
      elapsedMs: 1_000,
      now,
    });
    expect(step).toEqual({ action: 'replay', delayMs: 2_000 });
  });

  it('backs off to the slow interval once the build is no longer young', () => {
    const step = resumeStep({
      snapshot: { ...SNAPSHOT, heartbeatAt: fresh },
      elapsedMs: 5 * 60_000,
      now,
    });
    expect(step).toEqual({ action: 'replay', delayMs: 10_000 });
  });

  it('stops when the job settles, whichever way it settled', () => {
    for (const status of ['SUCCEEDED', 'FAILED', 'CANCELLED', 'ABANDONED']) {
      expect(
        resumeStep({ snapshot: { ...SNAPSHOT, status, heartbeatAt: fresh }, elapsedMs: 0, now }),
      ).toEqual({ action: 'settled', status });
    }
  });

  it('stops when the heartbeat has gone stale, rather than polling a dead job forever', () => {
    const stale = new Date(now.getTime() - 5 * 60_000).toISOString();
    expect(
      resumeStep({ snapshot: { ...SNAPSHOT, heartbeatAt: stale }, elapsedMs: 0, now }),
    ).toEqual({ action: 'stop', reason: 'stale-heartbeat' });
  });

  it('stops when the poll knows of no job at all', () => {
    expect(resumeStep({ snapshot: null, elapsedMs: 0, now })).toEqual({
      action: 'stop',
      reason: 'no-job',
    });
  });

  it('stops at the same ceiling the workspace poller uses', () => {
    expect(
      resumeStep({
        snapshot: { ...SNAPSHOT, heartbeatAt: fresh },
        elapsedMs: 25 * 60_000,
        now,
      }),
    ).toEqual({ action: 'stop', reason: 'timeout' });
  });
});

describe('applyResumedFiles', () => {
  it('adds files the stream never got to announce, as completed entries', () => {
    const next = applyResumedFiles(EMPTY_GENERATION_PROGRESS, SNAPSHOT.files, 'Writing files');
    expect(next.files).toEqual([
      {
        path: 'src/App.jsx',
        content: 'export default function App() { return null; }',
        type: 'javascript',
        completed: true,
        edited: false,
      },
    ]);
    expect(next.status).toBe('Writing files');
    // Nothing is streaming into this tab any more; the build is still running.
    expect(next.isStreaming).toBe(false);
    expect(next.isGenerating).toBe(true);
    expect(next.isThinking).toBe(false);
  });

  it('is idempotent: replaying the same set twice does not duplicate a file', () => {
    const once = applyResumedFiles(EMPTY_GENERATION_PROGRESS, SNAPSHOT.files, 'step');
    const twice = applyResumedFiles(once, SNAPSHOT.files, 'step');
    expect(twice.files.map((file) => file.path)).toEqual(['src/App.jsx']);
  });

  it('completes a file the stream left half-written rather than keeping the stub', () => {
    const half = applyResumedFiles(EMPTY_GENERATION_PROGRESS, [], 'step');
    const withOpenFile = {
      ...half,
      files: [
        {
          path: 'src/App.jsx',
          content: 'export default fun',
          type: 'javascript',
          completed: false,
        },
      ],
    };
    const resumed = applyResumedFiles(withOpenFile, SNAPSHOT.files, 'step');
    expect(resumed.files).toHaveLength(1);
    expect(resumed.files[0].completed).toBe(true);
    expect(resumed.files[0].content).toBe(SNAPSHOT.files[0].content);
  });

  it('leaves the raw stream buffer and its cursor alone', () => {
    // The replay is file-level. Appending server bytes to `streamedCode` would make the
    // fence scanner re-parse a reply it never received and double-count files.
    const seeded = {
      ...EMPTY_GENERATION_PROGRESS,
      streamedCode: 'partial',
      lastProcessedPosition: 3,
    };
    const next = applyResumedFiles(seeded, SNAPSHOT.files, 'step');
    expect(next.streamedCode).toBe('partial');
    expect(next.lastProcessedPosition).toBe(3);
  });

  it('keeps already-known files in place and appends the new ones after them', () => {
    const first = applyResumedFiles(EMPTY_GENERATION_PROGRESS, SNAPSHOT.files, 'step');
    const second = applyResumedFiles(
      first,
      [...SNAPSHOT.files, { path: 'src/Hero.jsx', content: 'hero' }],
      'step',
    );
    expect(second.files.map((file) => file.path)).toEqual(['src/App.jsx', 'src/Hero.jsx']);
  });
});

/**
 * The runtime end to end: a body that ends with no terminal frame must now reattach and
 * keep reporting, instead of printing one line and going silent.
 */
describe('a dropped stream reattaches to the running job', () => {
  let unsubscribe: () => void;

  function sseResponse(frames: ReadonlyArray<Record<string, unknown>>) {
    const encoded = new TextEncoder().encode(
      frames.map((frame) => `data: ${JSON.stringify(frame)}\n`).join(''),
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }

  /** Answers the job poll with a queue of snapshots, one per call. */
  function stubStream(frames: ReadonlyArray<Record<string, unknown>>, polls: unknown[]) {
    const jobUrls: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/generate-ai-code-stream')) {
        return Promise.resolve(sseResponse(frames));
      }
      if (url.includes('/job')) {
        jobUrls.push(url);
        const job = polls.length > 1 ? polls.shift() : polls[0];
        return Promise.resolve(
          new Response(
            JSON.stringify({
              job,
              partialFiles: (job as { partialFiles?: unknown })?.partialFiles ?? [],
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
        );
      }
      void init;
      return Promise.resolve(
        new Response(JSON.stringify({ project: { id: 'proj-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    return jobUrls;
  }

  beforeEach(() => {
    clearGeneration();
    unsubscribe = subscribeGenerationJobs(executeGenerationJob);
    setGenerationProjectId('proj-1');
  });

  afterEach(() => {
    unsubscribe();
    clearGeneration();
    vi.unstubAllGlobals();
  });

  it('replays the files the build wrote after the drop, then reports how it ended', async () => {
    const running = {
      id: 'job-1',
      status: 'RUNNING',
      kind: 'BUILD',
      heartbeatAt: new Date().toISOString(),
      currentStep: 'Writing src/Hero.jsx',
      partialFiles: [
        { path: 'src/App.jsx', content: 'app' },
        { path: 'src/Hero.jsx', content: 'hero' },
      ],
    };
    const done = { ...running, status: 'SUCCEEDED', currentStep: null, errorCode: null };
    const jobUrls = stubStream([{ type: 'status', message: 'Generating…' }], [running, done]);

    const result = await startGeneration({ prompt: 'build a landing page', model: 'test-model' });

    expect(result.streamDropped).toBe(true);
    // The whole point of the finding: the file list caught up instead of freezing.
    expect(getGenerationState().generationProgress.files.map((file) => file.path)).toEqual([
      'src/App.jsx',
      'src/Hero.jsx',
    ]);
    // Partial files only come back when they are asked for — the 2s poller must not
    // start shipping file bytes on every tick.
    expect(jobUrls.some((url) => url.includes('files=1'))).toBe(true);

    const lines = getGenerationState().messages.map((message) => message.content);
    expect(lines).toContain(RESUME_NOTICE);
    expect(lines.some((line) => /finished|complete/i.test(line))).toBe(true);
  });

  it('gives up honestly when the job it reattached to has a stale heartbeat', async () => {
    const stale = {
      id: 'job-1',
      status: 'RUNNING',
      kind: 'BUILD',
      heartbeatAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      currentStep: 'Writing src/App.jsx',
      partialFiles: [],
    };
    stubStream([{ type: 'status', message: 'Generating…' }], [stale]);

    const result = await startGeneration({ prompt: 'build a landing page', model: 'test-model' });

    expect(result.streamDropped).toBe(true);
    const lines = getGenerationState().messages.map((message) => message.content);
    // Reattached, then said it could not keep watching — never claimed a verdict.
    expect(lines).toContain(RESUME_NOTICE);
    expect(lines.some((line) => /stopped responding|no longer|checking/i.test(line))).toBe(true);
    expect(getGenerationState().status).not.toBe('error');
  });
});
