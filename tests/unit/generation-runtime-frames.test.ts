import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearGeneration,
  executeGenerationJob,
  getGenerationState,
  startGeneration,
  subscribeGenerationJobs,
} from '../../lib/generation/generation-runtime';
import type { ChatMessage, GenerateResult } from '../../lib/generation/types';

/**
 * The generate branch of `runGenerateStream` used to handle eleven frame types and drop
 * `warning` / `info` on the floor, which silently swallowed every degraded-context notice
 * the route emits ("could not read your files, working blind"). These tests pin the two
 * cases, and each positive assertion is paired with a control that fails if the case is
 * deleted again or if the harness stops exercising the parser at all.
 */

const FILE_BLOCK = '<file path="src/App.jsx">export default function App() { return null; }</file>';

// Verbatim from the route's degraded-context branch: the notice a browser test looked for
// in the chat and could not find.
const DEGRADED_CONTEXT_WARNING =
  'Could not read the current files from the sandbox. Proceeding with general edit mode.';
const RETRY_INFO = 'Service temporarily unavailable, retrying (attempt 2/3)...';

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
async function consumeFrames(
  frames: ReadonlyArray<Record<string, unknown>>,
): Promise<{ result: GenerateResult; messages: ChatMessage[] }> {
  vi.stubGlobal('fetch', () => Promise.resolve(sseResponse(frames)));
  const result = await startGeneration({ prompt: 'add a hero section', model: 'test-model' });
  return { result, messages: getGenerationState().messages };
}

describe('runGenerateStream frame handling', () => {
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

  it('turns a warning frame into a system chat message', async () => {
    const { result, messages } = await consumeFrames([
      { type: 'warning', message: DEGRADED_CONTEXT_WARNING },
      { type: 'complete', generatedCode: FILE_BLOCK },
    ]);

    // Proves the stream was actually consumed, so a zero-message assertion elsewhere
    // cannot be explained by the parser never running.
    expect(result.generatedCode).toBe(FILE_BLOCK);
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('system');
    expect(messages[0].content).toBe(DEGRADED_CONTEXT_WARNING);
  });

  it('turns an info frame into a system chat message', async () => {
    const { result, messages } = await consumeFrames([
      { type: 'info', message: RETRY_INFO },
      { type: 'complete', generatedCode: FILE_BLOCK },
    ]);

    expect(result.generatedCode).toBe(FILE_BLOCK);
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('system');
    expect(messages[0].content).toBe(RETRY_INFO);
  });

  it('keeps warning and info notices in the order they arrived', async () => {
    const { messages } = await consumeFrames([
      { type: 'warning', message: DEGRADED_CONTEXT_WARNING },
      { type: 'info', message: RETRY_INFO },
      { type: 'complete', generatedCode: FILE_BLOCK },
    ]);

    expect(messages.map((message) => message.content)).toEqual([
      DEGRADED_CONTEXT_WARNING,
      RETRY_INFO,
    ]);
  });

  // Control for both tests above: the same frame payload under a type the runtime does
  // not handle produces nothing. If this passed while the tests above failed, the cause
  // would be the missing case; if this failed, the runtime would be blanket-rendering
  // every frame's `message` and the assertions above would be vacuous.
  it('control: an unhandled frame type with the same message produces no chat message', async () => {
    const { result, messages } = await consumeFrames([
      { type: 'not_a_frame_the_runtime_handles', message: DEGRADED_CONTEXT_WARNING },
      { type: 'complete', generatedCode: FILE_BLOCK },
    ]);

    expect(result.generatedCode).toBe(FILE_BLOCK);
    expect(messages).toEqual([]);
  });

  // Control for the `if (data.message)` guard copied from the apply branch: a frame of
  // the right type but with no message must not add an empty chat bubble.
  it('control: a warning frame with no message produces no chat message', async () => {
    const { result, messages } = await consumeFrames([
      { type: 'warning' },
      { type: 'complete', generatedCode: FILE_BLOCK },
    ]);

    expect(result.generatedCode).toBe(FILE_BLOCK);
    expect(messages).toEqual([]);
  });
});
