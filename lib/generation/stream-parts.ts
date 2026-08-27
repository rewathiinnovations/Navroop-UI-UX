/**
 * Classify AI SDK `fullStream` parts so the generate route can forward
 * reasoning as `thinking` frames and text as `stream` frames.
 *
 * `textStream` ignores reasoning. Waiting on it is how a thinking-mode model
 * left the Code pane on "Planning application structure..." until the idle
 * bound killed the run.
 *
 * The tool parts are classified for the same reason, pointed at a different
 * failure. The route's collect loop `continue`s on `ignore` *before* it rearms
 * the idle bound, so an unrecognised part is not merely unshown — it does not
 * count as progress. A step that only calls tools emits no text at all, so with
 * the tool parts falling through to `ignore` a perfectly healthy tool-writing
 * generation goes quiet for five minutes and gets reaped as stalled. Every part
 * named here must reach `collectCtx.progress()`.
 *
 * The three `tool-input-*` parts are the widest case of that same failure. They
 * carry the tool call's arguments as they stream, and for `write_file` the
 * argument *is* the whole file — so this is the longest quiet stretch of a tool
 * run, and it was the one stretch that counted as no progress at all.
 *
 * Field names are the ones `fullStream` actually emits. `TextStreamPart` spells
 * these `id` and `delta`; the `toolCallId` / `inputTextDelta` spelling belongs
 * to `UIMessageChunk`, a different union this route never sees. Both are read
 * so the classifier stays correct if a caller ever feeds it the UI stream, but
 * `id` / `delta` are what production hits. `partText` is not reused: it reads
 * `text` first, which no `tool-input-delta` carries.
 */

export const WAITING_FOR_MODEL_STATUS = 'Waiting for the model...';
export const MODEL_THINKING_STATUS = 'The model is thinking...';

export type ClassifiedStreamPart =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'reasoning-end' }
  | { kind: 'tool-call'; toolName: string; toolCallId: string }
  | { kind: 'tool-result'; toolName: string; toolCallId: string }
  | { kind: 'tool-error'; toolName: string; toolCallId: string }
  | { kind: 'tool-input-start'; toolName: string; toolCallId: string }
  | { kind: 'tool-input-delta'; toolCallId: string; text: string }
  | { kind: 'tool-input-end'; toolCallId: string }
  | { kind: 'step-finish' }
  | { kind: 'ignore' };

function partText(part: Record<string, unknown>): string {
  if (typeof part.text === 'string') return part.text;
  if (typeof part.delta === 'string') return part.delta;
  return '';
}

function stringField(part: Record<string, unknown>, name: string): string {
  const value = part[name];
  return typeof value === 'string' ? value : '';
}

/** `fullStream` spells a tool call's id `id`; the UI stream spells it `toolCallId`. */
function toolCallIdField(part: Record<string, unknown>): string {
  const id = stringField(part, 'id');
  return id || stringField(part, 'toolCallId');
}

/** The streamed argument text. `delta` on `fullStream`, `inputTextDelta` on the UI stream. */
function inputDeltaText(part: Record<string, unknown>): string {
  const delta = stringField(part, 'delta');
  return delta || stringField(part, 'inputTextDelta');
}

export function classifyStreamPart(part: unknown): ClassifiedStreamPart {
  if (!part || typeof part !== 'object') return { kind: 'ignore' };
  const record = part as Record<string, unknown>;
  const type = record.type;
  if (type === 'text-delta') return { kind: 'text', text: partText(record) };
  if (type === 'reasoning-delta' || type === 'reasoning') {
    return { kind: 'reasoning', text: partText(record) };
  }
  if (type === 'reasoning-end') return { kind: 'reasoning-end' };
  if (type === 'tool-call' || type === 'tool-result' || type === 'tool-error') {
    return {
      kind: type,
      toolName: stringField(record, 'toolName'),
      toolCallId: stringField(record, 'toolCallId'),
    };
  }
  if (type === 'tool-input-start') {
    return {
      kind: 'tool-input-start',
      toolName: stringField(record, 'toolName'),
      toolCallId: toolCallIdField(record),
    };
  }
  if (type === 'tool-input-delta') {
    return {
      kind: 'tool-input-delta',
      toolCallId: toolCallIdField(record),
      text: inputDeltaText(record),
    };
  }
  if (type === 'tool-input-end') {
    return { kind: 'tool-input-end', toolCallId: toolCallIdField(record) };
  }
  // The SDK spells the end of a step `finish-step`; the classification is
  // `step-finish` so it reads as an event rather than as a part name.
  if (type === 'finish-step') return { kind: 'step-finish' };
  return { kind: 'ignore' };
}
