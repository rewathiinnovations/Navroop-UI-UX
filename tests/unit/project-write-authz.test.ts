/**
 * Ownership on the two mutating routes that had none (F-313).
 *
 * Both were found by making `tests/unit/server-action-authz.test.ts` mechanical
 * and then applying the same enumeration to `app/api/**`: they are the route-side
 * instances of the N-009 shape — a session gate, a project id taken from the
 * request, and no comparison against the project's owner.
 *
 *   POST /api/generate-ai-code-stream   spends workspace credits, takes the
 *                                       owner's project lock and settles
 *                                       generated code onto the project.
 *   POST /api/projects/[id]/quality-signals  writes a QualitySignal row that
 *                                       feeds /admin/quality.
 *
 * The product's decision is already on record one module away:
 * `persistProjectGeneration` (lib/projects/actions.ts) refuses a non-owner with
 * 403 precisely so a member cannot replace another member's `lastCode`. These
 * two routes reached the same state without asking.
 *
 * Driven, not read: the handler is invoked as an owner, a non-owner MEMBER and a
 * non-owner ADMIN, and the post-gate work is counted. A gate whose result is
 * dropped returns 200 *and* does the work, which a source-text check cannot see.
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as generateStream } from '@/app/api/generate-ai-code-stream/route';
import { POST as qualitySignals } from '@/app/api/projects/[id]/quality-signals/route';

type Actor = { id: string; email: string; name: string; role: 'ADMIN' | 'MEMBER' } | null;

const session = vi.hoisted(() => ({ user: null as Actor }));

const work = vi.hoisted(() => ({
  recordThumbs: 0,
  generationSubmitChecked: 0,
}));

const OWNER_ID = 'owner-1';
const PROJECT_ID = 'proj-1';

const OWNER: Actor = {
  id: OWNER_ID,
  email: 'owner@navroop.invalid',
  name: 'Owner',
  role: 'MEMBER',
};
const OTHER_MEMBER: Actor = {
  id: 'member-2',
  email: 'member2@navroop.invalid',
  name: 'Other Member',
  role: 'MEMBER',
};
const OTHER_ADMIN: Actor = {
  id: 'admin-1',
  email: 'admin@navroop.invalid',
  name: 'Admin',
  role: 'ADMIN',
};

vi.mock('@/lib/auth', () => ({
  getSessionUser: async () => session.user,
  requireSessionUser: async () =>
    session.user
      ? { user: session.user, error: null, status: 200 }
      : { user: null, error: 'Sign in required', status: 401 },
  requireAdmin: async () => ({ user: null, error: 'Admin access required', status: 403 }),
  toPublicUser: (user: Actor) => user,
  auth: async () => null,
  signIn: vi.fn(),
  signOut: vi.fn(),
  validateEmail: () => true,
}));

vi.mock('@/auth', () => ({
  auth: async () => null,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
  unstable_update: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    project: {
      findFirst: async () => ({ id: PROJECT_ID, ownerId: OWNER_ID, deletedAt: null }),
    },
  },
}));

// The first post-gate step of the quality-signals route. Counting it is what
// separates an honoured gate from one whose result is thrown away.
vi.mock('@/lib/signals/collect', () => ({
  recordThumbs: async () => {
    work.recordThumbs += 1;
    return { id: 'signal-1', kind: 'thumbs', value: 1 };
  },
}));

// The first post-gate step of the generation route. The real limiter is keyed on
// the member and would otherwise leak state between cases.
vi.mock('@/lib/generation/submit-rate-limit', () => ({
  GENERATION_RATE_LIMIT_MESSAGE: 'Too many generations',
  allowGenerationSubmit: () => {
    work.generationSubmitChecked += 1;
    return { allowed: false };
  },
}));

const REQUEST_INIT = {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
} as const;

beforeEach(() => {
  session.user = null;
  work.recordThumbs = 0;
  work.generationSubmitChecked = 0;
});

describe('POST /api/projects/[id]/quality-signals is owner-scoped', () => {
  const call = () =>
    qualitySignals(
      new NextRequest('http://localhost:3000/api/projects/proj-1/quality-signals', {
        ...REQUEST_INIT,
        body: JSON.stringify({ kind: 'thumbs', rating: 'up' }),
      }),
      { params: Promise.resolve({ id: PROJECT_ID }) },
    );

  it('refuses a signed-out caller with 401 and records nothing', async () => {
    const response = await call();
    expect(response.status).toBe(401);
    expect(work.recordThumbs).toBe(0);
  });

  it('refuses a MEMBER who does not own the project with 403 and records nothing', async () => {
    session.user = OTHER_MEMBER;
    const response = await call();
    expect(response.status).toBe(403);
    expect(work.recordThumbs).toBe(0);
  });

  it('accepts the owner', async () => {
    session.user = OWNER;
    const response = await call();
    expect(response.status).toBe(200);
    expect(work.recordThumbs).toBe(1);
  });

  it('accepts an ADMIN who does not own the project', async () => {
    session.user = OTHER_ADMIN;
    const response = await call();
    expect(response.status).toBe(200);
    expect(work.recordThumbs).toBe(1);
  });
});

describe('POST /api/generate-ai-code-stream is owner-scoped', () => {
  const call = () =>
    generateStream(
      new NextRequest('http://localhost:3000/api/generate-ai-code-stream', {
        ...REQUEST_INIT,
        body: JSON.stringify({
          prompt: 'Add a pricing section to the landing page',
          projectId: PROJECT_ID,
        }),
      }),
    );

  it('refuses a signed-out caller with 401 before the rate limiter', async () => {
    const response = await call();
    expect(response.status).toBe(401);
    expect(work.generationSubmitChecked).toBe(0);
  });

  it('refuses a MEMBER who does not own the project with 403, before spending anything', async () => {
    // The ownership check must precede the rate limiter, the credit check and
    // the project lock: a refusal that has already charged the workspace or
    // taken the owner's lock is not a refusal.
    session.user = OTHER_MEMBER;
    const response = await call();
    expect(response.status).toBe(403);
    expect(work.generationSubmitChecked).toBe(0);
  });

  it('lets the owner past the ownership check (stopped later by the mocked rate limiter)', async () => {
    // 429 is the positive control: it proves the gate passed and the handler
    // carried on, rather than the mocks refusing everyone.
    session.user = OWNER;
    const response = await call();
    expect(response.status).toBe(429);
    expect(work.generationSubmitChecked).toBe(1);
  });

  it('lets an ADMIN who does not own the project past the ownership check', async () => {
    session.user = OTHER_ADMIN;
    const response = await call();
    expect(response.status).toBe(429);
    expect(work.generationSubmitChecked).toBe(1);
  });
});
