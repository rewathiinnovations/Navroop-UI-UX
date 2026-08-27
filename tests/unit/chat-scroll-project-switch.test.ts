/**
 * Scroll control is per-conversation state, and it must not outlive the
 * conversation.
 *
 * `ChatPanel` is rendered once, with no `key`, from `ProjectWorkspace`, which
 * `GenerationWorkspace` also renders with no `key` — and switching projects in the
 * sidebar navigates to `/project/{id}`, the same route segment, so React
 * reconciles all three instead of remounting them. Every ref and every `useState`
 * in the chat therefore crossed a project switch intact.
 *
 * The measured failure: a reader scrolls up in project A's thread (pill showing,
 * `readerAway: true`), then clicks project B in the sidebar. `attachToProject`
 * clears `messages`, but nothing cleared the scroll control — so as B's build
 * streamed and its thread grew past the viewport, `pinToBottom` read
 * `readerAway: true`, returned the scrollTop it was handed and wrote nothing. B's
 * thread never followed its own build for a reader who had never scrolled in B,
 * under a stale "Jump to latest" pill that had been up since the project opened.
 *
 * Exercised as plain numbers, and against the component's source: this repo's test
 * toolchain has no jsdom, so no test here can mount the workspace and navigate it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isConversationSwitch,
  nextChatScrollTop,
  readChatScrollEvent,
  type ChatScrollControl,
  type ChatScrollMetrics,
} from '@/components/workspace/ChatPanel';

const CHAT_PANEL = readFileSync(
  path.join(process.cwd(), 'components/workspace/ChatPanel.tsx'),
  'utf8',
);
const PROJECT_WORKSPACE = readFileSync(
  path.join(process.cwd(), 'components/workspace/ProjectWorkspace.tsx'),
  'utf8',
);

describe('what counts as leaving a conversation', () => {
  it('is another project id, whichever way the reader got there', () => {
    expect(isConversationSwitch('project-a', 'project-b')).toBe(true);
    expect(isConversationSwitch('project-a', null)).toBe(true);
  });

  it('is not the same project re-rendering', () => {
    expect(isConversationSwitch('project-a', 'project-a')).toBe(false);
  });

  it('is not the id arriving mid-build for a run that started without a project', () => {
    // `projectId` goes null -> id when the row for an unsaved build is created and
    // the id flows down to the workspace. The reader is watching the same build in
    // the same thread; resetting there would yank their position mid-stream and
    // discard the state of a conversation they are still in. `GenerationWorkspace`'s
    // own file-map effect carries the identical guard.
    expect(isConversationSwitch(null, 'project-a')).toBe(false);
    expect(isConversationSwitch(null, null)).toBe(false);
  });
});

/**
 * The same browser-shaped scroller the pin tests use — an assignment to
 * `scrollTop` is clamped into `[0, scrollHeight - clientHeight]` and a `scroll`
 * event fires only when the position really changed — with the project switch
 * added. `reset` is what the component's conversation effect does; running the
 * harness with it turned off is the broken build, and both are asserted below so
 * the difference is the test rather than an assumption.
 */
function chatScroller(initial: ChatScrollMetrics, options: { resetsOnSwitch: boolean }) {
  let { scrollTop, scrollHeight } = initial;
  const { clientHeight } = initial;
  let control: ChatScrollControl = { commandedScrollTop: null, readerAway: false };
  let hasPinnedOnce = false;
  let pill = false;
  let pending = false;

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
    /**
     * The sidebar navigates to another project: the parent clears `messages`, so
     * the thread collapses to nothing, and the component is reconciled rather than
     * remounted. The conversation effect runs before the pinning effect in that
     * same commit, which is why the reset lands first here too.
     */
    switchProject(from: string | null, to: string | null) {
      if (options.resetsOnSwitch && isConversationSwitch(from, to)) {
        hasPinnedOnce = false;
        control = { commandedScrollTop: null, readerAway: false };
        pill = false;
      }
      scrollHeight = clientHeight;
      scrollTop = 0;
      pending = false;
    },
  };
}

describe('switching projects hands the new thread a fresh scroller', () => {
  /** A reader who scrolled up in A, then opened B from the sidebar. */
  function readerLeavesProjectA(resetsOnSwitch: boolean) {
    // F-7's geometry: scrollHeight 3080, clientHeight 346, so the end is 2734.
    const chat = chatScroller(
      { scrollTop: 0, scrollHeight: 3080, clientHeight: 346 },
      { resetsOnSwitch },
    );
    chat.pin();
    expect(chat.scrollTop).toBe(2734);

    // They drag the scrollbar up to re-read an earlier message in project A.
    chat.readerScrollsTo(775);
    expect(chat.pill).toBe(true);

    chat.switchProject('project-a', 'project-b');
    return chat;
  }

  it('opens the new project with no "Jump to latest" pill left over from the old one', () => {
    const chat = readerLeavesProjectA(true);
    expect(chat.pill).toBe(false);

    // The broken build: the pill is up before B has rendered a single message.
    expect(readerLeavesProjectA(false).pill).toBe(true);
  });

  it('follows the new project’s build for a reader who never scrolled in it', () => {
    const chat = readerLeavesProjectA(true);

    // B's plan card, then its build: the thread grows past the viewport in steps,
    // and every one of them re-runs the pinning effect.
    chat.grow(900);
    chat.pin();
    chat.grow(1834);
    chat.pin();

    expect(chat.scrollTop).toBe(2734);
    expect(chat.pill).toBe(false);
  });

  it('is the defect when the control survives: B’s thread never moves', () => {
    const stale = readerLeavesProjectA(false);

    stale.grow(900);
    stale.pin();
    stale.grow(1834);
    stale.pin();

    // `readerAway` was still true from project A, so every pin returned the
    // scrollTop it was handed and wrote nothing.
    expect(stale.scrollTop).toBe(0);
    expect(stale.pill).toBe(true);
  });

  it('still lets a reader who scrolls in the new project keep their place', () => {
    const chat = readerLeavesProjectA(true);
    chat.grow(2734);
    chat.pin();
    expect(chat.scrollTop).toBe(2734);

    // Page Up in project B — no wheel, no touch.
    chat.readerScrollsTo(775);
    expect(chat.pill).toBe(true);
    chat.grow(400);
    chat.pin();
    expect(chat.scrollTop).toBe(775);
    expect(chat.pill).toBe(true);
  });

  it('does not reset the thread when a running build finally gets a project row', () => {
    const chat = chatScroller(
      { scrollTop: 0, scrollHeight: 3080, clientHeight: 346 },
      { resetsOnSwitch: true },
    );
    chat.pin();
    chat.readerScrollsTo(775);
    expect(chat.pill).toBe(true);

    // Same conversation, same thread: only the id showed up.
    chat.switchProject(null, 'project-a');
    expect(chat.pill).toBe(true);
  });
});

/**
 * The state list is the part that rots. A reset that enumerates what it clears is
 * only correct on the day it is written, so this holds the enumeration to the
 * component: every `useState` and every `useRef` in `ChatPanel` is either cleared
 * when the conversation changes or named below as something that is not about the
 * conversation, with the reason. Adding either kind without saying which fails
 * here rather than shipping the F-7 stranding again under a new name.
 */
describe('every piece of ChatPanel state has a declared lifetime', () => {
  /** Refs that hold a DOM node React re-attaches itself, and the tracker. */
  const NOT_CONVERSATION_STATE = new Set(['scrollerRef', 'contentRef', 'conversationRef']);

  function conversationResetBlock() {
    const at = CHAT_PANEL.indexOf('const conversationRef = useRef<string | null>(projectId);');
    expect(at, 'ChatPanel does not track the conversation its state belongs to').toBeGreaterThan(-1);
    const end = CHAT_PANEL.indexOf('}, [projectId]);', at);
    expect(end).toBeGreaterThan(at);
    return CHAT_PANEL.slice(at, end);
  }

  it('resets on the project id, not on every render', () => {
    const block = conversationResetBlock();
    expect(block).toMatch(/if \(!isConversationSwitch\(previous, projectId\)\) return;/);
  });

  it('clears every ref and every state hook that describes one conversation', () => {
    const block = conversationResetBlock();
    const declared = [
      ...CHAT_PANEL.matchAll(/const (\w+) = useRef[<(]/g),
      ...CHAT_PANEL.matchAll(/const \[(\w+), set\w+\] = useState/g),
    ].map((match) => match[1]);

    // Sanity: the scan found the hooks, so an empty list cannot pass this vacuously.
    expect(declared).toContain('controlRef');
    expect(declared).toContain('showJump');

    for (const name of declared) {
      if (NOT_CONVERSATION_STATE.has(name)) continue;
      const setter = `set${name[0].toUpperCase()}${name.slice(1)}(`;
      expect(
        block.includes(`${name}.current`) || block.includes(setter),
        `${name} survives a project switch: clear it in the conversation effect, or name it in NOT_CONVERSATION_STATE`,
      ).toBe(true);
    }
  });

  it('runs before the pinning effect, so the new thread gets a first paint', () => {
    const resetAt = CHAT_PANEL.indexOf('hasPinnedOnceRef.current = false;');
    const pinEffectAt = CHAT_PANEL.indexOf('    pinToBottom();');
    expect(resetAt).toBeGreaterThan(-1);
    expect(pinEffectAt).toBeGreaterThan(-1);
    expect(resetAt).toBeLessThan(pinEffectAt);
  });
});

/**
 * The chat is not the only state in the workspace with a conversation's lifetime.
 * `ProjectWorkspace` is reconciled across the same switch, so its plan editor and
 * its version drawer crossed it too — `editingPlan` opens the *next* project's plan
 * card in an edit form nobody asked for.
 */
describe('ProjectWorkspace drops its per-project state on a switch', () => {
  it('closes the plan editor and the version drawer, and keeps the pane layout', () => {
    const at = PROJECT_WORKSPACE.indexOf(
      'const workspaceProjectRef = useRef<string | null>(projectId);',
    );
    expect(at).toBeGreaterThan(-1);
    const block = PROJECT_WORKSPACE.slice(at, PROJECT_WORKSPACE.indexOf('}, [projectId]);', at));
    expect(block).toMatch(/if \(!isConversationSwitch\(previous, projectId\)\) return;/);
    expect(block).toMatch(/setEditingPlan\(false\);/);
    expect(block).toMatch(/setSavingPlan\(false\);/);
    expect(block).toMatch(/setHistoryOpen\(false\);/);
    // A viewport preference, not a fact about the project.
    expect(block).not.toMatch(/setChatCollapsed\(/);
  });
});
