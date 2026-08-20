import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearGeneration,
  executeGenerationJob,
  getGenerationState,
  setGenerationProjectId,
  startGeneration,
  STREAM_DROPPED_NOTICE,
  streamDropLine,
  subscribeGenerationJobs,
} from '../../lib/generation/generation-runtime';
import { isActiveGenerationStatus } from '../../lib/generation/types';

/**
 * A transport failure is not a generation failure.
 *
 * When the SSE body ended without a terminal frame — a slept laptop, a proxy cutting an
 * idle connection, a redeploy — the client threw, `executeGenerationJob` caught, and
 * `markGenerationError` PATCHed `generationStatus: 'error'` onto the project row. The
 * server's detached worker was still streaming and still persisted the site and settled
 * the job, so the row said `error` while the job said RUNNING and the build was fine
 * (F-036). The message was "Failed to generate recreation" for every early end, which is
 * URL-clone vocabulary and discards the reason the job row already carries (F-037).
 *
 * Goes red if the client writes a status it cannot know, or if a real server `error`
 * frame stops being written (the control).
 */

const FILE_BLOCK = '<file path="src/App.jsx">export default function App() { return null; }</file>';

type Patch = { url: string; body: Record<string, unknown> };

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

/**
 * Streams `frames`, records every PATCH the runtime sends, and answers the job poll
 * with `job`.
 */
function stubStream(frames: ReadonlyArray<Record<string, unknown>>, job?: unknown) {
  const patches: Patch[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/generate-ai-code-stream')) {
      return Promise.resolve(sseResponse(frames));
    }
    if (url.endsWith('/job')) {
      return Promise.resolve(
        new Response(JSON.stringify({ job: job ?? null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (init?.method === 'PATCH') {
      patches.push({ url, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> });
    }
    return Promise.resolve(
      new Response(JSON.stringify({ project: { id: 'proj-1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return patches;
}

describe('a dropped stream does not overwrite the server verdict', () => {
  let unsubscribe: () => void;

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

  it('writes no error status when the body ends with no terminal frame', async () => {
    const patches = stubStream([{ type: 'status', message: 'Generating…' }]);

    const result = await startGeneration({ prompt: 'build a landing page', model: 'test-model' });

    expect(result.streamDropped).toBe(true);
    expect(patches.some((patch) => patch.body.status === 'error')).toBe(false);
    expect(getGenerationState().status).not.toBe('error');
  });

  it('says the connection dropped rather than "Failed to generate recreation"', async () => {
    stubStream([{ type: 'status', message: 'Generating…' }]);

    await startGeneration({ prompt: 'build a landing page', model: 'test-model' });

    const lines = getGenerationState().messages.map((message) => message.content);
    expect(lines.some((line) => /connection/i.test(line))).toBe(true);
    expect(lines.some((line) => /recreation/i.test(line))).toBe(false);
  });

  // The 4-second heartbeat re-PATCHes `status` for as long as the runtime believes it is
  // generating, so leaving the status active would reinstate exactly the write the drop
  // path refuses to make. `isActiveGenerationStatus` is the interval's own kill switch.
  it('leaves no active status behind, so the heartbeat stops claiming the build', async () => {
    stubStream([{ type: 'status', message: 'Generating…' }]);

    await startGeneration({ prompt: 'build a landing page', model: 'test-model' });

    expect(isActiveGenerationStatus(getGenerationState().status)).toBe(false);
  });

  it('reports the job row reason when the poll knows one', async () => {
    stubStream([{ type: 'status', message: 'Generating…' }], {
      status: 'FAILED',
      errorCode: 'server_restarted',
      errorMessage: null,
    });

    await startGeneration({ prompt: 'build a landing page', model: 'test-model' });

    const lines = getGenerationState().messages.map((message) => message.content);
    expect(lines.some((line) => line.length > 0 && !/checking whether/i.test(line))).toBe(true);
  });

  // Control: the server's own verdict still reaches the project row. If this failed,
  // the tests above would be passing because nothing writes a status at all.
  it('control: an error frame still marks the run failed', async () => {
    const patches = stubStream([{ type: 'error', error: 'The AI service did not respond' }]);

    await expect(
      startGeneration({ prompt: 'build a landing page', model: 'test-model' }),
    ).rejects.toThrow(/did not respond/);

    expect(patches.some((patch) => patch.body.status === 'error')).toBe(true);
  });

  // Control: a complete frame is a terminal frame, so nothing is reported as dropped.
  it('control: a complete frame settles normally', async () => {
    stubStream([{ type: 'complete', generatedCode: FILE_BLOCK }]);

    const result = await startGeneration({ prompt: 'build a landing page', model: 'test-model' });

    expect(result.generatedCode).toBe(FILE_BLOCK);
    expect(result.streamDropped).toBeFalsy();
  });
});

describe('streamDropLine', () => {
  it('falls back to the neutral line when the job poll answered nothing', () => {
    expect(streamDropLine(null)).toBe(STREAM_DROPPED_NOTICE);
    expect(STREAM_DROPPED_NOTICE).not.toMatch(/recreation/i);
  });

  it('says the build is still running while the job is active', () => {
    const line = streamDropLine({ status: 'RUNNING', errorCode: null, errorMessage: null });
    expect(line).toMatch(/still running/i);
  });

  it('says it finished when the job already succeeded', () => {
    const line = streamDropLine({ status: 'SUCCEEDED', errorCode: null, errorMessage: null });
    expect(line).toMatch(/finished/i);
    expect(line).not.toMatch(/still running/i);
  });

  it('uses the job row cause for a job that failed', () => {
    const line = streamDropLine({
      status: 'FAILED',
      errorCode: 'server_restarted',
      errorMessage: null,
    });
    expect(line).toMatch(/restart/i);
  });

  it('keeps a recorded message over the curated one', () => {
    const line = streamDropLine({
      status: 'ABANDONED',
      errorCode: 'no_files_generated',
      errorMessage: 'The AI finished without producing any files we could save. Try again.',
    });
    expect(line).toMatch(/without producing any files/i);
  });

  it('stays neutral for a failed job whose code means nothing to us', () => {
    const line = streamDropLine({ status: 'FAILED', errorCode: 'wat', errorMessage: null });
    expect(line).toBe(STREAM_DROPPED_NOTICE);
  });
});
