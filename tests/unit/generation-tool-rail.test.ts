import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyStreamedCode,
  applyToolFileWrite,
  clearGeneration,
  executeGenerationJob,
  getGenerationState,
  startGeneration,
  subscribeGeneration,
  subscribeGenerationJobs,
} from '../../lib/generation/generation-runtime';
import { EMPTY_GENERATION_PROGRESS } from '../../lib/generation/types';
import type { GenerationProgressState } from '../../lib/generation/types';

/**
 * The client half of the tool-calling generation path.
 *
 * `applyToolFileWrite` and the two SSE handlers that drive it had executed zero
 * times before this file existed: no test named them, so the file rail — the
 * thing the Code pane and the preview's "nothing renderable yet" branch both
 * read — was the one part of the tool surface with nothing behind it. The rail
 * also completed every file *empty*, because both handlers passed `content:
 * null`; that is what the `content` assertions here pin.
 *
 * The predicate that matters is `files.some(f => f.completed)`. It is what
 * decides whether the preview mounts, and on the tool path it can only ever
 * arrive from this code.
 */

const PAGE = 'export default function Page() {\n  return <main>hi</main>;\n}\n';

function sseBody(frames: ReadonlyArray<Record<string, unknown>>) {
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n`).join('');
}

function sseResponse(frames: ReadonlyArray<Record<string, unknown>>) {
  const encoded = new TextEncoder().encode(sseBody(frames));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** Feed a fixed SSE frame list through the real generate consumer. */
async function consumeFrames(frames: ReadonlyArray<Record<string, unknown>>) {
  vi.stubGlobal('fetch', () => Promise.resolve(sseResponse(frames)));
  await startGeneration({ prompt: 'add a hero section', model: 'test-model' });
  return getGenerationState().generationProgress;
}

/**
 * Every status line the run passed through, in order.
 *
 * A status assertion cannot be made on the final state: the `complete` frame
 * legitimately rewrites `status` to say how many files were generated, so the
 * tool's own line is gone by the time the promise resolves. What matters is that
 * the line was shown while the tool ran, which is what this records.
 */
async function consumeFramesTrackingStatus(frames: ReadonlyArray<Record<string, unknown>>) {
  const statuses: string[] = [];
  const unsubscribe = subscribeGeneration(() => {
    const { status } = getGenerationState().generationProgress;
    if (status && statuses[statuses.length - 1] !== status) statuses.push(status);
  });
  try {
    const progress = await consumeFrames(frames);
    return { progress, statuses };
  } finally {
    unsubscribe();
  }
}

describe('applyToolFileWrite', () => {
  it('opens a rail entry with no content, because the arguments are not streamed', () => {
    const next = applyToolFileWrite(EMPTY_GENERATION_PROGRESS, 'app/page.tsx', null, false);
    expect(next.files).toHaveLength(1);
    expect(next.files[0]).toMatchObject({
      path: 'app/page.tsx',
      content: '',
      completed: false,
    });
    expect(next.status).toBe('Writing app/page.tsx');
    expect(next.currentFile?.path).toBe('app/page.tsx');
  });

  it('completes the entry with the real file body', () => {
    const opened = applyToolFileWrite(EMPTY_GENERATION_PROGRESS, 'app/page.tsx', null, false);
    const done = applyToolFileWrite(opened, 'app/page.tsx', PAGE, true);
    expect(done.files).toHaveLength(1);
    expect(done.files[0].content).toBe(PAGE);
    expect(done.files[0].completed).toBe(true);
    expect(done.status).toBe('Completed app/page.tsx');
    // A completed file is not "currently being written".
    expect(done.currentFile).toBeUndefined();
  });

  it('replaces content on a second write instead of adding a duplicate entry', () => {
    const first = applyToolFileWrite(EMPTY_GENERATION_PROGRESS, 'app/page.tsx', 'v1', true);
    const second = applyToolFileWrite(first, 'app/page.tsx', 'v2', true);
    expect(second.files).toHaveLength(1);
    expect(second.files[0].content).toBe('v2');
  });

  /**
   * A completion frame that carries no content must not erase the body an earlier
   * frame already delivered — `content ?? existing?.content` is load-bearing.
   */
  it('keeps existing content when a later frame carries none', () => {
    const written = applyToolFileWrite(EMPTY_GENERATION_PROGRESS, 'app/page.tsx', PAGE, false);
    const completed = applyToolFileWrite(written, 'app/page.tsx', null, true);
    expect(completed.files[0].content).toBe(PAGE);
    expect(completed.files[0].completed).toBe(true);
  });

  /**
   * The tool path normalises through `sanitizeGenerationPath`, so `./app/page.tsx`
   * and `app/page.tsx` are one rail entry rather than two spellings of one file.
   *
   * The fence path deliberately does *not*: `StreamedFence.path` is documented as
   * "exactly as the model wrote it — never the sanitized spelling", because that raw
   * spelling is the identity used to merge a partial entry with its own closed form.
   * Both paths are sanitised again before anything is persisted, so the divergence is
   * display-only — and asserting the two rails agree would pin the fence path's
   * documented behaviour to the opposite of what it promises.
   */
  it('collapses path spellings to one entry, unlike the raw-spelling fence rail', () => {
    const viaTool = applyToolFileWrite(EMPTY_GENERATION_PROGRESS, './app/page.tsx', PAGE, true);
    expect(viaTool.files[0].path).toBe('app/page.tsx');
    const again = applyToolFileWrite(viaTool, 'app/page.tsx', PAGE, true);
    expect(again.files).toHaveLength(1);

    const viaFence = applyStreamedCode(
      EMPTY_GENERATION_PROGRESS,
      '```tsx{path=./app/page.tsx}\n' + PAGE + '```\n',
    );
    expect(viaFence.files[0].path).toBe('./app/page.tsx');
  });

  it('records a refused path as dropped rather than putting it on the rail', () => {
    const next = applyToolFileWrite(EMPTY_GENERATION_PROGRESS, '../secrets.ts', 'x', true);
    expect(next.files).toHaveLength(0);
    expect(next.droppedPaths).toEqual([{ path: '../secrets.ts', reason: 'path_traversal' }]);
    // Reported once, not once per frame.
    const twice = applyToolFileWrite(next, '../secrets.ts', 'x', true);
    expect(twice.droppedPaths).toHaveLength(1);
  });

  it('leaves an unrelated in-progress entry alone', () => {
    const open: GenerationProgressState = applyToolFileWrite(
      EMPTY_GENERATION_PROGRESS,
      'app/layout.tsx',
      null,
      false,
    );
    const next = applyToolFileWrite(open, 'app/page.tsx', PAGE, true);
    expect(next.files.map((file) => file.path)).toEqual(['app/layout.tsx', 'app/page.tsx']);
  });
});

describe('the tool frames drive the file rail', () => {
  let unsubscribe: () => void;

  beforeEach(() => {
    clearGeneration();
    unsubscribe = subscribeGenerationJobs(executeGenerationJob);
  });

  afterEach(() => {
    unsubscribe();
    clearGeneration();
    vi.unstubAllGlobals();
  });

  /**
   * The shape the Code pane and the preview depend on. `nothingRenderableYet`
   * keys off `files.some(f => f.completed)`, and on the tool path that predicate
   * arrives from these two frames and nowhere else.
   */
  it('a write_file call and result put a completed file with content on the rail', async () => {
    const progress = await consumeFrames([
      { type: 'tool_call', tool: 'write_file', path: 'app/page.tsx' },
      {
        type: 'tool_result',
        tool: 'write_file',
        path: 'app/page.tsx',
        ok: true,
        detail: 'Wrote app/page.tsx (3 lines)',
        content: PAGE,
      },
      { type: 'complete', generatedCode: '' },
    ]);

    expect(progress.files).toHaveLength(1);
    expect(progress.files[0].path).toBe('app/page.tsx');
    expect(progress.files[0].completed).toBe(true);
    // The defect this pins: the rail used to complete every tool-written file
    // with an empty body while the fence path showed the code.
    expect(progress.files[0].content).toBe(PAGE);
    expect(progress.files.some((file) => file.completed)).toBe(true);
  });

  it('a refused write leaves no phantom file on the rail', async () => {
    const { progress, statuses } = await consumeFramesTrackingStatus([
      { type: 'tool_call', tool: 'write_file', path: 'app/page.tsx' },
      {
        type: 'tool_result',
        tool: 'write_file',
        path: 'app/page.tsx',
        ok: false,
        detail: 'app/page.tsx is not a writable path',
      },
      { type: 'complete', generatedCode: '' },
    ]);

    expect(progress.files).toHaveLength(0);
    expect(statuses).toContain('app/page.tsx is not a writable path');
  });

  it('a non-writing tool call sets a status line and adds no rail entry', async () => {
    const { progress, statuses } = await consumeFramesTrackingStatus([
      { type: 'tool_call', tool: 'read_file', path: 'app/page.tsx' },
      { type: 'complete', generatedCode: '' },
    ]);

    expect(progress.files).toHaveLength(0);
    expect(statuses).toContain('Running read_file');
  });

  it('a non-writing tool result shows its detail as the status line', async () => {
    const { progress, statuses } = await consumeFramesTrackingStatus([
      { type: 'tool_call', tool: 'search_files' },
      {
        type: 'tool_result',
        tool: 'search_files',
        ok: true,
        detail: '3 matches for "Button"',
      },
      { type: 'complete', generatedCode: '' },
    ]);

    expect(progress.files).toHaveLength(0);
    expect(statuses).toContain('3 matches for "Button"');
  });

  /**
   * Control: if the harness stopped reaching the frame parser, every assertion
   * above would pass on an untouched initial state.
   */
  it('control: the harness really drives the frame parser', async () => {
    const progress = await consumeFrames([
      { type: 'status', message: 'Writing files...' },
      { type: 'complete', generatedCode: '' },
    ]);
    expect(progress.status).not.toBe('');
  });
});
