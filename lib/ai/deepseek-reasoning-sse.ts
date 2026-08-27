/**
 * DeepSeek thinking models stream `delta.reasoning_content` for a long time
 * before the first `delta.content`. @ai-sdk/openai 2.0 only reads `content`,
 * so those tokens never reach `textStream` / `fullStream` — the generate route
 * looks idle, the 5-minute bound kills the run, and the Code pane stays on
 * "Planning application structure...".
 *
 * Rewrite each SSE `data:` line so reasoning is ordinary content wrapped in
 * `<think>` tags. `extractReasoningMiddleware` then splits it back into
 * reasoning vs text parts.
 */

export type DeepSeekReasoningState = { thinkOpen: boolean };

export function createDeepSeekReasoningState(): DeepSeekReasoningState {
  return { thinkOpen: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rewriteDelta(
  delta: Record<string, unknown>,
  state: DeepSeekReasoningState,
): Record<string, unknown> {
  const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
  const content = typeof delta.content === 'string' ? delta.content : '';
  if (!reasoning && !(content && state.thinkOpen)) {
    return delta;
  }

  const next = { ...delta };
  delete next.reasoning_content;

  if (reasoning && !state.thinkOpen) {
    next.content = `<think>${reasoning}${content}`;
    state.thinkOpen = true;
    return next;
  }
  if (reasoning && !content) {
    next.content = reasoning;
    return next;
  }
  if (reasoning && content) {
    next.content = `${reasoning}</think>${content}`;
    state.thinkOpen = false;
    return next;
  }
  // Real content after a think block — close the tag so files are not reasoning.
  next.content = `</think>${content}`;
  state.thinkOpen = false;
  return next;
}

function rewritePayload(payload: unknown, state: DeepSeekReasoningState): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return payload;
  let changed = false;
  const choices = payload.choices.map((choice) => {
    if (!isRecord(choice) || !isRecord(choice.delta)) return choice;
    const delta = rewriteDelta(choice.delta, state);
    if (delta === choice.delta) return choice;
    changed = true;
    return { ...choice, delta };
  });
  return changed ? { ...payload, choices } : payload;
}

/** One SSE line. Non-`data:` lines, `[DONE]`, and unparseable JSON pass through. */
export function rewriteDeepSeekReasoningDataLine(
  line: string,
  state: DeepSeekReasoningState,
): string {
  if (!line.startsWith('data: ')) return line;
  const raw = line.slice(6).trim();
  if (raw === '' || raw === '[DONE]') return line;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return line;
  }
  const rewritten = rewritePayload(payload, state);
  return rewritten === payload ? line : `data: ${JSON.stringify(rewritten)}`;
}

function isEventStream(response: Response): boolean {
  return (response.headers.get('content-type') || '').includes('text/event-stream');
}

function rewriteSseBody(
  body: ReadableStream<Uint8Array>,
  state: DeepSeekReasoningState,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          controller.enqueue(
            encoder.encode(`${rewriteDeepSeekReasoningDataLine(line, state)}\n`),
          );
        }
      },
      flush(controller) {
        if (!buffer) return;
        controller.enqueue(
          encoder.encode(rewriteDeepSeekReasoningDataLine(buffer, state)),
        );
      },
    }),
  );
}

/**
 * Drop `Content-Length` — the rewritten body is a different size, and a stale
 * length truncates the stream the OpenAI client is reading.
 */
function headersWithoutLength(headers: Headers): Headers {
  const next = new Headers(headers);
  next.delete('content-length');
  return next;
}

/**
 * Whether a DeepSeek model should run with thinking enabled. DeepSeek's docs
 * require an explicit `thinking: { type: "enabled" }` (and `reasoning_effort`)
 * in the request body for the reasoning models to emit `reasoning_content`;
 * the models do not infer it from the name. `deepseek-chat` is the only model
 * that returns content directly without reasoning.
 */
function isReasoningModel(model: string): boolean {
  return !model.includes('chat');
}

/**
 * How hard the model should think, derived from the shape of the request — not configured,
 * and not a second admin knob.
 *
 * `stream: true` is written into the body by `@ai-sdk/openai`'s `doStream` and by nothing
 * else, so it separates the one call that needs deep reasoning (the generation stream: a
 * whole site, minutes long, whose reasoning this module rewrites into `<think>` blocks the
 * Code pane actually shows) from every `generateText` / `generateObject` in the product —
 * memory extraction, skill matching, import segmentation, the audit's AI review, import
 * section writing. Those are small structured questions, they are answered from the
 * completion, and the reasoning they buy is discarded unread: `createDeepSeekReasoningFetch`
 * only rewrites a response when `isEventStream(sent)`. Asking every one of them for the
 * most expensive tier DeepSeek sells was paying top rate to answer "which of these skills
 * apply".
 *
 * The tier is not the toggle. `ai.deepseek.thinking` decides WHETHER the model reasons and
 * is honoured unchanged below; this decides how much reasoning a request that already
 * reasons is worth.
 */
const STREAMING_REASONING_EFFORT = 'high';
const CLASSIFICATION_REASONING_EFFORT = 'low';

function reasoningEffortFor(body: Record<string, unknown>): string {
  return body.stream === true ? STREAMING_REASONING_EFFORT : CLASSIFICATION_REASONING_EFFORT;
}

/**
 * DeepSeek requires `thinking: { type: "enabled" }` to be set explicitly for a
 * reasoning model to emit `reasoning_content`. `@ai-sdk/openai` strips unknown
 * `providerOptions`, and its schema does not type `thinking` at all, so the
 * only reliable way to send it is to inject it into the outgoing request body
 * here, where we own the fetch.
 *
 * `enabled` defaults to `true`: every call site before this had thinking on
 * unconditionally, and the existing tests pin that. DeepSeek V4 also thinks
 * by default, so the off path must send `{ type: "disabled" }` — omitting the
 * field leaves reasoning on and the admin toggle does nothing.
 * `ai.deepseek.thinking` reaches this flag via `client-for-entry.ts`.
 */
function injectThinking(
  body: unknown,
  model: string,
  enabled: boolean,
): unknown {
  if (!isRecord(body) || !isReasoningModel(model)) return body;
  if (body.thinking || body.reasoning_effort) return body;
  if (!enabled) {
    return { ...body, thinking: { type: 'disabled' } };
  }
  return {
    ...body,
    thinking: { type: 'enabled' },
    reasoning_effort: reasoningEffortFor(body),
  };
}

async function readAndReinjectBody(
  init: RequestInit | undefined,
  enabled: boolean,
): Promise<RequestInit | undefined> {
  if (!init) return init;
  const raw = init.body;
  if (typeof raw !== 'string') return init;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return init;
  }
  if (!isRecord(parsed)) return init;
  const model = typeof parsed.model === 'string' ? parsed.model : '';
  const withThinking = injectThinking(parsed, model, enabled);
  if (withThinking === parsed) return init;
  return {
    ...init,
    body: JSON.stringify(withThinking),
    headers: headersWithoutLength(new Headers(init.headers)),
  };
}

export function createDeepSeekReasoningFetch(
  baseFetch: typeof fetch = fetch,
  options: { enabled?: boolean } = {},
): typeof fetch {
  const enabled = options.enabled !== false;
  return async (input, init) => {
    // Inject thinking enabled/disabled into the request body before it is sent.
    // V4 defaults to thinking on; the off path must send type: "disabled", and
    // the effort tier of an enabled request follows `stream` (see
    // `reasoningEffortFor`). The response rewrite (always on) wraps any
    // reasoning_content in `<think>` so extractReasoningMiddleware can split it
    // back out — which is why only a streaming call can use deep reasoning.
    const sent = await baseFetch(input, await readAndReinjectBody(init, enabled));
    if (!sent.body || !isEventStream(sent)) return sent;
    return new Response(rewriteSseBody(sent.body, createDeepSeekReasoningState()), {
      status: sent.status,
      statusText: sent.statusText,
      headers: headersWithoutLength(sent.headers),
    });
  };
}
