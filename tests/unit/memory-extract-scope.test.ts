/**
 * F-100 / F-051: memory extraction read `globalThis.conversationState` — a single
 * process-wide slot the generate route overwrote on every request — so a post-generation
 * extraction for project A could read whatever project B had published last and store B's
 * prompt text as a MemoryEntry row against A (Brain tab → Review extracted memory).
 * Extraction may only ever see the project's own keyed conversation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessage } from '@/types/conversation';

// Deps are injected below; the db import only has to resolve.
vi.mock('@/lib/db', () => ({ prisma: {} }));

// Dynamic, not static: the `vi.mock` above must register before the modules under
// test evaluate their own imports (the sibling suites use the same shape).
const { conversationStateFor, resetConversationStates } =
  await import('@/lib/generation/conversation-state');
const { extractMemoriesAfterGeneration } = await import('@/lib/memory/extract');

type GlobalWithLegacySlot = typeof globalThis & {
  conversationState?: { context: { messages: ConversationMessage[] } };
};

function userMessage(content: string): ConversationMessage {
  return { id: `msg-${content}`, role: 'user', content, timestamp: Date.now() };
}

afterEach(() => {
  resetConversationStates();
  delete (globalThis as GlobalWithLegacySlot).conversationState;
});

describe('memory extraction reads only the project\u2019s own conversation', () => {
  it('never attributes another project\u2019s messages to this one', async () => {
    // Project A's own history, in the keyed store.
    conversationStateFor('proj-a', 'user-a').context.messages.push(
      userMessage('always write copy in Norwegian'),
    );
    // Project B published last. Writing the legacy unkeyed slot must change nothing —
    // it used to be exactly what extraction read.
    (globalThis as GlobalWithLegacySlot).conversationState = {
      context: { messages: [userMessage('B-SECRET payroll dashboard for project B')] },
    };

    const seen: string[] = [];
    await extractMemoriesAfterGeneration(
      'proj-a',
      { sourceMessage: 'add a footer' },
      {
        isEnabled: async () => true,
        listActiveContents: async () => [],
        complete: async (userText) => {
          seen.push(userText);
          return '[]';
        },
        insertPending: async () => {},
      },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('always write copy in Norwegian');
    expect(seen[0]).toContain('add a footer');
    expect(seen[0]).not.toContain('B-SECRET');
  });

  it('two concurrent projects each extract from their own history', async () => {
    conversationStateFor('proj-a', 'user-a').context.messages.push(userMessage('A wants a bakery'));
    conversationStateFor('proj-b', 'user-b').context.messages.push(userMessage('B wants payroll'));

    const seenByProject = new Map<string, string>();
    const depsFor = (projectId: string) => ({
      isEnabled: async () => true,
      listActiveContents: async () => [],
      complete: async (userText: string) => {
        seenByProject.set(projectId, userText);
        return '[]';
      },
      insertPending: async () => {},
    });

    await Promise.all([
      extractMemoriesAfterGeneration('proj-a', {}, depsFor('proj-a')),
      extractMemoriesAfterGeneration('proj-b', {}, depsFor('proj-b')),
    ]);

    expect(seenByProject.get('proj-a')).toContain('A wants a bakery');
    expect(seenByProject.get('proj-a')).not.toContain('B wants payroll');
    expect(seenByProject.get('proj-b')).toContain('B wants payroll');
    expect(seenByProject.get('proj-b')).not.toContain('A wants a bakery');
  });
});
