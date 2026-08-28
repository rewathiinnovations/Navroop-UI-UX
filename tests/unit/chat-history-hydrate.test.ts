import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/lib/generation/types';
import {
  displayJobPrompt,
  hasUserTurn,
  hydrateChatMessages,
  messagesFromChatJobs,
  parseChatMessages,
  serializeChatMessages,
  shouldPersistChat,
} from '@/lib/generation/chat-history';

function msg(
  type: ChatMessage['type'],
  content: string,
  at = '2026-08-28T06:00:00.000Z',
): ChatMessage {
  return { type, content, timestamp: new Date(at) };
}

describe('messagesFromChatJobs', () => {
  it('rebuilds a user turn and the apply sentence from a succeeded build', () => {
    const messages = messagesFromChatJobs([
      {
        kind: 'BUILD',
        status: 'SUCCEEDED',
        inputPrompt: 'Build a bakery site',
        filesWritten: 4,
        errorMessage: null,
        createdAt: '2026-08-28T06:00:00.000Z',
        finishedAt: '2026-08-28T06:02:00.000Z',
      },
    ]);

    expect(messages.map((row) => ({ type: row.type, content: row.content }))).toEqual([
      { type: 'user', content: 'Build a bakery site' },
      { type: 'ai', content: 'Successfully applied 4 files' },
    ]);
  });

  it('strips the approved-plan suffix so Approve & Build does not dump JSON into chat', () => {
    const messages = messagesFromChatJobs([
      {
        kind: 'PLAN',
        status: 'SUCCEEDED',
        inputPrompt: 'A landing page for a florist',
        filesWritten: 0,
        errorMessage: null,
        createdAt: '2026-08-28T06:00:00.000Z',
        finishedAt: '2026-08-28T06:01:00.000Z',
      },
      {
        kind: 'BUILD',
        status: 'SUCCEEDED',
        inputPrompt: 'A landing page for a florist\n\nApproved plan:\n{"summary":"x"}',
        filesWritten: 2,
        errorMessage: null,
        createdAt: '2026-08-28T06:02:00.000Z',
        finishedAt: '2026-08-28T06:04:00.000Z',
      },
    ]);

    const users = messages.filter((row) => row.type === 'user').map((row) => row.content);
    expect(users).toEqual(['A landing page for a florist']);
    expect(messages.some((row) => row.content.includes('Approved plan'))).toBe(false);
    expect(messages.some((row) => row.content === 'Successfully applied 2 files')).toBe(true);
  });

  it('keeps a failed follow-up as an error instead of dropping the turn', () => {
    const messages = messagesFromChatJobs([
      {
        kind: 'FOLLOWUP',
        status: 'FAILED',
        inputPrompt: 'Make the nav sticky',
        filesWritten: 0,
        errorMessage: 'The AI service did not respond',
        createdAt: '2026-08-28T06:10:00.000Z',
        finishedAt: '2026-08-28T06:10:30.000Z',
      },
    ]);

    expect(messages.map((row) => ({ type: row.type, content: row.content }))).toEqual([
      { type: 'user', content: 'Make the nav sticky' },
      { type: 'error', content: 'The AI service did not respond' },
    ]);
  });

  it('skips a running job reply so the live stream can write it', () => {
    const messages = messagesFromChatJobs([
      {
        kind: 'BUILD',
        status: 'RUNNING',
        inputPrompt: 'Add a footer',
        filesWritten: 0,
        errorMessage: null,
        createdAt: '2026-08-28T06:20:00.000Z',
        finishedAt: null,
      },
    ]);

    expect(messages).toEqual([expect.objectContaining({ type: 'user', content: 'Add a footer' })]);
  });
});

describe('hydrateChatMessages', () => {
  it('keeps a live thread that already has a user turn', () => {
    const live = [msg('system', 'Welcome'), msg('user', 'Make it blue')];
    const persisted = [msg('user', 'stale persist')];
    const fromJobs = [msg('user', 'from jobs')];

    expect(hydrateChatMessages({ live, persisted, fromJobs })).toEqual(live);
  });

  it('reloads persisted messages when the live thread is only welcome copy', () => {
    const live = [msg('system', 'Welcome! Describe the site')];
    const persisted = [msg('user', 'Build Vaidya'), msg('ai', 'Successfully applied 6 files')];

    expect(hydrateChatMessages({ live, persisted, fromJobs: [] })).toEqual(persisted);
  });

  it('falls back to job history when nothing is persisted', () => {
    const fromJobs = [msg('user', 'Clone stripe.com')];

    expect(hydrateChatMessages({ live: [], persisted: [], fromJobs })).toEqual(fromJobs);
  });
});

describe('chat persist round-trip', () => {
  it('serialises dates so a refresh can parse them back', () => {
    const original = [msg('user', 'Hello'), msg('ai', 'Done')];
    const restored = parseChatMessages(serializeChatMessages(original));

    expect(restored).toHaveLength(2);
    expect(restored[0]?.content).toBe('Hello');
    expect(restored[0]?.timestamp).toBeInstanceOf(Date);
    expect(restored[0]?.timestamp.toISOString()).toBe('2026-08-28T06:00:00.000Z');
  });

  it('does not persist a welcome-only thread over a real conversation', () => {
    expect(shouldPersistChat([msg('system', 'Welcome')])).toBe(false);
    expect(hasUserTurn([msg('user', 'Hi')])).toBe(true);
    expect(displayJobPrompt('Hi\n\nApproved plan:\n{}')).toBe('Hi');
  });
});
