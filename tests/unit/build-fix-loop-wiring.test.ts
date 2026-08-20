import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearGeneration,
  executeGenerationJob,
  setGenerationProjectId,
  startGeneration,
  subscribeGenerationJobs,
} from '../../lib/generation/generation-runtime';

/**
 * The build → fix → re-generate loop was disconnected at both ends (F-021).
 *
 * The server ran `runBuildValidation` on every reply with files, decided whether
 * a repair pass was warranted, and put the instruction on the `complete` frame
 * as `buildFix`. The client's `complete` handler read `generatedCode`,
 * `explanation` and `skillNames` — and not `buildFix`. The
 * only reader took it off `applyResult.finalData`, and `runApplyStream` returns
 * `{ finalData: null }` by design, so `buildFix?.instruction` was permanently
 * undefined. Symmetrically the route read `buildFixAttempt` / `buildFixSignature`
 * off the request body and nothing ever sent them, so the attempt counter could
 * never leave 0 and the repeated-failure guard was never exercised.
 *
 * Cost of the gap: every failed build paid for a validation pass, printed
 * "attempting an automatic fix (1/2)" in chat, and then did nothing.
 *
 * These cases drive the runtime over a stubbed SSE stream, so they fail if
 * either end comes loose again.
 */

const REPLY = ['```tsx{path=src/App.tsx}', 'export default () => null;', '```'].join('\n');

const BUILD_FIX = {
  instruction: 'The build failed: `site` is not exported from lib/data.ts. Fix the export.',
  attempt: 1,
  signature: 'sig-first-failure',
};

function sseResponse(frames: ReadonlyArray<Record<string, unknown>>) {
  const encoded = new TextEncoder().encode(
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n`).join(''),
  );
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('the build-fix loop reaches the client and comes back', () => {
  let unsubscribe: () => void;
  let generateBodies: Array<Record<string, unknown>>;

  beforeEach(() => {
    clearGeneration();
    unsubscribe = subscribeGenerationJobs(executeGenerationJob);
    setGenerationProjectId('proj-1');
    generateBodies = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/generate-ai-code-stream')) {
        generateBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return Promise.resolve(
          sseResponse([
            { type: 'complete', generatedCode: REPLY, explanation: 'done', buildFix: BUILD_FIX },
          ]),
        );
      }
      if (url.includes('/api/projects/')) {
        return Promise.resolve(
          new Response(JSON.stringify({ project: { id: 'proj-1' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    });
  });

  afterEach(() => {
    unsubscribe();
    clearGeneration();
    vi.unstubAllGlobals();
  });

  it('carries buildFix off the complete frame into the generation result', async () => {
    const result = await startGeneration({ prompt: 'build it', model: 'test/model' });

    expect(result.generatedCode).toBe(REPLY);
    // Without this the repair instruction the server already paid to compute is
    // parsed and thrown away.
    expect(result.buildFix).toEqual(BUILD_FIX);
  });

  it('reports no repair when the server withholds one', async () => {
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      if (String(input).includes('/api/generate-ai-code-stream')) {
        return Promise.resolve(
          sseResponse([{ type: 'complete', generatedCode: REPLY, explanation: 'done' }]),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ project: { id: 'proj-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });

    const result = await startGeneration({ prompt: 'build it', model: 'test/model' });

    // A passing build must not look like a repair the client forgot to run.
    expect(result.buildFix ?? null).toBeNull();
  });

  it('sends the attempt and the previous signature back on the repair request', async () => {
    await startGeneration({
      prompt: BUILD_FIX.instruction,
      model: 'test/model',
      isEdit: true,
      buildFixAttempt: BUILD_FIX.attempt,
      buildFixSignature: BUILD_FIX.signature,
    });

    // The server's attempt cap and repeated-failure guard are both driven by
    // these two fields; withholding them makes every retry look like the first.
    expect(generateBodies).toHaveLength(1);
    expect(generateBodies[0]).toMatchObject({
      buildFixAttempt: BUILD_FIX.attempt,
      buildFixSignature: BUILD_FIX.signature,
    });
  });

  it('omits the retry fields on an ordinary generation', async () => {
    await startGeneration({ prompt: 'build it', model: 'test/model' });

    expect(generateBodies[0].buildFixAttempt).toBeUndefined();
    expect(generateBodies[0].buildFixSignature).toBeUndefined();
  });
});
