import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { proxy } from '../../proxy';
import { MUTATING_ROUTE_POLICIES, gatePattern } from '../../lib/auth/route-policy';

/**
 * The authorization matrix, driven for real.
 *
 * Every cell below imports the route handler, gives it a session, and reads the
 * status the handler actually returns. Statuses are written by hand in this
 * file, never derived from `policy.allow`, so a stale helper cannot paper over
 * a real handler.
 *
 * Two things are checked per cell:
 *
 *   1. the status, against a table written by hand in this file (never derived
 *      from the policy list), and
 *   2. whether the route's first post-gate step ran at all. A gate that is
 *      called but whose result is dropped returns 200 *and* does the work; a
 *      gate that is honoured does neither. Only the second signal can tell
 *      those apart, which is why the source-text check further down cannot.
 *
 * Anonymous is driven twice: through the real `proxy`, which is what stops it
 * in production, and through the handler with no session, because the route
 * layer is defence in depth and must reject on its own.
 */

const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
const dbMock = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userCreate: vi.fn(),
  projectFindFirst: vi.fn(),
  projectUpdate: vi.fn(),
  projectPlanFindFirst: vi.fn(),
  projectCreate: vi.fn(),
}));
const plansMock = vi.hoisted(() => ({
  createPlan: vi.fn(),
  updatePlan: vi.fn(),
  listPlans: vi.fn(),
  assignDefaultWorkspacePlan: vi.fn(),
  getWorkspaceAdminSettings: vi.fn(),
  updateWorkspaceAdminSettings: vi.fn(),
  getCreditMeter: vi.fn(),
  getUsageBreakdown: vi.fn(),
}));
const jobsAdminMock = vi.hoisted(() => ({ getJobsAdmin: vi.fn(), adminAbandonJob: vi.fn() }));

vi.mock('@/auth', () => ({
  auth: authMock.auth,
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
  unstable_update: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    // `writeAudit` runs on the admin success paths and swallows its own
    // failures; stubbing the raw-SQL entry points keeps that from printing an
    // error that has nothing to do with authorization. The query stubs answer
    // with an empty row set rather than `undefined`, because that is what Prisma
    // returns and callers are entitled to index into it.
    $executeRaw: vi.fn(async () => 0),
    $executeRawUnsafe: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => []),
    $queryRawUnsafe: vi.fn(async () => []),
    user: { findUnique: dbMock.userFindUnique, create: dbMock.userCreate },
    project: {
      findFirst: dbMock.projectFindFirst,
      update: dbMock.projectUpdate,
      create: dbMock.projectCreate,
    },
    projectPlan: { findFirst: dbMock.projectPlanFindFirst },
  },
}));

// Post-gate work for the three admin routes that would otherwise need a
// database. These modules hold no gate of their own — the gate is `requireAdmin`
// in the route — so replacing them leaves the thing under test intact.
vi.mock('@/lib/plans/actions', () => plansMock);
vi.mock('@/lib/jobs/admin', () => jobsAdminMock);

const { peekActor } = await import('@/lib/projects/plan');

type Actor = 'anonymous' | 'member' | 'member_deactivated' | 'admin' | 'other_member';

const ACTORS: Actor[] = ['anonymous', 'member', 'member_deactivated', 'admin', 'other_member'];

const OWNER_ID = 'u-member';
const PROJECT_ID = 'p-matrix';
const TAKEN_EMAIL = 'already-a-member@example.com';

const USERS = {
  'u-member': {
    id: OWNER_ID,
    email: 'member@example.com',
    name: 'Member',
    role: 'MEMBER' as const,
    avatarUrl: null,
    isActive: true,
  },
  'u-other': {
    id: 'u-other',
    email: 'other@example.com',
    name: 'Other',
    role: 'MEMBER' as const,
    avatarUrl: null,
    isActive: true,
  },
  'u-admin': {
    id: 'u-admin',
    email: 'admin@example.com',
    name: 'Admin',
    role: 'ADMIN' as const,
    avatarUrl: null,
    isActive: true,
  },
  'u-inactive': {
    id: 'u-inactive',
    email: 'gone@example.com',
    name: 'Gone',
    role: 'MEMBER' as const,
    avatarUrl: null,
    isActive: false,
  },
};

const SESSION_USER_ID: Record<Exclude<Actor, 'anonymous'>, keyof typeof USERS> = {
  member: 'u-member',
  member_deactivated: 'u-inactive',
  admin: 'u-admin',
  other_member: 'u-other',
};

/** Emails looked up by a route, as opposed to the session re-read by the gate. */
let emailLookups: string[] = [];

function setActor(actor: Actor) {
  if (actor === 'anonymous') {
    authMock.auth.mockResolvedValue(null);
    return;
  }
  const id = USERS[SESSION_USER_ID[actor]].id;
  // A signed cookie carries an id and nothing trustworthy beyond it.
  authMock.auth.mockResolvedValue({ user: { id } });
}

/**
 * The target project exists and belongs to `u-member` only for the non-owning
 * member, which is the cell where the ownership branch is the thing under test.
 * Every other actor gets "no such project", which lands past the session gate
 * without needing the rest of the write path mocked.
 */
function setProjectFixture(actor: Actor) {
  if (actor === 'other_member') {
    dbMock.projectFindFirst.mockResolvedValue({
      id: PROJECT_ID,
      ownerId: OWNER_ID,
      phase: 'PLANNING',
      initialPrompt: 'matrix fixture',
      importSource: null,
      stack: 'NEXTJS',
      designDirection: 'minimal',
    });
    return;
  }
  dbMock.projectFindFirst.mockResolvedValue(null);
}

beforeEach(() => {
  vi.clearAllMocks();
  emailLookups = [];

  dbMock.userFindUnique.mockImplementation(
    async (args: { where?: { id?: string; email?: string } }) => {
      const email = args?.where?.email;
      if (typeof email === 'string') {
        emailLookups.push(email);
        if (email === TAKEN_EMAIL) return USERS['u-member'];
        return null;
      }
      const id = args?.where?.id;
      if (typeof id !== 'string') return null;
      return id in USERS ? USERS[id as keyof typeof USERS] : null;
    },
  );
  dbMock.projectFindFirst.mockResolvedValue(null);
  plansMock.createPlan.mockResolvedValue({ ok: true, data: { id: 'plan-1', key: 'k' } });
  plansMock.updateWorkspaceAdminSettings.mockResolvedValue({ ok: true, data: { paused: false } });
  jobsAdminMock.adminAbandonJob.mockResolvedValue({ ok: true });
});

type Outcome = { status: number; error: string | null; work: number };

type Route = {
  key: string;
  /** As written in `MUTATING_ROUTE_POLICIES`, so the two lists can be compared. */
  path: string;
  method: string;
  /** Calls the handler for one actor. */
  call: (actor: Actor) => Promise<Response>;
  /** How many times the first post-gate step ran. */
  work: () => number;
  /** What that step is, for the failure message. */
  workLabel: string;
};

function request(path: string, method: string, body?: unknown) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function readError(response: Response): Promise<string | null> {
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) return null;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  if (!body || typeof body !== 'object') return null;
  const value = (body as { error?: unknown }).error;
  if (typeof value === 'string') return value;
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { message?: unknown }).message === 'string'
  ) {
    return String((value as { message: string }).message);
  }
  return null;
}

const ROUTES: Route[] = [
  {
    key: 'POST /api/admin/invite',
    path: '/api/admin/invite',
    method: 'POST',
    call: async (actor) => {
      setActor(actor);
      const { POST } = await import('@/app/api/admin/invite/route');
      return POST(request('/api/admin/invite', 'POST', { email: TAKEN_EMAIL, role: 'MEMBER' }));
    },
    work: () => emailLookups.filter((email) => email === TAKEN_EMAIL).length,
    workLabel: 'the invite email lookup',
  },
  {
    key: 'PATCH /api/admin/workspace',
    path: '/api/admin/workspace',
    method: 'PATCH',
    call: async (actor) => {
      setActor(actor);
      const { PATCH } = await import('@/app/api/admin/workspace/route');
      return PATCH(request('/api/admin/workspace', 'PATCH', { generationPaused: true }));
    },
    work: () => plansMock.updateWorkspaceAdminSettings.mock.calls.length,
    workLabel: 'updateWorkspaceAdminSettings',
  },
  {
    key: 'POST /api/admin/plans',
    path: '/api/admin/plans',
    method: 'POST',
    call: async (actor) => {
      setActor(actor);
      const { POST } = await import('@/app/api/admin/plans/route');
      return POST(request('/api/admin/plans', 'POST', { key: 'pro', name: 'Pro' }));
    },
    work: () => plansMock.createPlan.mock.calls.length,
    workLabel: 'createPlan',
  },
  {
    key: 'POST /api/admin/jobs/[id]/abandon',
    path: '/api/admin/jobs/[id]/abandon',
    method: 'POST',
    call: async (actor) => {
      setActor(actor);
      const { POST } = await import('@/app/api/admin/jobs/[id]/abandon/route');
      return POST(request('/api/admin/jobs/j-1/abandon', 'POST'), params('j-1'));
    },
    work: () => jobsAdminMock.adminAbandonJob.mock.calls.length,
    workLabel: 'adminAbandonJob',
  },
  {
    key: 'POST /api/projects',
    path: '/api/projects',
    method: 'POST',
    call: async (actor) => {
      setActor(actor);
      const { POST } = await import('@/app/api/projects/route');
      // Empty body: an authorized caller stops at input validation, which is
      // past the gate and short of the insert.
      return POST(request('/api/projects', 'POST', {}));
    },
    work: () => dbMock.projectCreate.mock.calls.length,
    workLabel: 'the project insert',
  },
  {
    key: 'DELETE /api/projects/[id]',
    path: '/api/projects/[id]',
    method: 'DELETE',
    call: async (actor) => {
      setActor(actor);
      setProjectFixture(actor);
      const { DELETE } = await import('@/app/api/projects/[id]/route');
      return DELETE(request(`/api/projects/${PROJECT_ID}`, 'DELETE'), params(PROJECT_ID));
    },
    work: () => dbMock.projectFindFirst.mock.calls.length,
    workLabel: 'the target project lookup',
  },
  {
    key: 'POST /api/projects/[id]/publish',
    path: '/api/projects/[id]/publish',
    method: 'POST',
    call: async (actor) => {
      setActor(actor);
      setProjectFixture(actor);
      const { POST } = await import('@/app/api/projects/[id]/publish/route');
      return POST(
        request(`/api/projects/${PROJECT_ID}/publish`, 'POST', { kind: 'PREVIEW' }),
        params(PROJECT_ID),
      );
    },
    work: () => dbMock.projectFindFirst.mock.calls.length,
    workLabel: 'the target project lookup',
  },
  {
    key: 'POST /api/projects/[id]/import',
    path: '/api/projects/[id]/import',
    method: 'POST',
    call: async (actor) => {
      setActor(actor);
      setProjectFixture(actor);
      const { POST } = await import('@/app/api/projects/[id]/import/route');
      return POST(
        request(`/api/projects/${PROJECT_ID}/import`, 'POST', { sourceUrl: 'https://example.com' }),
        params(PROJECT_ID),
      );
    },
    work: () => dbMock.projectFindFirst.mock.calls.length,
    workLabel: 'the target project lookup',
  },
  {
    key: 'POST /api/projects/[id]/plan/approve',
    path: '/api/projects/[id]/plan/approve',
    method: 'POST',
    call: async (actor) => {
      setActor(actor);
      setProjectFixture(actor);
      const { POST } = await import('@/app/api/projects/[id]/plan/approve/route');
      return POST(
        request(`/api/projects/${PROJECT_ID}/plan/approve`, 'POST', {}),
        params(PROJECT_ID),
      );
    },
    work: () => dbMock.projectFindFirst.mock.calls.length,
    workLabel: 'the target project lookup',
  },
  {
    key: 'POST /api/auth/forgot-password',
    path: '/api/auth/forgot-password',
    method: 'POST',
    call: async (actor) => {
      setActor(actor);
      const { POST } = await import('@/app/api/auth/forgot-password/route');
      // A distinct address per actor: the in-memory rate limiter would
      // otherwise skip the lookup from the fourth call on.
      return POST(
        request('/api/auth/forgot-password', 'POST', { email: `forgot-${actor}@example.com` }),
      );
    },
    work: () => emailLookups.filter((email) => email.startsWith('forgot-')).length,
    workLabel: 'the password-reset email lookup',
  },
];

type Expectation = { status: number; work: boolean; error?: string };

/**
 * Hand-written, one row per route × actor. Nothing here is derived from
 * `MUTATING_ROUTE_POLICIES`; the two are cross-checked below instead.
 *
 * Statuses past the gate differ per route because each stops at its own first
 * real step — 400 on invalid input, 404 on a project that does not exist, 409
 * on an email already taken. What matters is that they are neither 401 nor 403,
 * and that the post-gate work either ran or did not.
 */
const MATRIX: Record<string, Record<Actor, Expectation>> = {
  'POST /api/admin/invite': {
    anonymous: { status: 401, work: false, error: 'Sign in required' },
    member: { status: 403, work: false, error: 'Admin access required' },
    member_deactivated: { status: 401, work: false, error: 'Sign in required' },
    admin: { status: 409, work: true },
    other_member: { status: 403, work: false, error: 'Admin access required' },
  },
  'PATCH /api/admin/workspace': {
    anonymous: { status: 401, work: false, error: 'Sign in required' },
    member: { status: 403, work: false, error: 'Admin access required' },
    member_deactivated: { status: 401, work: false, error: 'Sign in required' },
    admin: { status: 200, work: true },
    other_member: { status: 403, work: false, error: 'Admin access required' },
  },
  'POST /api/admin/plans': {
    anonymous: { status: 401, work: false, error: 'Sign in required' },
    member: { status: 403, work: false, error: 'Admin access required' },
    member_deactivated: { status: 401, work: false, error: 'Sign in required' },
    admin: { status: 200, work: true },
    other_member: { status: 403, work: false, error: 'Admin access required' },
  },
  'POST /api/admin/jobs/[id]/abandon': {
    anonymous: { status: 401, work: false, error: 'Sign in required' },
    member: { status: 403, work: false, error: 'Admin access required' },
    member_deactivated: { status: 401, work: false, error: 'Sign in required' },
    admin: { status: 200, work: true },
    other_member: { status: 403, work: false, error: 'Admin access required' },
  },
  // Creating a project needs no target, so "non-owning member" is not a
  // meaningful actor here: every active member may create one. The gate
  // passes; 400 is validation (no prompt), not 403.
  'POST /api/projects': {
    anonymous: { status: 401, work: false, error: 'Sign in required' },
    member: { status: 400, work: false, error: 'Validation failed' },
    member_deactivated: { status: 401, work: false, error: 'Sign in required' },
    admin: { status: 400, work: false, error: 'Validation failed' },
    other_member: { status: 400, work: false, error: 'Validation failed' },
  },
  'DELETE /api/projects/[id]': {
    anonymous: { status: 401, work: false, error: 'Sign in required' },
    member: { status: 404, work: true, error: 'Project not found' },
    member_deactivated: { status: 401, work: false, error: 'Sign in required' },
    admin: { status: 404, work: true, error: 'Project not found' },
    other_member: { status: 403, work: true, error: 'Forbidden' },
  },
  'POST /api/projects/[id]/publish': {
    anonymous: { status: 401, work: false, error: 'Sign in required' },
    member: { status: 404, work: true, error: 'Project not found' },
    member_deactivated: { status: 401, work: false, error: 'Sign in required' },
    admin: { status: 404, work: true, error: 'Project not found' },
    other_member: { status: 403, work: true, error: 'Forbidden' },
  },
  'POST /api/projects/[id]/import': {
    anonymous: { status: 401, work: false, error: 'Sign in required' },
    member: { status: 404, work: true, error: 'Project not found' },
    member_deactivated: { status: 401, work: false, error: 'Sign in required' },
    admin: { status: 404, work: true, error: 'Project not found' },
    other_member: { status: 403, work: true, error: 'Forbidden' },
  },
  'POST /api/projects/[id]/plan/approve': {
    anonymous: { status: 401, work: false, error: 'Sign in required' },
    member: { status: 404, work: true, error: 'Project not found' },
    member_deactivated: { status: 401, work: false, error: 'Sign in required' },
    admin: { status: 404, work: true, error: 'Project not found' },
    other_member: { status: 403, work: true, error: 'Forbidden' },
  },
  // Public by design: a locked-out user has to be able to ask for a reset, so
  // the work must run for every actor including anonymous.
  'POST /api/auth/forgot-password': {
    anonymous: { status: 200, work: true },
    member: { status: 200, work: true },
    member_deactivated: { status: 200, work: true },
    admin: { status: 200, work: true },
    other_member: { status: 200, work: true },
  },
};

async function drive(route: Route, actor: Actor): Promise<Outcome> {
  const response = await route.call(actor);
  return { status: response.status, error: await readError(response), work: route.work() };
}

describe('authorization matrix harness', () => {
  it('has one hand-written expectation per route and actor', () => {
    // The old version asserted `rows.length === routes × actors` on rows built
    // by a nested loop over those two arrays. This instead checks the
    // hand-written table for holes, which is a claim about a different object
    // than the loop that consumes it.
    const keys = ROUTES.map((route) => route.key);
    expect(Object.keys(MATRIX).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      expect(Object.keys(MATRIX[key]).sort(), key).toEqual([...ACTORS].sort());
    }
    expect(ROUTES.length).toBe(MUTATING_ROUTE_POLICIES.length);
    expect(ACTORS.length).toBe(5);
  });

  it('drives every route named in the policy list', () => {
    // If a mutating route is added to the policy list and not here, the matrix
    // would quietly stop covering it.
    const driven = new Set(ROUTES.map((route) => `${route.method} ${route.path}`));
    const missing = MUTATING_ROUTE_POLICIES.filter(
      (policy) => !driven.has(`${policy.method} ${policy.path}`),
    ).map((policy) => `${policy.method} ${policy.path}`);
    expect(missing).toEqual([]);
  });

  it('runs with an empty actor store, so the session gate is the gate under test', () => {
    // `createProject` and `approvePlan` accept an actor from an AsyncLocalStorage
    // seam before consulting the session. If that store were populated here the
    // cells below would prove nothing.
    expect(peekActor()).toBeUndefined();
  });
});

describe('mutating routes: actual status per actor', () => {
  for (const route of ROUTES) {
    for (const actor of ACTORS) {
      const expected = MATRIX[route.key][actor];
      it(`${route.key} — ${actor} → ${expected.status}`, async () => {
        const outcome = await drive(route, actor);
        expect(outcome.status, `${route.key} as ${actor}`).toBe(expected.status);
        if (expected.error !== undefined) {
          expect(outcome.error, `${route.key} as ${actor}`).toBe(expected.error);
        }
        if (expected.work) {
          expect(
            outcome.work,
            `${route.key}: ${route.workLabel} must run for ${actor}`,
          ).toBeGreaterThan(0);
        } else {
          expect(outcome.work, `${route.key}: ${route.workLabel} must not run for ${actor}`).toBe(
            0,
          );
        }
      });
    }
  }
});

describe('anonymous is stopped by the proxy as well as the handler', () => {
  for (const route of ROUTES) {
    const expectedFromProxy = route.path === '/api/auth/forgot-password' ? null : 401;
    it(`${route.key} — no cookie${expectedFromProxy ? ' → 401 at the gate' : ' is allowlisted'}`, async () => {
      const path = route.path.replace('[id]', 'x-1');
      const response = await proxy(
        new NextRequest(`http://localhost:3000${path}`, { method: route.method }),
      );
      if (expectedFromProxy === null) {
        expect(response.status).not.toBe(401);
      } else {
        expect(response.status).toBe(401);
        expect(response.headers.get('location')).toBeNull();
      }
    });
  }
});

describe('the matrix would catch a gate whose result is dropped', () => {
  /**
   * The control. `requireAdmin()` appears in both handlers below, so the
   * source-text check further down passes for both. Only the status and the
   * work counter separate them, which is the whole argument for driving the
   * routes instead of reading them.
   */
  function problems(outcome: Outcome) {
    const found: string[] = [];
    if (outcome.status !== 403) found.push(`status ${outcome.status}, expected 403`);
    if (outcome.work !== 0) found.push(`work ran ${outcome.work} time(s)`);
    return found;
  }

  it('passes an honest handler and fails one that ignores the gate', async () => {
    const { requireAdmin } = await import('@/lib/auth');
    setActor('member');

    const honestWork = vi.fn();
    const honest = async () => {
      const { user, error, status } = await requireAdmin();
      if (!user) return NextResponse.json({ error }, { status });
      honestWork();
      return NextResponse.json({ ok: true });
    };
    const honestOutcome: Outcome = {
      status: (await honest()).status,
      error: null,
      work: honestWork.mock.calls.length,
    };
    expect(problems(honestOutcome)).toEqual([]);

    const droppedWork = vi.fn();
    const dropped = async () => {
      await requireAdmin();
      droppedWork();
      return NextResponse.json({ ok: true });
    };
    const droppedOutcome: Outcome = {
      status: (await dropped()).status,
      error: null,
      work: droppedWork.mock.calls.length,
    };
    expect(problems(droppedOutcome)).toEqual(['status 200, expected 403', 'work ran 1 time(s)']);
  });
});

describe('gate names in source', () => {
  it('text-presence tripwire: every mutating route still mentions its gate', () => {
    // Deliberately weak, and titled to say so. A `requireAdmin(` anywhere in
    // the file satisfies this, including in a comment or with its result
    // thrown away — the control above shows what that looks like. It is kept
    // because it is the only check that follows `gateFile`, where the gate
    // lives one module away from the route.
    for (const policy of MUTATING_ROUTE_POLICIES) {
      const file = resolve(process.cwd(), policy.gateFile ?? policy.file);
      const source = readFileSync(file, 'utf8');
      const pattern = gatePattern(policy.gate);
      if (!pattern) continue;
      expect(
        source,
        `${policy.path} lost ${policy.gate} in ${policy.gateFile ?? policy.file}`,
      ).toMatch(pattern);
    }
  });
});
