/**
 * DeepSeek thinking models stream `delta.reasoning_content` for minutes before
 * the first `delta.content`. @ai-sdk/openai 2.0 only reads `content`, so those
 * tokens vanish: `textStream` stays empty, the 5-minute idle bound kills the
 * run, and the Code pane sits on "Planning application structure...".
 *
 * These rewrite the SSE so thinking is visible as `<think>` text the AI SDK
 * middleware can split from the file reply.
 */
import { describe, expect, it } from 'vitest';
import {
  createDeepSeekReasoningState,
  rewriteDeepSeekReasoningDataLine,
} from '@/lib/ai/deepseek-reasoning-sse';

function dataLine(delta: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ choices: [{ delta }] })}`;
}

function parsedDelta(line: string): Record<string, unknown> {
  const payload = JSON.parse(line.slice(6)) as {
    choices: Array<{ delta: Record<string, unknown> }>;
  };
  return payload.choices[0]?.delta ?? {};
}

describe('rewriteDeepSeekReasoningDataLine', () => {
  it('wraps the first reasoning_content chunk in a <think> tag so it is not dropped', () => {
    const state = createDeepSeekReasoningState();
    const out = rewriteDeepSeekReasoningDataLine(
      dataLine({ content: null, reasoning_content: 'First, I will' }),
      state,
    );

    expect(parsedDelta(out).content).toBe('<think>First, I will');
    expect(parsedDelta(out).reasoning_content).toBeUndefined();
    expect(state.thinkOpen).toBe(true);
  });

  it('appends later reasoning chunks without opening a second tag', () => {
    const state = createDeepSeekReasoningState();
    rewriteDeepSeekReasoningDataLine(dataLine({ reasoning_content: 'First' }), state);
    const out = rewriteDeepSeekReasoningDataLine(
      dataLine({ reasoning_content: ', then the files' }),
      state,
    );

    expect(parsedDelta(out).content).toBe(', then the files');
    expect(state.thinkOpen).toBe(true);
  });

  it('closes the think tag on the first real content so files stay out of the reasoning channel', () => {
    const state = createDeepSeekReasoningState();
    rewriteDeepSeekReasoningDataLine(dataLine({ reasoning_content: 'plan' }), state);
    const out = rewriteDeepSeekReasoningDataLine(
      dataLine({ content: '```tsx{path=app/page.tsx}\n' }),
      state,
    );

    expect(parsedDelta(out).content).toBe('</think>```tsx{path=app/page.tsx}\n');
    expect(state.thinkOpen).toBe(false);
  });

  it('leaves ordinary content and non-data lines alone', () => {
    const state = createDeepSeekReasoningState();
    expect(rewriteDeepSeekReasoningDataLine(': keepalive', state)).toBe(': keepalive');
    expect(rewriteDeepSeekReasoningDataLine('data: [DONE]', state)).toBe('data: [DONE]');
    const content = dataLine({ content: 'hello' });
    expect(rewriteDeepSeekReasoningDataLine(content, state)).toBe(content);
  });
});
