/**
 * F-812: follow-up plans spliced "Recent messages:" from `globalThis.conversationState`,
 * a process-wide slot with no project id anywhere in the lookup — user A's prompt text
 * was sent to the model as context for user B's plan, and the plan was shaped by another
 * project's requirements. The context may only come from the project's own keyed
 * conversation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessage } from '@/types/conversation';

// next-auth cannot resolve `next/server` outside the Next runtime; plan.ts only needs
// these bindings to import.
vi.mock('@/auth', () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
  unstable_update: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ prisma: {} }));

// Dynamic so every vi.mock above registers before the module graph is evaluated.
const { buildFollowUpPromptContext } = await import('@/lib/projects/plan');
const { conversationStateFor, resetConversationStates } =
  await import('@/lib/generation/conversation-state');

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

describe('follow-up plan context comes from the project\u2019s own conversation', () => {
  it('splices only this project\u2019s recent messages', () => {
    conversationStateFor('proj-a', 'user-a').context.messages.push(
      userMessage('project A needs a gallery page'),
    );
    // Another project published last. Writing the legacy unkeyed slot must change
    // nothing — it used to be exactly what the plan context was read from.
    (globalThis as GlobalWithLegacySlot).conversationState = {
      context: { messages: [userMessage('B-SECRET internal payroll numbers')] },
    };

    const context = buildFollowUpPromptContext('proj-a', 'add a checkout page', null);

    expect(context).toContain('add a checkout page');
    expect(context).toContain('project A needs a gallery page');
    expect(context).not.toContain('B-SECRET');
  });

  it('two projects\u2019 follow-up contexts never cross', () => {
    conversationStateFor('proj-a', 'user-a').context.messages.push(userMessage('A wants a bakery'));
    conversationStateFor('proj-b', 'user-b').context.messages.push(userMessage('B wants payroll'));

    const contextA = buildFollowUpPromptContext('proj-a', 'follow up A', null);
    const contextB = buildFollowUpPromptContext('proj-b', 'follow up B', null);

    expect(contextA).toContain('A wants a bakery');
    expect(contextA).not.toContain('B wants payroll');
    expect(contextB).toContain('B wants payroll');
    expect(contextB).not.toContain('A wants a bakery');
  });
});
