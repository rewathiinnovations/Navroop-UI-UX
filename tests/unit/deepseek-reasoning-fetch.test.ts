import { describe, expect, it } from 'vitest';
import { createDeepSeekReasoningFetch } from '@/lib/ai/deepseek-reasoning-sse';

/**
 * The reasoning fetch does two jobs: (1) inject `thinking: {type:'enabled'}` +
 * `reasoning_effort` into the outgoing request so DeepSeek actually reasons,
 * and (2) rewrite SSE `reasoning_content` into `<think>` blocks so the AI SDK
 * surfaces it. The second was tested elsewhere; these pin the first, which is
 * what guarantees a reasoning model is not silently called in non-reasoning
 * mode.
 */

function sseBody(chunks: Array<{ reasoning_content?: string; content?: string }>) {
  return chunks
    .map(
      (c) =>
        `data: ${JSON.stringify({ choices: [{ delta: c }] })}\n`,
    )
    .join('');
}

function sseResponse(chunks: Array<{ reasoning_content?: string; content?: string }>) {
  const encoded = new TextEncoder().encode(sseBody(chunks));
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** Capture what the fetch actually sends (request body + url) and return a canned SSE response. */
function makeCaptureFetch(chunks: Array<{ reasoning_content?: string; content?: string }>) {
  const seen: { url: string; body: Record<string, unknown> | null }[] = [];
  const fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    seen.push({
      url: String(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    return sseResponse(chunks);
  };
  return { fetch, seen };
}

const CHUNKS = [{ reasoning_content: 'think hard', content: '' }, { content: 'hello' }];

describe('createDeepSeekReasoningFetch injects thinking for reasoning models', () => {
  it('adds thinking + the deep tier to the streaming generation request', async () => {
    const { fetch, seen } = makeCaptureFetch(CHUNKS);
    const wrapped = createDeepSeekReasoningFetch(fetch);
    await wrapped('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // `stream: true` is what `@ai-sdk/openai`'s `doStream` writes and `doGenerate`
      // does not, so it is the one signal in the body that says "this is the build".
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [], stream: true }),
    });
    expect(seen[0]?.body?.thinking).toEqual({ type: 'enabled' });
    expect(seen[0]?.body?.reasoning_effort).toBe('high');
  });

  it('does not buy maximum reasoning for a non-streaming classification call', async () => {
    // The shape every `generateText` / `generateObject` in the product sends: memory
    // extraction, skill matching, import segmentation, the audit's AI review. The
    // response rewrite below only runs for `text/event-stream`, so the reasoning these
    // buy is discarded unread — and `reasoning_effort: "high"` on every one of them was
    // paying DeepSeek's top tier to answer "which of these skills apply". Thinking is
    // still on: the tier is not the toggle.
    const { fetch, seen } = makeCaptureFetch(CHUNKS);
    const wrapped = createDeepSeekReasoningFetch(fetch);
    await wrapped('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [] }),
    });
    expect(seen[0]?.body?.thinking).toEqual({ type: 'enabled' });
    expect(seen[0]?.body?.reasoning_effort).toBe('low');
    expect(seen[0]?.body?.reasoning_effort).not.toBe('high');
  });

  it('reads the tier off `stream` alone, not off the model', async () => {
    // Both tiers, same model, one difference — otherwise a future "pro models always
    // think hard" shortcut would pass the two cases above and undo the fix.
    const { fetch, seen } = makeCaptureFetch(CHUNKS);
    const wrapped = createDeepSeekReasoningFetch(fetch);
    for (const stream of [true, false]) {
      await wrapped('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'deepseek-v4-pro', messages: [], stream }),
      });
    }
    expect(seen.map((call) => call.body?.reasoning_effort)).toEqual(['high', 'low']);
  });

  it('leaves a non-reasoning (chat) model request untouched (no thinking param)', async () => {
    const { fetch, seen } = makeCaptureFetch(CHUNKS);
    const wrapped = createDeepSeekReasoningFetch(fetch);
    await wrapped('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'deepseek-chat', messages: [] }),
    });
    expect(seen[0]?.body?.thinking).toBeUndefined();
    expect(seen[0]?.body?.reasoning_effort).toBeUndefined();
  });

  it('does not double-inject when thinking is already present', async () => {
    const { fetch, seen } = makeCaptureFetch(CHUNKS);
    const wrapped = createDeepSeekReasoningFetch(fetch);
    await wrapped('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        thinking: { type: 'disabled' },
        messages: [],
      }),
    });
    expect(seen[0]?.body?.thinking).toEqual({ type: 'disabled' });
  });

  it('sends thinking disabled when the admin setting has it off', async () => {
    // DeepSeek V4 thinks by default. Omitting the body leaves reasoning on,
    // so "disabled" must be an explicit `{ type: "disabled" }`, not a no-op.
    const { fetch, seen } = makeCaptureFetch(CHUNKS);
    const wrapped = createDeepSeekReasoningFetch(fetch, { enabled: false });
    await wrapped('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [] }),
    });
    expect(seen[0]?.body?.thinking).toEqual({ type: 'disabled' });
    expect(seen[0]?.body?.reasoning_effort).toBeUndefined();
  });

  it('still respects a model-supplied thinking block when injection is disabled', async () => {
    // `enabled: false` only suppresses the *injector*. A caller that has set its own
    // `thinking` is not ours to second-guess.
    const { fetch, seen } = makeCaptureFetch(CHUNKS);
    const wrapped = createDeepSeekReasoningFetch(fetch, { enabled: false });
    await wrapped('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        thinking: { type: 'enabled' },
        messages: [],
      }),
    });
    expect(seen[0]?.body?.thinking).toEqual({ type: 'enabled' });
  });
});
