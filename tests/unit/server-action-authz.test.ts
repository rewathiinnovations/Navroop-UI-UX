/**
 * Mechanical authorization sweep over every `'use server'` module (F-313, N-009).
 *
 * A Server Action POSTs to the page URL with a `Next-Action` header, so
 * `proxy.ts`'s deny-by-default `/api` gate never sees it: the role/ownership
 * check INSIDE each action is the only authorization on that path.
 *
 * The Wave 2 version of this file listed ten modules, and their admin-only and
 * owner-scoped exports, BY HAND. That is exactly how `toggleStar` shipped with a
 * session gate and no ownership gate and stayed green (N-009): the sweep
 * asserted 401 on every export it happened to import, and nobody had written
 * its name in the ownership list. A sweep enumerated by hand inherits its
 * author's blind spots.
 *
 * So the enumeration here is mechanical in three independent directions:
 *
 *  1. MODULES come from the filesystem. `discoverUseServerModules()` walks the
 *     source tree for the `'use server'` directive and `ACTION_AUTHZ`
 *     (`tests/support/action-authz-registry.ts`, shared with the route suite)
 *     must match that set exactly. A new action module fails this file until it
 *     is registered — and there were seven unregistered ones when this was
 *     written (`assets`, `domains`, `plans`, `profile`, `projects`, `publish`,
 *     `team`), which is the coverage half of F-313.
 *  2. EXPORTS come from the module object at runtime. Every function export must
 *     appear in its module's `exports` map, and every entry must name a real
 *     export. A new export fails this file until it is classified.
 *  3. The CLASSIFICATION cannot be waved through. An export that takes a
 *     `projectId` as its first parameter, or whose name reads as a mutation, may
 *     be classified `session` — session gate, no check on the target — only with
 *     a written `why`. That is the rule `toggleStar` would have failed.
 *
 * The classification is then proved by RUNNING the export, never by matching
 * source text: signed out, every gated export must answer 401 before touching
 * the database (the prisma stub throws on any unexpected access, so a gate that
 * runs after a query fails loudly); `admin` exports must answer 403 to a
 * signed-in MEMBER; `owner` exports must answer 403 to a MEMBER who does not own
 * the target row.
 *
 * The gates themselves live in `@/lib/auth` (`getSessionUser`,
 * `requireSessionUser`, `requireAdmin`); the mock below mirrors those helpers'
 * real semantics exactly (401 'Sign in required', 403 'Admin access required')
 * so what is exercised is each ACTION's use of them, not the helpers.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  ACTION_AUTHZ,
  DEFAULT_ACTION_ARGS,
  discoverUseServerModules,
  unjustifiedTargets,
} from '../support/action-authz-registry';

type TestSessionUser = {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'MEMBER';
  avatarUrl: string | null;
};

const session = vi.hoisted(() => ({ user: null as TestSessionUser | null }));

const db = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('@/lib/auth', () => {
  const getSessionUser = async () => session.user;
  const requireSessionUser = async () =>
    session.user
      ? { user: session.user, error: null, status: 200 as const }
      : { user: null, error: 'Sign in required' as const, status: 401 as const };
  const requireAdmin = async () => {
    const result = await requireSessionUser();
    if (!result.user) return result;
    if (result.user.role !== 'ADMIN') {
      return { user: null, error: 'Admin access required' as const, status: 403 as const };
    }
    return result;
  };
  const unreachable = (name: string) => () => {
    throw new Error(`${name} must not be reached by an authorization rejection`);
  };
  return {
    getSessionUser,
    requireSessionUser,
    requireAdmin,
    toPublicUser: (user: TestSessionUser) => user,
    auth: async () => null,
    signIn: unreachable('signIn'),
    signOut: unreachable('signOut'),
    hashPassword: unreachable('hashPassword'),
    verifyPassword: unreachable('verifyPassword'),
    validateEmail: () => true,
    getSeedAdminCredentials: unreachable('getSeedAdminCredentials'),
  };
});

// Every prisma access must be explicitly allowed by the test that needs it;
// anything else proves an action reached data before its gate fired.
vi.mock('@/lib/db', () => {
  const modelProxy = (model: string) =>
    new Proxy(function unexpectedModelCall() {}, {
      apply() {
        throw new Error(
          `unexpected prisma.${model}() — the authorization gate did not fire before data access`,
        );
      },
      get(_target, method) {
        if (typeof method !== 'string' || method === 'then') return undefined;
        return (...args: unknown[]) => {
          const key = `${model}.${method}`;
          const handler = db.handlers.get(key);
          if (!handler) {
            throw new Error(
              `unexpected prisma.${key} — the authorization gate did not fire before data access`,
            );
          }
          return Promise.resolve(handler(...args));
        };
      },
    });
  const prisma = new Proxy(
    {},
    {
      get(_target, model) {
        if (typeof model !== 'string' || model === 'then') return undefined;
        return modelProxy(model);
      },
    },
  );
  return { prisma };
});

// Only reached AFTER a gate passes; rejection paths never call these. Mocked so
// importing the modules under plain Node does not require a Next request scope.
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_noStore: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));

// `lib/profile/actions.ts` imports `unstable_update` from the NextAuth config.
// Loading that config pulls next-auth's own runtime, which cannot resolve
// `next/server` outside a Next build; the update is also post-gate, so it is
// never reached by a rejection.
vi.mock('@/auth', () => ({
  auth: async () => null,
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
  unstable_update: vi.fn(),
}));

import * as apiKeyActions from '@/lib/api-keys/actions';
import * as assetActions from '@/lib/assets/actions';
import * as auditActions from '@/lib/audit/actions';
import * as coolifyActions from '@/lib/coolify/actions';
import * as coolifyServerActions from '@/lib/coolify/server-actions';
import * as domainActions from '@/lib/domains/actions';
import * as githubActions from '@/lib/github/actions';
import * as memoryActions from '@/lib/memory/actions';
import * as planActions from '@/lib/plans/actions';
import * as profileActions from '@/lib/profile/actions';
import * as projectActions from '@/lib/projects/actions';
import * as publishActions from '@/lib/publish/actions';
import * as seoActions from '@/lib/seo/actions';
import * as skillActions from '@/lib/skills/actions';
import * as starActions from '@/lib/projects/stars';
import * as teamActions from '@/lib/team/actions';
import * as templateActions from '@/lib/templates/actions';

const MEMBER: TestSessionUser = {
  id: 'member-1',
  email: 'member@navroop.invalid',
  name: 'Member One',
  role: 'MEMBER',
  avatarUrl: null,
};

const ADMIN: TestSessionUser = {
  id: 'admin-1',
  email: 'admin@navroop.invalid',
  name: 'Admin One',
  role: 'ADMIN',
  avatarUrl: null,
};

type ActionModule = Record<string, unknown>;

/**
 * The runtime half of the registry: id → the real module object. The ids come
 * from `ACTION_AUTHZ`, so this map is where "a module is registered" becomes
 * "a module is actually loaded and called".
 */
const MODULE_OBJECTS: Record<string, ActionModule> = {
  'lib/api-keys/actions': apiKeyActions,
  'lib/assets/actions': assetActions,
  'lib/audit/actions': auditActions,
  'lib/coolify/actions': coolifyActions,
  'lib/coolify/server-actions': coolifyServerActions,
  'lib/domains/actions': domainActions,
  'lib/github/actions': githubActions,
  'lib/memory/actions': memoryActions,
  'lib/plans/actions': planActions,
  'lib/profile/actions': profileActions,
  'lib/projects/actions': projectActions,
  'lib/projects/stars': starActions,
  'lib/publish/actions': publishActions,
  'lib/seo/actions': seoActions,
  'lib/skills/actions': skillActions,
  'lib/team/actions': teamActions,
  'lib/templates/actions': templateActions,
};

/** Every function export the module object actually exposes. */
function actionExports(mod: ActionModule): Array<[string, (...args: unknown[]) => unknown]> {
  return Object.entries(mod).filter(
    (entry): entry is [string, (...args: unknown[]) => unknown] => typeof entry[1] === 'function',
  );
}

/* ------------------------------------------------------------------ fixtures */

/** Owned by nobody in this test, so `canMutate` must refuse MEMBER. */
const OTHERS_PROJECT = {
  id: 'proj-1',
  ownerId: 'owner-9',
  name: 'Someone else\u2019s project',
  initialPrompt: 'not yours',
  stack: 'nextjs',
  designDirection: 'modern',
  lastCode: null,
  previewUrl: null,
  phase: 'IDLE',
  deletedAt: null,
  plans: [],
};

const OTHERS_DEPLOYMENT = {
  id: 'deployment-1',
  slug: 'slug-1',
  kind: 'PREVIEW',
  projectId: 'proj-1',
  project: { ownerId: 'owner-9', deletedAt: null },
};

const OTHERS_MEMORY = {
  id: 'memory-1',
  scope: 'PROJECT',
  projectId: 'proj-1',
  category: 'design',
  content: 'not yours',
  source: 'manual',
  status: 'ACTIVE',
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

/**
 * Every lookup an owner-scoped export needs in order to REACH its ownership
 * comparison, and nothing else. A model that is not here throws, so an export
 * that mutates before comparing owners fails rather than passing.
 */
function allowOwnershipLookups() {
  db.handlers.set('project.findFirst', () => OTHERS_PROJECT);
  db.handlers.set('project.findUnique', () => OTHERS_PROJECT);
  db.handlers.set('deployment.findUnique', () => OTHERS_DEPLOYMENT);
  db.handlers.set('memoryEntry.findUnique', () => OTHERS_MEMORY);
}

beforeEach(() => {
  session.user = null;
  db.handlers.clear();
});

/* ------------------------------------------------------------------- the sweep */

describe('server action authorization contract (F-313)', () => {
  describe('the enumeration is mechanical', () => {
    it('registers every `use server` module in the source tree', () => {
      // Not `toContain`: the sets must be equal in both directions, so a new
      // action module fails here and a deleted one cannot rot in the registry.
      const discovered = discoverUseServerModules();
      const registered = ACTION_AUTHZ.map((entry) => entry.id).sort();
      expect(discovered).toEqual(registered);
      // Anti-vacuity: an empty walk would satisfy the equality above if the
      // registry were also emptied.
      expect(discovered.length).toBeGreaterThanOrEqual(17);
    });

    it('loads and calls every registered module', () => {
      // The registry is shared with the route suite, which cannot import these
      // modules. Without this, a module could be classified there and never
      // actually exercised here.
      expect(Object.keys(MODULE_OBJECTS).sort()).toEqual(
        ACTION_AUTHZ.map((entry) => entry.id).sort(),
      );
    });

    for (const registered of ACTION_AUTHZ) {
      it(`${registered.id} classifies every function export, and nothing else`, () => {
        const exported = actionExports(MODULE_OBJECTS[registered.id] ?? {})
          .map(([name]) => name)
          .sort();
        expect(Object.keys(registered.exports).sort()).toEqual(exported);
        expect(exported.length).toBeGreaterThan(0);
      });

      it(`${registered.id} justifies every ungated target`, () => {
        // A `session` classification on a project-scoped or mutating export is
        // the N-009 shape. It is allowed, but only in writing.
        expect(unjustifiedTargets(registered).join(' | ')).toBe('');
      });
    }

    it('records no export as completely ungated', () => {
      const ungated = ACTION_AUTHZ.flatMap((registered) =>
        Object.entries(registered.exports)
          .filter(([, entry]) => entry.gate === 'none')
          .map(([name]) => `${registered.id} ${name}`),
      );
      // N-005 left this at two (`isCodeScanInFlight`, `isSeoScanInFlight`).
      // Both are gated; an entry reappearing here is a new finding.
      expect(ungated.join(' | ')).toBe('');
    });
  });

  for (const registered of ACTION_AUTHZ) {
    describe(registered.id, () => {
      for (const [name, action] of actionExports(MODULE_OBJECTS[registered.id] ?? {})) {
        const classified = registered.exports[name];
        // The classification test above owns the "unclassified" failure; here an
        // unknown name simply has no behaviour to assert.
        if (!classified || classified.gate === 'none') continue;
        const args = classified.args ?? DEFAULT_ACTION_ARGS;

        it(`${name} rejects an unauthenticated caller with 401, before any data access`, async () => {
          const result = (await action(...args)) as { ok: boolean; status: number };
          expect(result).toMatchObject({ ok: false, status: 401 });
        });

        if (classified.gate === 'admin') {
          it(`${name} rejects a signed-in MEMBER with 403`, async () => {
            session.user = MEMBER;
            const result = (await action(...args)) as { ok: boolean; status: number };
            expect(result).toMatchObject({ ok: false, status: 403 });
          });
        }

        if (classified.gate === 'owner') {
          it(`${name} rejects a MEMBER who does not own the target with 403`, async () => {
            session.user = MEMBER;
            allowOwnershipLookups();
            const result = (await action(...args)) as { ok: boolean; status: number };
            expect(result).toMatchObject({ ok: false, status: 403 });
          });
        }
      }
    });
  }

  describe('positive controls — the mocks can also let a caller through', () => {
    // Without these, a suite whose auth mock always rejected would stay green
    // while asserting nothing (the F-601 class). All three prove the session
    // state actually flips outcomes.
    it('a signed-in MEMBER passes a session gate (stars.getWorkspaceMeta)', async () => {
      session.user = MEMBER;
      db.handlers.set('user.count', () => 3);
      const result = await starActions.getWorkspaceMeta();
      expect(result).toMatchObject({ ok: true, data: { memberCount: 3 } });
    });

    it('an ADMIN passes requireAdmin (coolify createCoolifyServer refuses with 410, not 401/403)', async () => {
      session.user = ADMIN;
      const result = await coolifyServerActions.createCoolifyServer();
      expect(result).toMatchObject({ ok: false, status: 410 });
    });

    it('an ADMIN passes an owner check on a project they do not own (stars.toggleStar)', async () => {
      session.user = ADMIN;
      allowOwnershipLookups();
      db.handlers.set('projectStar.findUnique', () => null);
      db.handlers.set('projectStar.create', () => ({ id: 'star-1' }));
      const result = await starActions.toggleStar('proj-1');
      expect(result).toMatchObject({ ok: true, data: { starred: true } });
    });
  });
});
