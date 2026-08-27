/**
 * `textStream` yields text deltas only. A thinking-mode model can reason for a
 * long time on `fullStream` (`reasoning-delta`) before the first visible token.
 * The generate route used to wait on `textStream`, so those parts never rearmed
 * the idle bound and never became `type: 'thinking'` frames — the Code pane
 * stayed on "Planning application structure..." / "No files yet."
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MODEL_THINKING_STATUS,
  WAITING_FOR_MODEL_STATUS,
  classifyStreamPart,
} from '@/lib/generation/stream-parts';

const ROUTE = fileURLToPath(
  new URL('../../app/api/generate-ai-code-stream/route.ts', import.meta.url),
);
const CLIENT = fileURLToPath(new URL('../../lib/ai/client-for-entry.ts', import.meta.url));

function live(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('classifyStreamPart', () => {
  it('maps a text-delta to text the Code pane can apply', () => {
    expect(classifyStreamPart({ type: 'text-delta', text: '```tsx{path=a.tsx}\n' })).toEqual({
      kind: 'text',
      text: '```tsx{path=a.tsx}\n',
    });
    // UI-stream chunks use `delta` instead of `text`.
    expect(classifyStreamPart({ type: 'text-delta', delta: 'const a' })).toEqual({
      kind: 'text',
      text: 'const a',
    });
  });

  it('maps reasoning parts so thinking tokens rearm the idle bound', () => {
    expect(classifyStreamPart({ type: 'reasoning-delta', text: 'I will start with' })).toEqual({
      kind: 'reasoning',
      text: 'I will start with',
    });
    expect(classifyStreamPart({ type: 'reasoning-delta', delta: ' the layout' })).toEqual({
      kind: 'reasoning',
      text: ' the layout',
    });
    expect(classifyStreamPart({ type: 'reasoning' as string, text: 'legacy chunk' })).toEqual({
      kind: 'reasoning',
      text: 'legacy chunk',
    });
    expect(classifyStreamPart({ type: 'reasoning-end' })).toEqual({ kind: 'reasoning-end' });
  });

  it('maps the tool parts so a tool-only step counts as progress', () => {
    expect(
      classifyStreamPart({ type: 'tool-call', toolName: 'write_file', toolCallId: 'c1' }),
    ).toEqual({ kind: 'tool-call', toolName: 'write_file', toolCallId: 'c1' });
    expect(
      classifyStreamPart({ type: 'tool-result', toolName: 'write_file', toolCallId: 'c1' }),
    ).toEqual({ kind: 'tool-result', toolName: 'write_file', toolCallId: 'c1' });
    expect(classifyStreamPart({ type: 'finish-step' })).toEqual({ kind: 'step-finish' });
  });

  /**
   * The longest quiet stretch of a tool run: these three carry the streaming tool
   * arguments, and for `write_file` the argument is the whole file. Falling through
   * to `ignore` meant the route `continue`d before `collectCtx.progress()`, so the
   * five-minute idle bound reaped a healthy generation mid-file.
   */
  it('maps the tool-input parts, which stream a file as tool arguments', () => {
    expect(
      classifyStreamPart({ type: 'tool-input-start', id: 'c1', toolName: 'write_file' }),
    ).toEqual({ kind: 'tool-input-start', toolName: 'write_file', toolCallId: 'c1' });
    expect(classifyStreamPart({ type: 'tool-input-delta', id: 'c1', delta: 'abc' })).toEqual({
      kind: 'tool-input-delta',
      toolCallId: 'c1',
      text: 'abc',
    });
    expect(classifyStreamPart({ type: 'tool-input-end', id: 'c1' })).toEqual({
      kind: 'tool-input-end',
      toolCallId: 'c1',
    });
  });

  /**
   * `fullStream` yields `TextStreamPart`, which spells these `id` / `delta`. The
   * `toolCallId` / `inputTextDelta` spelling is `UIMessageChunk`'s. Reading only the
   * UI spelling would have classified the part correctly and then carried an empty
   * delta and a blank call id through production, which no `kind` assertion catches.
   */
  it('reads both the fullStream and the UI-stream spellings of the input fields', () => {
    expect(
      classifyStreamPart({ type: 'tool-input-delta', toolCallId: 'c9', inputTextDelta: 'xyz' }),
    ).toEqual({ kind: 'tool-input-delta', toolCallId: 'c9', text: 'xyz' });
    expect(
      classifyStreamPart({ type: 'tool-input-start', toolCallId: 'c9', toolName: 'edit_file' }),
    ).toEqual({ kind: 'tool-input-start', toolName: 'edit_file', toolCallId: 'c9' });
  });

  it('classifies none of the tool parts as ignore', () => {
    for (const type of [
      'tool-call',
      'tool-result',
      'tool-error',
      'tool-input-start',
      'tool-input-delta',
      'tool-input-end',
      'finish-step',
    ]) {
      expect(classifyStreamPart({ type, id: 'c1', toolName: 't' }).kind, type).not.toBe('ignore');
    }
  });

  it('ignores metadata parts that are not tokens', () => {
    expect(classifyStreamPart({ type: 'start' })).toEqual({ kind: 'ignore' });
    expect(classifyStreamPart({ type: 'reasoning-start', id: '0' })).toEqual({ kind: 'ignore' });
    expect(classifyStreamPart(null)).toEqual({ kind: 'ignore' });
  });
});

describe('generate-route wait copy', () => {
  it('names the wait so the Code pane is not stuck on Planning', () => {
    expect(WAITING_FOR_MODEL_STATUS).toMatch(/model/i);
    expect(MODEL_THINKING_STATUS).toMatch(/thinking/i);
    expect(WAITING_FOR_MODEL_STATUS).not.toMatch(/Planning application structure/);
  });
});

describe('the generate route consumes thinking tokens', () => {
  it('walks fullStream and forwards reasoning as thinking frames', () => {
    const source = live(ROUTE);
    expect(source).toContain('for await (const part of stream.fullStream');
    expect(source).toContain("type: 'thinking'");
    expect(source).toContain('WAITING_FOR_MODEL_STATUS');
    expect(source).toContain('classifyStreamPart');
    expect(source).toContain('collectCtx.progress()');
  });

  /**
   * A kind the route does not name falls through to the text path at
   * `generatedCode += text` / `streamedFiles.push(text)`.
   *
   * For the other tool parts that would merely append `''`. `tool-input-delta` is
   * different in kind: it carries *non-empty* text — the JSON argument blob, which
   * for `write_file` is the whole file — so falling through would splice JSON into
   * the reply and run the fence scanner over it. That corrupts the persisted file
   * set, not just the chat transcript.
   *
   * Position, not just presence: an assertion that the route merely mentions these
   * kinds still passes if the guard is moved *below* the text path, which is
   * exactly the edit that would reintroduce the corruption.
   */
  it('continues on every tool-input kind before reaching the text path', () => {
    const source = live(ROUTE);
    const textPath = source.indexOf('generatedCode += text');
    expect(textPath, 'the text path moved; re-point this test').toBeGreaterThan(0);
    for (const kind of ['tool-input-start', 'tool-input-delta', 'tool-input-end']) {
      const guard = source.indexOf(`classified.kind === '${kind}'`);
      expect(guard, `route does not handle ${kind}`).toBeGreaterThan(0);
      expect(guard, `${kind} is handled after the text path, so its JSON reaches the reply`).
        toBeLessThan(textPath);
    }
    // And the branch they sit in is the one that stops, rather than falling through.
    const branchEnd = source.indexOf('continue;', source.indexOf("classified.kind === 'tool-input-end'"));
    expect(branchEnd, 'the tool-input branch does not continue').toBeGreaterThan(0);
    expect(branchEnd).toBeLessThan(textPath);
  });

  it('rewrites DeepSeek reasoning_content before the OpenAI client drops it', () => {
    const source = live(CLIENT);
    expect(source).toContain('createDeepSeekReasoningFetch');
    expect(source).toContain('extractReasoningMiddleware');
  });
});
