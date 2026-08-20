/**
 * F-303: /api/conversation-state operated on one process-global shared by every
 * signed-in user — any member's GET read whoever's context was loaded, and any member's
 * `reset` / `clear-old` / DELETE destroyed it. The route is now clear-only and keyed:
 * a mount trims exactly the caller's own project (or the caller's unsaved-run bucket),
 * gated owner-or-ADMIN like every other project mutation.
 */
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@/lib/auth';

const auth = vi.hoisted(() => ({
  user: null as SessionUser | null,
}));
vi.mock('@/lib/auth', () => ({
  requireSessionUser: async () =>
    auth.user
      ? { user: auth.user, error: null, status: 200 }
      : { user: null, error: 'Sign in required', status: 401 },
}));

const db = vi.hoisted(() => ({ projectFindFirst: vi.fn() }));
vi.mock('@/lib/db', () => ({
  prisma: { project: { findFirst: db.projectFindFirst } },
}));

// Dynamic so every vi.mock above registers before the module graph is evaluated.
const { POST } = await import('@/app/api/conversation-state/route');
const { conversationStateFor, resetConversationStates } =
  await import('@/lib/generation/conversation-state');

const OWNER: SessionUser = {
  id: 'u-owner',
  email: 'owner@example.com',
  name: 'Owner',
  role: 'MEMBER',
  avatarUrl: null,
};
const OTHER: SessionUser = {
  id: 'u-other',
  email: 'other@example.com',
  name: 'Other',
  role: 'MEMBER',
  avatarUrl: null,
};

function clearOldRequest(body: unknown) {
  return new NextRequest('http://localhost/api/conversation-state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function seedMessages(projectId: string | null, userId: string, count: number) {
  const state = conversationStateFor(projectId, userId);
  for (let index = 0; index < count; index += 1) {
    state.context.messages.push({
      id: `msg-${projectId ?? userId}-${index}`,
      role: 'user',
      content: `message ${index}`,
      timestamp: Date.now(),
    });
  }
  return state;
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.user = OWNER;
  db.projectFindFirst.mockResolvedValue({ ownerId: OWNER.id });
});

afterEach(() => {
  resetConversationStates();
});

describe('clear-old trims only the caller\u2019s own key', () => {
  it('trims the named project and touches nothing else', async () => {
    const mine = seedMessages('proj-a', OWNER.id, 8);
    const theirs = seedMessages('proj-b', OTHER.id, 8);

    const response = await POST(clearOldRequest({ action: 'clear-old', projectId: 'proj-a' }));

    expect(response.status).toBe(200);
    expect(mine.context.messages).toHaveLength(5);
    expect(theirs.context.messages).toHaveLength(8);
  });

  it('refuses to trim someone else\u2019s project', async () => {
    const theirs = seedMessages('proj-b', OTHER.id, 8);
    db.projectFindFirst.mockResolvedValue({ ownerId: OTHER.id });

    const response = await POST(clearOldRequest({ action: 'clear-old', projectId: 'proj-b' }));

    expect(response.status).toBe(403);
    expect(theirs.context.messages).toHaveLength(8);
  });

  it('answers 404 for a project that does not exist and trims nothing', async () => {
    const mine = seedMessages('proj-a', OWNER.id, 8);
    db.projectFindFirst.mockResolvedValue(null);

    const response = await POST(clearOldRequest({ action: 'clear-old', projectId: 'proj-gone' }));

    expect(response.status).toBe(404);
    expect(mine.context.messages).toHaveLength(8);
  });

  it('with no project, trims only the caller\u2019s unsaved-run bucket', async () => {
    const mine = seedMessages(null, OWNER.id, 8);
    const theirs = seedMessages(null, OTHER.id, 8);

    const response = await POST(clearOldRequest({ action: 'clear-old', projectId: null }));

    expect(response.status).toBe(200);
    expect(db.projectFindFirst).not.toHaveBeenCalled();
    expect(mine.context.messages).toHaveLength(5);
    expect(theirs.context.messages).toHaveLength(8);
  });

  it('rejects the retired verbs\u2019 actions', async () => {
    const response = await POST(clearOldRequest({ action: 'reset' }));
    expect(response.status).toBe(400);
  });

  it('requires a session', async () => {
    auth.user = null;
    const response = await POST(clearOldRequest({ action: 'clear-old', projectId: 'proj-a' }));
    expect(response.status).toBe(401);
  });
});
