/**
 * F-101: checkpoint labels came from `globalThis.conversationState`, a process-wide slot
 * overwritten by whichever project generated last — a checkpoint saved for project A could
 * be named after another user's project-B prompt, and unlike memory extraction there is no
 * approval gate: version history, the header version pills and the chat CheckpointCard all
 * render the label immediately. The label may only come from the project's own keyed
 * conversation, else fall back to 'Latest generation'.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessage } from '@/types/conversation';

const db = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  projectUpdate: vi.fn(),
  checkpointFindFirst: vi.fn(),
  checkpointCreate: vi.fn(),
  checkpointUpdate: vi.fn(),
  checkpointDelete: vi.fn(),
  checkpointFindUniqueOrThrow: vi.fn(),
  planFindFirst: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findFirst: db.projectFindFirst, update: db.projectUpdate },
    checkpoint: {
      findFirst: db.checkpointFindFirst,
      create: db.checkpointCreate,
      update: db.checkpointUpdate,
      delete: db.checkpointDelete,
      findUniqueOrThrow: db.checkpointFindUniqueOrThrow,
    },
    projectPlan: { findFirst: db.planFindFirst },
  },
}));

// `peekActor` supplies the actor; next-auth cannot resolve `next/server` outside
// the Next runtime, which is why the sibling checkpoint suites stub both.
vi.mock('@/lib/projects/plan', () => ({
  peekActor: () => ({ id: 'u-owner', email: 'o@example.com', name: 'Owner', role: 'MEMBER' }),
}));
vi.mock('@/lib/auth', () => ({ getSessionUser: async () => null }));

const snapshot = vi.hoisted(() => ({ capture: vi.fn(), equal: vi.fn(() => false) }));
vi.mock('@/lib/checkpoints/snapshot', () => ({
  captureFileSnapshot: snapshot.capture,
  snapshotsEqual: snapshot.equal,
  readSnapshot: vi.fn(async () => []),
  writeSnapshot: vi.fn(async () => ({
    snapshotKey: 'k',
    snapshotBytes: 16,
    snapshotFileCount: 1,
  })),
  asFileSnapshot: (value: unknown) => value,
  SnapshotReadError: class SnapshotReadError extends Error {},
}));
vi.mock('@/lib/plans/limits', () => ({ checkLimit: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/lib/storage/usage', () => ({
  adjustStorageBytes: vi.fn(async () => undefined),
  WORKSPACE_ROW_ID: 'workspace',
}));

// Dynamic so every vi.mock above registers before the module graph is evaluated.
const { createCheckpointAfterGeneration } = await import('@/lib/checkpoints/actions');
const { conversationStateFor, resetConversationStates } =
  await import('@/lib/generation/conversation-state');

type GlobalWithLegacySlot = typeof globalThis & {
  conversationState?: { context: { messages: ConversationMessage[] } };
};

function userMessage(content: string): ConversationMessage {
  return { id: `msg-${content}`, role: 'user', content, timestamp: Date.now() };
}

function createdCheckpointData() {
  const call = db.checkpointCreate.mock.calls[0]?.[0] as
    { data?: { label?: string; sourceMessage?: string | null } } | undefined;
  return call?.data ?? {};
}

beforeEach(() => {
  vi.clearAllMocks();
  snapshot.equal.mockReturnValue(false);
  snapshot.capture.mockResolvedValue([{ path: 'app/page.tsx', content: 'x' }]);
  db.checkpointFindFirst.mockResolvedValue(null);
  db.planFindFirst.mockResolvedValue(null);
  db.projectFindFirst.mockResolvedValue({ initialPrompt: 'build it' });
  db.checkpointCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'cp-1',
    createdAt: new Date(),
    ...data,
  }));
  db.checkpointUpdate.mockResolvedValue({});
  db.checkpointFindUniqueOrThrow.mockResolvedValue({
    id: 'cp-1',
    label: 'x',
    createdAt: new Date(),
  });
});

afterEach(() => {
  resetConversationStates();
  delete (globalThis as GlobalWithLegacySlot).conversationState;
});

describe('checkpoint labels come from the project\u2019s own conversation', () => {
  it('names the checkpoint from this project\u2019s prompt, not whichever published last', async () => {
    conversationStateFor('proj-a', 'user-a').context.messages.push(
      userMessage('give project A a dark navbar'),
    );
    // Another project's generation published last. Writing the legacy unkeyed slot must
    // change nothing — it used to be exactly what the label was read from.
    (globalThis as GlobalWithLegacySlot).conversationState = {
      context: { messages: [userMessage('B-SECRET rebuild project B pricing page')] },
    };

    await createCheckpointAfterGeneration('proj-a', { previousPhase: 'COMPLETE' });

    expect(db.checkpointCreate).toHaveBeenCalledTimes(1);
    const data = createdCheckpointData();
    expect(data.label).toBe('give project A a dark navbar');
    expect(data.sourceMessage).toBe('give project A a dark navbar');
  });

  it('falls back to \u2018Latest generation\u2019 when this project has no remembered conversation', async () => {
    (globalThis as GlobalWithLegacySlot).conversationState = {
      context: { messages: [userMessage('B-SECRET rebuild project B pricing page')] },
    };

    await createCheckpointAfterGeneration('proj-a', { previousPhase: 'COMPLETE' });

    expect(db.checkpointCreate).toHaveBeenCalledTimes(1);
    const data = createdCheckpointData();
    expect(data.label).toBe('Latest generation');
    expect(data.sourceMessage).toBeNull();
  });
});
