/**
 * The chat thread must land on its newest message when a project with a long
 * history is opened, not stay pinned to whatever rendered first at
 * `scrollTop: 0`.
 *
 * Measured on the live page (1440x900, fresh load): the scroller mounted at
 * `scrollTop: 0` with `scrollHeight: 1642` / `clientHeight: 687`. The
 * "only pin when already near the bottom" guard saw a huge distance from the
 * bottom and left it there — so the newest item in the thread, the
 * build-failure recovery panel with the only "Try again" / "Start over"
 * controls, sat 721px below the fold and was never visible.
 *
 * `nextChatScrollTop` is the pure decision behind the scroller's effect,
 * exercised here as plain scrollTop/scrollHeight/clientHeight numbers: this
 * repo's test toolchain has no jsdom/DOM environment to mount the component
 * and drive real layout in.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ChatPanel, {
  CHAT_BOTTOM_SLACK_PX,
  CHAT_JUMP_DURATION_MS,
  chatJumpStep,
  isChatAtBottom,
  nextChatScrollTop,
  readChatScrollEvent,
  type ChatScrollControl,
  type ChatScrollMetrics,
} from '@/components/workspace/ChatPanel';

describe('nextChatScrollTop', () => {
  it('pins a freshly mounted, overflowing scroller to the bottom on first paint', () => {
    // The exact live measurement from the bug report.
    const result = nextChatScrollTop(
      { scrollTop: 0, scrollHeight: 1642, clientHeight: 687 },
      /* hasPinnedOnce */ false,
    );

    expect(result.scrollTop).toBe(1642);
    expect(result.hasPinnedOnce).toBe(true);
  });

  it('does not yank the reader back down once they have scrolled up past the 80px threshold', () => {
    // First paint: pins to the bottom, as above.
    const first = nextChatScrollTop({ scrollTop: 0, scrollHeight: 1642, clientHeight: 687 }, false);
    expect(first.scrollTop).toBe(1642);

    // The reader scrolls up to re-read an earlier message, landing well past
    // the 80px near-bottom threshold (distance = 1642 - 400 - 687 = 555).
    const scrolledUp = { scrollTop: 400, scrollHeight: 1642, clientHeight: 687 };

    // A later render (a poll, a new message, an approving flag change) must
    // not move them, now that the first-paint pin has already happened.
    const later = nextChatScrollTop(scrolledUp, first.hasPinnedOnce);

    expect(later.scrollTop).toBe(scrolledUp.scrollTop);
    expect(later.hasPinnedOnce).toBe(true);
  });

  it('keeps pinning to new content while the reader stays near the bottom', () => {
    // Existing behaviour, preserved: within 80px of the bottom, new content
    // still pins.
    const result = nextChatScrollTop(
      { scrollTop: 900, scrollHeight: 1000, clientHeight: 687 },
      true,
    );

    expect(result.scrollTop).toBe(1000);
    expect(result.hasPinnedOnce).toBe(true);
  });

  it('does not pin an empty scroller with no overflow yet', () => {
    // Before messages have loaded, or when the thread fits the viewport,
    // there is nothing to pin to and no "first paint" to speak of.
    const result = nextChatScrollTop({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }, false);

    expect(result.scrollTop).toBe(0);
    expect(result.hasPinnedOnce).toBe(false);
  });

  /**
   * The regression this rule exists for (F-7). Measured immediately after a
   * follow-up edit finished and its reply rendered: scrollHeight 3080,
   * clientHeight 346, scrollTop 775 — 1959px from the bottom, with the user's own
   * message and the assistant's reply both below the fold and no indicator that
   * anything had arrived. The reader had not touched the scroller once; the
   * thread simply grew past them while the pinning effect was not running.
   */
  it('re-pins a reader who never scrolled, however far the thread grew in one step', () => {
    const grown = { scrollTop: 775, scrollHeight: 3080, clientHeight: 346 };

    // The old geometric rule reads the same numbers as "they scrolled away".
    expect(nextChatScrollTop(grown, true).scrollTop).toBe(775);

    // Told what the scroller actually observed — no scroll, wheel or touch from
    // the reader — the decision goes the other way.
    expect(nextChatScrollTop(grown, true, false)).toEqual({
      scrollTop: 3080,
      hasPinnedOnce: true,
    });
  });

  it('leaves a reader who really did scroll where they are', () => {
    const away = { scrollTop: 400, scrollHeight: 1642, clientHeight: 687 };

    expect(nextChatScrollTop(away, true, true)).toEqual({ scrollTop: 400, hasPinnedOnce: true });
  });

  it('still pins the first paint even when the reader has already scrolled', () => {
    // Nothing has been read yet, so there is no reading position to protect.
    expect(
      nextChatScrollTop({ scrollTop: 0, scrollHeight: 1642, clientHeight: 687 }, false, true),
    ).toEqual({ scrollTop: 1642, hasPinnedOnce: true });
  });
});

describe('isChatAtBottom', () => {
  it('treats the slack band as the bottom and one pixel past it as away', () => {
    const at = { scrollTop: 1000 - CHAT_BOTTOM_SLACK_PX, scrollHeight: 1500, clientHeight: 500 };
    expect(isChatAtBottom(at)).toBe(true);
    expect(isChatAtBottom({ ...at, scrollTop: at.scrollTop - 1 })).toBe(false);
  });
});

/**
 * The regression the first fix introduced while closing F-7.
 *
 * That fix guarded its auto-scroll flag with "did this assignment actually move
 * the viewport?", asking whether the scroller's `scrollTop` differed from
 * `nextChatScrollTop`'s target — which is `scrollHeight`, a position no scroller
 * can ever hold (the reachable maximum is `scrollHeight - clientHeight`). For a
 * reader already at the bottom the answer was therefore always "yes": the flag
 * went up, the assignment was clamped to the position they were already on, and
 * no `scroll` event ever came to put the flag down again. `onScroll` released it
 * only on an at-bottom event, so a latched flag returned before it could record
 * that the reader had moved. Dragging the scrollbar or pressing Page Up — neither
 * of which fires `wheel` or `touchstart` — then left them with no pill and a pin
 * that yanked them back down: F-7's own symptom, restored.
 */
describe('readChatScrollEvent', () => {
  const grown: ChatScrollMetrics = { scrollTop: 775, scrollHeight: 3080, clientHeight: 346 };

  it('reads a scroll away from the end as the reader, after a pin the browser clamped to a no-op', () => {
    // The pin asked for 3080 and the browser clamped it to 2734, the position the
    // reader was already on — so nothing moved and nothing fired. What the
    // component recorded is where the viewport *is*, not what it asked for.
    const afterClampedPin: ChatScrollControl = { commandedScrollTop: 2734, readerAway: false };

    expect(readChatScrollEvent(afterClampedPin, grown)).toEqual({
      commandedScrollTop: null,
      readerAway: true,
    });
  });

  it('does not read a frame of its own walk to the end as the reader scrolling up', () => {
    const midWalk: ChatScrollControl = { commandedScrollTop: 775, readerAway: false };

    expect(readChatScrollEvent(midWalk, grown)).toBe(midWalk);
  });

  it('clears "away" when the viewport lands at the end, whoever put it there', () => {
    const away: ChatScrollControl = { commandedScrollTop: null, readerAway: true };

    expect(readChatScrollEvent(away, { ...grown, scrollTop: 2734 })).toEqual({
      commandedScrollTop: null,
      readerAway: false,
    });
  });
});

describe('chatJumpStep', () => {
  const grown: ChatScrollMetrics = { scrollTop: 775, scrollHeight: 3080, clientHeight: 346 };

  it('starts where the reader is and ends on the live end of the thread', () => {
    expect(
      chatJumpStep({ metrics: grown, from: 775, elapsed: 0, commandedScrollTop: 775 }),
    ).toEqual({ kind: 'move', scrollTop: 775, last: false });

    expect(
      chatJumpStep({
        metrics: { ...grown, scrollTop: 2600 },
        from: 775,
        elapsed: CHAT_JUMP_DURATION_MS,
        commandedScrollTop: 2600,
      }),
    ).toEqual({ kind: 'move', scrollTop: 2734, last: true });
  });

  it('re-reads the end every frame, so a build streaming underneath it is not left below the fold', () => {
    expect(
      chatJumpStep({
        metrics: { scrollTop: 2600, scrollHeight: 4000, clientHeight: 346 },
        from: 775,
        elapsed: CHAT_JUMP_DURATION_MS,
        commandedScrollTop: 2600,
      }),
    ).toEqual({ kind: 'move', scrollTop: 3654, last: true });
  });

  it('hands the scroller back when the reader moves it off the pixel the last frame wrote', () => {
    // A scrollbar drag or a Page Up during the walk: no wheel, no touch, and the
    // only trace of it is that the viewport is not where we put it.
    expect(
      chatJumpStep({ metrics: grown, from: 775, elapsed: 100, commandedScrollTop: 1500 }),
    ).toEqual({ kind: 'released' });
  });

  it('hands the scroller back when the scroll event got there first and dropped the command', () => {
    expect(
      chatJumpStep({ metrics: grown, from: 775, elapsed: 100, commandedScrollTop: null }),
    ).toEqual({ kind: 'released' });
  });
});

/**
 * A scroller that behaves the way a browser's does, driving the same pure
 * decisions the component drives: an assignment to `scrollTop` is clamped into
 * `[0, scrollHeight - clientHeight]`, and a `scroll` event fires only if the
 * position actually changed and only *after* the code that wrote it has
 * finished. An assignment the clamp turns into a no-op is therefore completely
 * silent — the case the old auto-scroll flag could never recover from.
 */
function chatScroller(initial: ChatScrollMetrics) {
  let { scrollTop, scrollHeight } = initial;
  const { clientHeight } = initial;
  let control: ChatScrollControl = { commandedScrollTop: null, readerAway: false };
  let hasPinnedOnce = false;
  let pill = false;
  let pending = false;
  let walking = false;
  let walkFrom = 0;

  const metrics = (): ChatScrollMetrics => ({ scrollTop, scrollHeight, clientHeight });

  function move(next: number) {
    const before = scrollTop;
    scrollTop = Math.min(Math.max(0, next), Math.max(0, scrollHeight - clientHeight));
    if (scrollTop !== before) pending = true;
  }

  function flush() {
    if (!pending) return;
    pending = false;
    control = readChatScrollEvent(control, metrics());
    pill = control.readerAway;
  }

  return {
    get scrollTop() {
      return scrollTop;
    },
    get pill() {
      return pill;
    },
    /** One run of the pinning effect. */
    pin() {
      if (walking) return;
      const decision = nextChatScrollTop(metrics(), hasPinnedOnce, control.readerAway);
      hasPinnedOnce = decision.hasPinnedOnce;
      if (decision.scrollTop === scrollTop) return;
      move(decision.scrollTop);
      control = { ...control, commandedScrollTop: scrollTop };
      flush();
    },
    /** The thread grows underneath the reader: no scroll event, position holds. */
    grow(by: number) {
      scrollHeight += by;
    },
    /** The reader moves the viewport by a means that fires no wheel and no touch. */
    readerScrollsTo(next: number) {
      move(next);
      flush();
    },
    startWalk() {
      walking = true;
      walkFrom = scrollTop;
      control = { commandedScrollTop: scrollTop, readerAway: false };
      pill = false;
    },
    walkFrame(elapsed: number) {
      const step = chatJumpStep({
        metrics: metrics(),
        from: walkFrom,
        elapsed,
        commandedScrollTop: control.commandedScrollTop,
      });
      if (step.kind === 'released') {
        walking = false;
        return step.kind;
      }
      move(step.scrollTop);
      control = { ...control, commandedScrollTop: scrollTop };
      flush();
      if (step.last) walking = false;
      return step.kind;
    },
  };
}

describe('the chat scroller under a browser that clamps', () => {
  /**
   * The exact failure the adversarial review found, end to end: a reader parked
   * at the bottom of a streaming build, the pin effect re-running on every parent
   * render with each run clamped to a no-op, and then the reader taking the
   * scroller over by dragging the scrollbar. Under the latched flag this left
   * them with no pill and a yank straight back to the bottom.
   */
  it('shows the pill and holds the reading position when a scrollbar drag follows clamped pins', () => {
    // F-7's own geometry: scrollHeight 3080, clientHeight 346 — so the furthest
    // the scroller reaches is 2734, and that is where the reader is sitting.
    const chat = chatScroller({ scrollTop: 0, scrollHeight: 3080, clientHeight: 346 });
    chat.pin();
    expect(chat.scrollTop).toBe(2734);

    // `children` is a fresh identity on every parent render; the effect used to
    // re-run for all of them. Each run asks for 3080, the browser clamps it back
    // to 2734, and no `scroll` event is fired at all.
    for (let i = 0; i < 25; i += 1) chat.pin();
    expect(chat.scrollTop).toBe(2734);
    expect(chat.pill).toBe(false);

    // The reader drags the scrollbar up to re-read an earlier message. No wheel,
    // no touchstart — under the old flag, no way back.
    chat.readerScrollsTo(775);
    expect(chat.pill).toBe(true);

    // The build keeps streaming, so the effect keeps running. None of it may move
    // them.
    chat.grow(400);
    chat.pin();
    chat.pin();
    expect(chat.scrollTop).toBe(775);
    expect(chat.pill).toBe(true);
  });

  it('lets an arrow-key nudge off the bottom raise the pill, small as it is', () => {
    const chat = chatScroller({ scrollTop: 0, scrollHeight: 3080, clientHeight: 346 });
    chat.pin();
    for (let i = 0; i < 5; i += 1) chat.pin();

    // One press of the up arrow, roughly three lines — well inside the 80px slack
    // band, so still "at the bottom" and no pill yet.
    chat.readerScrollsTo(2734 - 40);
    expect(chat.pill).toBe(false);

    // Three more take them past the band. Nothing about this fires a wheel event.
    chat.readerScrollsTo(2734 - 160);
    expect(chat.pill).toBe(true);

    chat.pin();
    expect(chat.scrollTop).toBe(2574);
  });

  it('keeps pinning a reader who has not moved, however far the thread grows in one step', () => {
    // The measured stranding, rebuilt: the reader is pinned at 775 — the end of
    // the thread as it stood — and then a follow-up edit lands and its reply
    // streams in, taking scrollHeight to 3080 in one go.
    const chat = chatScroller({ scrollTop: 0, scrollHeight: 1121, clientHeight: 346 });
    chat.pin();
    expect(chat.scrollTop).toBe(775);

    chat.grow(1959);
    chat.pin();

    expect(chat.scrollTop).toBe(2734);
    expect(chat.pill).toBe(false);
  });

  it('leaves the reader in control when they interrupt the walk to the latest message', () => {
    const chat = chatScroller({ scrollTop: 0, scrollHeight: 3080, clientHeight: 346 });
    chat.pin();
    chat.readerScrollsTo(775);
    expect(chat.pill).toBe(true);

    chat.startWalk();
    expect(chat.pill).toBe(false);
    expect(chat.walkFrame(40)).toBe('move');
    expect(chat.scrollTop).toBeGreaterThan(775);
    // The walk's own frames sit mid-thread and must not read as the reader
    // parking there.
    expect(chat.pill).toBe(false);

    // Halfway there they grab the scrollbar and drag back up.
    chat.readerScrollsTo(500);
    expect(chat.pill).toBe(true);
    expect(chat.walkFrame(80)).toBe('released');

    chat.pin();
    expect(chat.scrollTop).toBe(500);
    expect(chat.pill).toBe(true);
  });

  it('finishes the walk at the end and hands the pin back', () => {
    const chat = chatScroller({ scrollTop: 0, scrollHeight: 3080, clientHeight: 346 });
    chat.pin();
    chat.readerScrollsTo(775);

    chat.startWalk();
    chat.walkFrame(40);
    chat.walkFrame(140);
    expect(chat.walkFrame(CHAT_JUMP_DURATION_MS)).toBe('move');

    expect(chat.scrollTop).toBe(2734);
    expect(chat.pill).toBe(false);

    // The walk is over, so new content pins again.
    chat.grow(400);
    chat.pin();
    expect(chat.scrollTop).toBe(3134);
  });
});

describe('ChatPanel scroller wiring', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'components/workspace/ChatPanel.tsx'),
    'utf8',
  );

  it('does not make wheel and touch the reader’s only way to reclaim the scroller', () => {
    // A scrollbar drag, Page Up / Page Down, Home / End, the arrow keys,
    // find-in-page and a focus jump all fire neither.
    expect(source).not.toMatch(/onWheel=|onTouchStart=/);
  });

  it('walks to the latest message without motion when the reader asked for none', () => {
    expect(source).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
  });
});

/**
 * The affordance that was missing entirely: the DOM carried zero jump-to-latest
 * controls while the thread sat 1959px below the reader. It is rendered always
 * and toggled with `display` so this harness — `react-dom/server`, no DOM, no
 * scroll events — can still prove it exists, is labelled, and is reachable with
 * a visible focus ring.
 */
describe('ChatPanel jump-to-latest control', () => {
  function jumpButton() {
    const markup = renderToStaticMarkup(
      createElement(ChatPanel, { messages: [], projectId: 'p1' }),
    );
    const label = markup.indexOf('Jump to latest');
    expect(label).toBeGreaterThan(-1);
    return markup.slice(markup.lastIndexOf('<button', label), label);
  }

  it('is a real button with a focus ring and a 44px hit target', () => {
    const button = jumpButton();

    expect(button).toContain('type="button"');
    expect(button).toContain('focus-visible:ring-[var(--studio-ring)]');
    expect(button).toContain('min-h-[44px]');
    // Studio tokens only — no new colour, no hardcoded hex.
    expect(button).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('stays out of sight, and out of the tab order, until the reader is away', () => {
    const button = jumpButton();

    expect(button).toContain('hidden');
    expect(button).not.toContain('inline-flex');
  });
});
