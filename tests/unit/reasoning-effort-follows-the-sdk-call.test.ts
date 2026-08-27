/**
 * The reasoning tier is derived from the request the AI SDK actually builds.
 *
 * `injectThinking` used to put `reasoning_effort: "high"` on every DeepSeek request, and
 * the response rewrite that makes reasoning usable runs only for `text/event-stream` — so
 * every `generateText` / `generateObject` in the product (memory extraction, skill
 * matching, import segmentation, the audit's AI review, import section writing) bought
 * DeepSeek's most expensive reasoning tier to answer a small structured question and then
 * threw the reasoning away unread. `reasoningEffortFor` now reads `body.stream`, which
 * `@ai-sdk/openai`'s chat `doStream` writes and its `doGenerate` does not.
 *
 * `tests/unit/deepseek-reasoning-fetch.test.ts` pins that rule against a hand-written
 * body, which proves the branch and nothing else: it would keep passing if a future
 * `@ai-sdk/openai` stopped putting `stream` in the body, or routed `generateObject`
 * through `doStream`, and the whole saving would silently revert with every test green.
 * These cases assert the mechanism instead — the real provider client from
 * `clientForEntry`, the real `ai` entry points the product calls, and an assertion on the
 * bytes that left. What is under test is the claim the fix rests on: that the shape of the
 * call is legible in the request.
 *
 * The global `fetch` is stubbed because `clientForEntry` builds its reasoning fetch over
 * the global with no injection seam. Nothing reaches the network — the stub answers every
 * request itself — and `vi.unstubAllGlobals` puts `tests/setup/network-guard.ts` back.
 */
import { generateObject, generateText, streamText } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  chatModelForEntry,
  chatModelForProvider,
  clientForEntry,
  wrapReasoningModel,
} from '@/lib/ai/client-for-entry';
import type { ProviderEntry } from '@/lib/ai/providers';

const MODEL = 'deepseek-v4-pro';

const ENTRY: ProviderEntry = {
  id: 'deepseek',
  provider: 'deepseek',
  model: MODEL,
  apiKeyEnv: 'DEEPSEEK_API_KEY',
};

/**
 * Passed explicitly rather than read from `process.env`, so the case cannot pick up a real
 * key from the developer's `.env` and cannot depend on one being absent either.
 */
const ENV = {
  DEEPSEEK_API_KEY: 'sk-not-a-real-key',
  DEEPSEEK_BASE_URL: 'https://deepseek.example.com',
};

/** The skill-match schema, so the `generateObject` case sends the request that call sends. */
const RANK_SCHEMA = z.object({
  matches: z.array(z.object({ id: z.string(), confidence: z.number() })),
});

const USAGE = { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 };

function jsonResponse(content: string) {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 0,
      model: MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: USAGE,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function chunk(payload: Record<string, unknown>) {
  return `data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 0, model: MODEL, ...payload })}\n\n`;
}

function sseResponse() {
  const body =
    chunk({
      choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
      usage: null,
    }) +
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: USAGE }) +
    'data: [DONE]\n\n';
  return new Response(new TextEncoder().encode(body), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** Every request body the SDK handed to the reasoning fetch, in order. */
let sent: Record<string, unknown>[];

beforeEach(() => {
  sent = [];
  vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    sent.push(body);
    // The stub answers in the shape the request asked for, so `doStream` gets an event
    // stream and `doGenerate` gets JSON. Answering the wrong one would make the SDK throw
    // before the assertion, hiding the body this case exists to read.
    return body.stream === true ? sseResponse() : jsonResponse('{"matches":[]}');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The helper shape: a client from the cache, `provider.chat`, no reasoning middleware. */
function helperModel() {
  return chatModelForProvider(clientForEntry(ENTRY, ENV), MODEL);
}

describe('a non-streaming classification does not buy maximum reasoning', () => {
  it('sends the cheap tier for generateText — the memory-extraction shape', async () => {
    await generateText({ model: helperModel(), prompt: 'anything durable here?' });

    expect(sent).toHaveLength(1);
    // The premise, asserted rather than assumed: `doGenerate` puts no `stream` in the body.
    expect(sent[0].stream).toBeUndefined();
    expect(sent[0].reasoning_effort).toBe('low');
    // Thinking itself is untouched. `ai.deepseek.thinking` promises the model reasons
    // before answering; the tier is a separate question and answering it must not quietly
    // turn the operator's toggle off.
    expect(sent[0].thinking).toEqual({ type: 'enabled' });
  });

  it('sends the cheap tier for generateObject — the skill-match and segmentation shape', async () => {
    // Both of those go through `generateObject`. If a future SDK routed structured output
    // through `doStream`, the body would carry `stream: true`, the tier would jump back to
    // `high`, and every skill match would quietly cost top rate again.
    const result = await generateObject({
      model: helperModel(),
      schema: RANK_SCHEMA,
      prompt: 'which of these skills apply?',
    });

    expect(result.object).toEqual({ matches: [] });
    expect(sent).toHaveLength(1);
    expect(sent[0].stream).toBeUndefined();
    expect(sent[0].reasoning_effort).toBe('low');
  });
});

describe('the generation stream still asks for deep reasoning', () => {
  it('sends the deep tier for the streamText call the generate route makes', async () => {
    // The exact model expression from `app/api/generate-ai-code-stream/route.ts`. This is
    // the one call whose reasoning is not discarded: the fetch rewrites `reasoning_content`
    // into `<think>` blocks and `wrapReasoningModel` splits them back out for the Code pane.
    const stream = streamText({
      model: wrapReasoningModel(chatModelForEntry(ENTRY, ENV, MODEL)),
      prompt: 'build a landing page',
    });
    let text = '';
    for await (const part of stream.textStream) text += part;

    expect(text).toBe('ok');
    expect(sent).toHaveLength(1);
    expect(sent[0].stream).toBe(true);
    expect(sent[0].reasoning_effort).toBe('high');
    expect(sent[0].thinking).toEqual({ type: 'enabled' });
  });
});

describe('one model, two tiers', () => {
  it('separates the two calls by their shape alone', async () => {
    // Same entry, same model id, same client constructor — so nothing here can be passing
    // because of a model-name shortcut ("pro always thinks hard"), which would read as
    // correct on each case above while undoing the fix for `deepseek-v4-pro` helper calls.
    await generateText({ model: helperModel(), prompt: 'classify this' });
    const stream = streamText({
      model: wrapReasoningModel(chatModelForEntry(ENTRY, ENV, MODEL)),
      prompt: 'build a landing page',
    });
    for await (const part of stream.textStream) void part;

    expect(sent.map((body) => body.model)).toEqual([MODEL, MODEL]);
    expect(sent.map((body) => body.reasoning_effort)).toEqual(['low', 'high']);
  });
});
