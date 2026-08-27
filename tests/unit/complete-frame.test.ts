import { describe, expect, it } from 'vitest';
import {
  completedCodeFromFrame,
  shouldSendGeneratedCode,
  truncationWarningLine,
  type StreamedReplyState,
} from '@/lib/generation/complete-frame';

/**
 * The `complete` frame used to carry the whole reply a second time — every chunk
 * was already a `stream` frame — which doubled the bytes on the wire for the
 * largest payload in the product (F-043). These pin the rule that decides when
 * the reply must still be sent and how the client recovers it when it is not.
 */
describe('shouldSendGeneratedCode', () => {
  const base: StreamedReplyState = {
    streamAttempts: 1,
    replyRewritten: false,
    streamedChars: 5_000,
  };

  it('omits the reply on the normal single-attempt stream', () => {
    expect(shouldSendGeneratedCode(base)).toBe(false);
  });

  it('sends the reply when nothing was streamed to the client', () => {
    // A reused completion or a provider that sent no `raw` frames: the client
    // has no buffer to fall back on.
    expect(shouldSendGeneratedCode({ ...base, streamedChars: 0 })).toBe(true);
  });

  it('sends the reply after a failover retry', () => {
    // A second attempt streamed a second reply into the same buffer, so the
    // buffer is two replies concatenated and cannot stand in for the final one.
    expect(shouldSendGeneratedCode({ ...base, streamAttempts: 2 })).toBe(true);
  });

  it('sends the reply when it was rewritten after streaming', () => {
    // The corrective ask or truncation recovery replaced text the client already
    // received, so its buffer is stale.
    expect(shouldSendGeneratedCode({ ...base, replyRewritten: true })).toBe(true);
  });

  it('treats zero attempts (no stream ever ran) as needing the reply', () => {
    expect(
      shouldSendGeneratedCode({ streamAttempts: 0, replyRewritten: false, streamedChars: 0 }),
    ).toBe(true);
  });
});

describe('completedCodeFromFrame', () => {
  it('prefers the frame payload when the route sent one', () => {
    expect(completedCodeFromFrame('from-frame', 'accumulated')).toBe('from-frame');
  });

  it('falls back to the accumulated buffer when the frame omitted the reply', () => {
    expect(completedCodeFromFrame(undefined, 'accumulated')).toBe('accumulated');
    expect(completedCodeFromFrame('', 'accumulated')).toBe('accumulated');
  });

  it('ignores a non-string frame value', () => {
    expect(completedCodeFromFrame(null, 'accumulated')).toBe('accumulated');
    expect(completedCodeFromFrame(42, 'accumulated')).toBe('accumulated');
  });

  it('round-trips: a stream the route chose not to resend is recovered verbatim', () => {
    const reply = '```tsx{path=app/page.tsx}\nexport default () => null;\n```';
    const state: StreamedReplyState = {
      streamAttempts: 1,
      replyRewritten: false,
      streamedChars: reply.length,
    };
    // The route omits it…
    const sent = shouldSendGeneratedCode(state) ? reply : undefined;
    expect(sent).toBeUndefined();
    // …and the client rebuilds it from its own accumulated buffer.
    expect(completedCodeFromFrame(sent, reply)).toBe(reply);
  });
});

describe('truncationWarningLine', () => {
  it('is null when the frame carries no warnings', () => {
    expect(truncationWarningLine(undefined)).toBeNull();
    expect(truncationWarningLine(null)).toBeNull();
    expect(truncationWarningLine('not an array')).toBeNull();
    expect(truncationWarningLine([])).toBeNull();
  });

  it('ignores entries that are not non-empty strings', () => {
    expect(truncationWarningLine([42, '', null, 'File src/App.tsx was cut off'])).toBe(
      'This reply looks cut off mid-file: File src/App.tsx was cut off',
    );
  });

  it('names at most three files and counts the rest', () => {
    const warnings = [
      'File a.ts was cut off',
      'File b.ts was cut off',
      'File c.ts was cut off',
      'File d.ts was cut off',
    ];
    expect(truncationWarningLine(warnings)).toBe(
      'This reply looks cut off mid-file: File a.ts was cut off File b.ts was cut off File c.ts was cut off (+1 more)',
    );
  });
});
