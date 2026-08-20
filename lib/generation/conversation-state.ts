import type { ConversationState } from '@/types/conversation';

/**
 * Conversation context, one entry per project.
 *
 * This used to be a single process-global that the generate route reset and mutated across
 * every `await` in a run. While project A streamed, a request for project B reset it — and
 * A's context build, which happens inside the detached worker seconds later, then read B's
 * messages: on a multi-user instance another person's prompt text was pasted into A's model
 * call under "Recent Messages" and "RECENTLY CREATED/EDITED FILES (DO NOT RECREATE THESE)",
 * while A's own history silently vanished. The project lock only serializes work on the
 * *same* project, so it never covered this.
 *
 * Each project keeps its own state now, and a run resolves it once and holds that one
 * reference for the whole stream.
 */

/** Bounded so a long-lived process cannot accumulate one entry per project ever seen. */
const CONVERSATION_STATES_KEPT = 20;

const states = new Map<string, ConversationState>();

/**
 * This project's conversation state, created on first use. Never null.
 *
 * A saved project is keyed by itself — members of one project may legitimately share its
 * history. A run that has no project row yet has nothing to scope by, and keying those on
 * `''` put every unsaved run in the process into one bucket: two people starting a build
 * from the home page still shared messages, edits and the "RECENTLY CREATED/EDITED FILES
 * (DO NOT RECREATE THESE)" list — the same cross-user bleed this module exists to stop,
 * merely narrowed to the unsaved path. The signed-in user is the narrowest scope available
 * there, and it still lets one person's follow-up find their own history.
 */
export function conversationStateFor(projectId: string | null, userId: string): ConversationState {
  const key = projectId ?? `user:${userId}`;
  const existing = states.get(key);
  if (existing) {
    // Re-insert so eviction below drops the least recently used project, not this one.
    states.delete(key);
    states.set(key, existing);
    return existing;
  }
  const created: ConversationState = {
    conversationId: `conv-${Date.now()}`,
    projectId,
    startedAt: Date.now(),
    lastUpdated: Date.now(),
    context: {
      messages: [],
      edits: [],
      projectEvolution: { majorChanges: [] },
      userPreferences: {},
    },
  };
  states.set(key, created);
  for (const staleKey of states.keys()) {
    if (states.size <= CONVERSATION_STATES_KEPT) break;
    states.delete(staleKey);
  }
  return created;
}

/**
 * Read-only view of a saved project's conversation, if this process remembers one.
 * Never creates an entry and never reorders the LRU: the post-generation consumers —
 * checkpoint labels, memory extraction, the follow-up plan context — only need to look,
 * and a look that allocated could evict a live run's state. They each used to read a
 * single process-global published by whichever request ran last, which is how one
 * project's prompt text ended up naming another project's checkpoint.
 */
export function peekConversationState(projectId: string): ConversationState | null {
  return states.get(projectId) ?? null;
}

/**
 * The workspace-mount `clear-old`: bounds the caller's own remembered context. Operates
 * on exactly the key `conversationStateFor` resolves, creates nothing, and touches no
 * other key — applied to the old process-global it truncated whichever project had
 * published last, for everyone in the process.
 */
export function trimConversationState(projectId: string | null, userId: string): void {
  const key = projectId ?? `user:${userId}`;
  const state = states.get(key);
  if (!state) return;
  state.context.messages = state.context.messages.slice(-5);
  state.context.edits = state.context.edits.slice(-3);
  state.context.projectEvolution.majorChanges =
    state.context.projectEvolution.majorChanges.slice(-2);
  state.lastUpdated = Date.now();
}

/** Test seam: drops every remembered conversation. */
export function resetConversationStates() {
  states.clear();
}
