import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  restoreTextIfNotSent,
  SEND_FAILED,
  shouldRestoreRefusedText,
  type SendOutcome,
} from '@/components/workspace/types';

/**
 * F-006. `ChatInput.submit` calls `onSend` and then `clear()`, which wipes the
 * textarea *and* the persisted `navroop_draft_<projectId>` record, without waiting
 * for the request. Wave 3 (F-002) gave the refused-because-already-running path a
 * way back through `SendOutcome`, but every *failing* exit of `sendChatMessage`
 * still returned `undefined` — indistinguishable from an accepted send — so a 402,
 * a 409, a 503, a locked project, or an offline browser silently ate the prompt.
 * The only copy left was the chat bubble.
 *
 * The decision under test is the one the input makes after a send settles: does the
 * typed text go back in the box? It is pure, so it is tested directly rather than
 * through a DOM.
 */

/** A stand-in for `useDraftStorage`'s `setValue`, which takes the same updater. */
function draftBox(initial = '') {
  let text = initial;
  return {
    setValue: (update: (current: string) => string) => {
      text = update(text);
    },
    get text() {
      return text;
    },
  };
}

describe('a send that never reached the server hands the text back', () => {
  it('reads SEND_FAILED as a refusal, not an accepted send', () => {
    expect(SEND_FAILED.accepted).toBe(false);
    expect(SEND_FAILED).toEqual({ accepted: false, reason: 'send-failed' });
  });

  it('restores the prompt when a failing exit reports the refusal', async () => {
    const box = draftBox();
    await restoreTextIfNotSent(
      Promise.resolve(SEND_FAILED),
      'build me a landing page',
      box.setValue,
    );
    expect(box.text).toBe('build me a landing page');
  });

  it('restores the prompt when the send handler throws instead of resolving', async () => {
    const box = draftBox();
    await restoreTextIfNotSent(
      Promise.reject(new Error('Failed to fetch')),
      'build me a landing page',
      box.setValue,
    );
    expect(box.text).toBe('build me a landing page');
  });

  /**
   * The regression this closes. Before the fix, `sendChatMessage`'s `!aiEnabled`
   * branch, its plan-followup failures, and its outer catch all fell off the end
   * returning `undefined`, so the input could not tell a rejection from a success
   * and left the box empty. Any new failing exit that forgets to return a refusal
   * reintroduces exactly this.
   */
  it('cannot restore anything when a failing exit returns nothing', () => {
    expect(shouldRestoreRefusedText(undefined, '')).toBe(false);
    expect(shouldRestoreRefusedText(SEND_FAILED, '')).toBe(true);
  });

  it('leaves the box alone for an accepted send', async () => {
    const box = draftBox();
    const accepted: SendOutcome = { accepted: true };
    await restoreTextIfNotSent(Promise.resolve(accepted), 'build me a landing page', box.setValue);
    expect(box.text).toBe('');
  });

  it('does not overwrite something newer typed while the send was in flight', async () => {
    const box = draftBox('a different idea');
    await restoreTextIfNotSent(
      Promise.resolve(SEND_FAILED),
      'build me a landing page',
      box.setValue,
    );
    expect(box.text).toBe('a different idea');
  });

  it('touches nothing for a caller that returns void and cannot refuse', async () => {
    const setValue = vi.fn();
    await restoreTextIfNotSent(undefined, 'build me a landing page', setValue);
    expect(setValue).not.toHaveBeenCalled();
  });

  it('still restores when the promise resolves void, which no failing exit does', async () => {
    // `onSend` is typed `Promise<SendOutcome | void>` for the plan thread and the
    // preview repair button. A void resolution means "no outcome reported", which
    // must not be read as a refusal — the text stays gone only because those
    // callers never fail silently.
    const box = draftBox();
    await restoreTextIfNotSent(Promise.resolve(), 'build me a landing page', box.setValue);
    expect(box.text).toBe('');
  });
});

/**
 * The pure decision above only matters if the component actually asks for it.
 * `submit` clears the box and the persisted draft one line after calling
 * `onSend`, so a `submit` that drops the returned outcome on the floor is the
 * original bug with the fix sitting unused next to it. There is no DOM testing
 * library here, so the wiring is read off the source.
 */
describe('ChatInput hands every send outcome to the restore path', () => {
  const source = readFileSync('components/workspace/ChatInput.tsx', 'utf8');

  it('captures what onSend returned rather than discarding it', () => {
    expect(source).toMatch(/const sent = onSend\(/);
  });

  it('calls restoreTextIfNotSent with the trimmed text it just sent', () => {
    expect(source).toContain('restoreTextIfNotSent(sent, trimmed, setValue)');
  });

  it('types onSend so a refusal can travel back to the input at all', () => {
    // A plain `=> void` prop cannot carry an outcome; that signature is what
    // made every failing exit indistinguishable from an accepted send.
    expect(source).toMatch(/onSend:.*Promise<SendOutcome \| void>/);
  });

  it('restores through the updater, not the captured value', () => {
    // `setValue(text)` would clobber anything typed during the round trip.
    expect(source).not.toMatch(/setValue\(trimmed\)/);
  });
});
