import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addGenerationMessage,
  clearGeneration,
  executeGenerationJob,
  getGenerationState,
  setGenerationProjectId,
  startApply,
  subscribeGenerationJobs,
  surfacePreviewNotice,
} from '../../lib/generation/generation-runtime';
import { PREVIEW_NOT_READY_NOTICE } from '../../lib/preview/labels';

/**
 * persistProjectGeneration returns previewNotice on the PATCH that runs when
 * apply finishes (status "ready"). generation-runtime used to discard that
 * body, so chat only learned about a failed preview if saveCurrentProject ran
 * later. These tests fail if the value is dropped again.
 */

const FILE_BLOCK = '<file path="src/App.jsx">export default function App() { return null; }</file>';

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
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function persistResponse(body: unknown, init?: { status?: number; json?: boolean }) {
  if (init?.json === false) {
    return new Response('not-json', {
      status: init.status ?? 200,
      headers: { 'content-type': 'text/plain' },
    });
  }
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

function stubPersist(options: {
  persistBody?: unknown;
  persistInit?: { status?: number; json?: boolean };
  persistImpl?: (url: string, init?: RequestInit) => Response | Promise<Response>;
}) {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/projects/')) {
      if (options.persistImpl) {
        return Promise.resolve(options.persistImpl(url, init));
      }
      return Promise.resolve(
        persistResponse(options.persistBody ?? { project: { id: 'proj-1' } }, options.persistInit),
      );
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  });
}

/**
 * Settling a generation persists it and surfaces any preview notice. It used
 * to stream through /api/apply-ai-code-stream, which wrote files into a
 * sandbox; the files are already saved by the generate route now, so the
 * notice has to survive on the persist response alone.
 */
describe('generation-runtime persist previewNotice', () => {
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

  it('puts persistProjectGeneration previewNotice into chat once settled', async () => {
    stubPersist({
      persistBody: { project: { id: 'proj-1' }, previewNotice: PREVIEW_NOT_READY_NOTICE },
    });

    const result = await startApply({ code: FILE_BLOCK, isEdit: false });

    expect(result).toEqual({ finalData: null });
    expect(getGenerationState().status).toBe('ready');
    const notices = getGenerationState().messages.filter(
      (message) => message.type === 'system' && message.content === PREVIEW_NOT_READY_NOTICE,
    );
    expect(notices).toHaveLength(1);
    expect(PREVIEW_NOT_READY_NOTICE).not.toMatch(/build failed/i);
  });

  it('does not treat a missing notice as a failed persist or a failed build', async () => {
    stubPersist({
      persistBody: { project: { id: 'proj-1' }, previewNotice: null },
    });

    const result = await startApply({ code: FILE_BLOCK, isEdit: false });

    expect(result).toEqual({ finalData: null });
    expect(getGenerationState().status).toBe('ready');
    expect(getGenerationState().messages).toEqual([]);
  });

  it('keeps the save when the persist body cannot be read for a notice', async () => {
    stubPersist({
      persistInit: { json: false },
    });

    const result = await startApply({ code: FILE_BLOCK, isEdit: false });

    expect(result).toEqual({ finalData: null });
    expect(getGenerationState().status).toBe('ready');
    expect(getGenerationState().lastError).toBeNull();
  });

  it('does not add the same preview notice twice when saveCurrentProject also returns it', async () => {
    addGenerationMessage('Applied 1 files successfully!', 'system');
    surfacePreviewNotice(PREVIEW_NOT_READY_NOTICE);

    stubPersist({
      persistBody: { project: { id: 'proj-1' }, previewNotice: PREVIEW_NOT_READY_NOTICE },
    });

    await startApply({ code: FILE_BLOCK, isEdit: false });
    surfacePreviewNotice(PREVIEW_NOT_READY_NOTICE);

    const notices = getGenerationState().messages.filter(
      (message) => message.content === PREVIEW_NOT_READY_NOTICE,
    );
    expect(notices).toHaveLength(1);
  });

  it('control: persist without previewNotice and an unreadable ready body still leave no preview chat line', async () => {
    stubPersist({ persistBody: { project: { id: 'proj-1' } } });
    await startApply({ code: FILE_BLOCK, isEdit: false });
    expect(
      getGenerationState().messages.some((message) => message.content === PREVIEW_NOT_READY_NOTICE),
    ).toBe(false);
  });
});
