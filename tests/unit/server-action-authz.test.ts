/**
 * Authorization contract for every `'use server'` action module (F-613).
 *
 * A Server Action POSTs to the page URL with a `Next-Action` header, so
 * `proxy.ts`'s deny-by-default `/api` gate never sees it: the role/ownership
 * check INSIDE each action is the only authorization on that path. This suite
 * pins that contract for the ten action modules the Phase 6 audit found loaded
 * by no test:
 *
 *   1. signed out, EVERY export must reject with `{ ok: false, status: 401 }`
 *      before touching the database (the prisma stub throws on any access, so
 *      a gate that runs after a query fails loudly);
 *   2. a signed-in MEMBER must be rejected with 403 by every admin-only export
 *      and by owner-scoped mutations on a project they do not own.
 *
 * The gates themselves live in `@/lib/auth` (`getSessionUser`,
 * `requireSessionUser`, `requireAdmin`); the mock below mirrors those helpers'
 * real semantics exactly (401 'Sign in required', 403 'Admin access required')
 * so what is exercised is each ACTION's use of them, not the helpers.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

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

import * as apiKeyActions from '@/lib/api-keys/actions';
import * as auditActions from '@/lib/audit/actions';
import * as coolifyActions from '@/lib/coolify/actions';
import * as coolifyServerActions from '@/lib/coolify/server-actions';
import * as githubActions from '@/lib/github/actions';
import * as memoryActions from '@/lib/memory/actions';
import * as seoActions from '@/lib/seo/actions';
import * as skillActions from '@/lib/skills/actions';
import * as starActions from '@/lib/projects/stars';
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

type ModuleSpec = {
  id: string;
  mod: ActionModule;
  /** Per-export call arguments; gates run before args are read, so most are generic. */
  args?: Record<string, unknown[]>;
  /** Exports that must reject a signed-in MEMBER with 403. */
  adminOnly?: string[];
  /**
   * REAL FINDING, pinned — not approved. These exports carry NO authorization
   * gate today: `isCodeScanInFlight` / `isSeoScanInFlight` answer for any
   * unauthenticated caller whether a scan is running for a given projectId (an
   * activity/enumeration oracle). Pinning them here keeps this suite honest in
   * both directions: a NEW ungated export fails the 401 sweep, and gating one
   * of these later forces this pin to be removed.
   */
  ungated?: string[];
};

const DEFAULT_ARGS: unknown[] = ['id-1', 'arg-2'];

// `deleteOrgApiKey` is being added by the CredStore agent in this same wave
// (requireAdmin, same ActionErr contract — agreed over hub 2026-08-20). The
// filter below covers whichever side lands first; once both are merged the
// export exists and is asserted.
const MODULES: ModuleSpec[] = [
  {
    id: 'lib/api-keys/actions',
    mod: apiKeyActions,
    args: { setPersonalApiKey: ['openai', 'test-key'], setOrgApiKey: ['openai', 'test-key'] },
    adminOnly: ['listOrgApiKeys', 'setOrgApiKey', 'deleteOrgApiKey'],
  },
  {
    id: 'lib/audit/actions',
    mod: auditActions,
    adminOnly: ['getTopRecurringIssues'],
    ungated: ['isCodeScanInFlight'],
  },
  {
    id: 'lib/coolify/actions',
    mod: coolifyActions,
    args: { saveDeploySettings: [{ baseUrl: 'https://coolify.navroop.app' }] },
    adminOnly: ['getDeploySettings', 'saveDeploySettings', 'testDeployConnection'],
  },
  {
    id: 'lib/coolify/server-actions',
    mod: coolifyServerActions,
    adminOnly: [
      'listCoolifyServers',
      'createCoolifyServer',
      'updateCoolifyServer',
      'forceDeactivateServer',
      'deleteCoolifyServer',
      'testCoolifyServerAction',
    ],
  },
  { id: 'lib/github/actions', mod: githubActions },
  {
    id: 'lib/memory/actions',
    mod: memoryActions,
    adminOnly: ['getMemoryExtractionSetting', 'updateMemoryExtractionSetting'],
  },
  {
    id: 'lib/seo/actions',
    mod: seoActions,
    ungated: ['isSeoScanInFlight'],
  },
  {
    id: 'lib/skills/actions',
    mod: skillActions,
    adminOnly: ['createSkill', 'updateSkill', 'deleteSkill', 'toggleSkillEnabled'],
  },
  { id: 'lib/projects/stars', mod: starActions },
  {
    id: 'lib/templates/actions',
    mod: templateActions,
    adminOnly: [
      'adminListTemplates',
      'adminCreateTemplate',
      'adminUpdateTemplate',
      'adminDeleteTemplate',
      'adminTestTemplate',
      'adminUploadThumbnail',
      'adminGenerateThumbnails',
    ],
  },
];

function actionExports(mod: ActionModule): Array<[string, (...args: unknown[]) => unknown]> {
  return Object.entries(mod).filter(
    (entry): entry is [string, (...args: unknown[]) => unknown] => typeof entry[1] === 'function',
  );
}

beforeEach(() => {
  session.user = null;
  db.handlers.clear();
});

describe('server action authorization contract (F-613)', () => {
  for (const spec of MODULES) {
    const exported = actionExports(spec.mod);
    const ungated = spec.ungated ?? [];

    describe(spec.id, () => {
      it('exports at least one action (anti-vacuity)', () => {
        expect(exported.length).toBeGreaterThan(0);
      });

      for (const [name, action] of exported) {
        if (ungated.includes(name)) {
          it(`${name} is pinned as UNGATED — remove the pin when it gains a gate`, async () => {
            const result = (await action(...(spec.args?.[name] ?? DEFAULT_ARGS))) as {
              status?: number;
            } | null;
            expect(result?.status).not.toBe(401);
          });
          continue;
        }

        it(`${name} rejects an unauthenticated caller with 401, before any data access`, async () => {
          const result = (await action(...(spec.args?.[name] ?? DEFAULT_ARGS))) as {
            ok: boolean;
            status: number;
          };
          expect(result).toMatchObject({ ok: false, status: 401 });
        });
      }

      const adminOnly = (spec.adminOnly ?? []).filter(
        (name) => typeof spec.mod[name] === 'function',
      );
      for (const name of adminOnly) {
        it(`${name} rejects a MEMBER with 403`, async () => {
          session.user = MEMBER;
          const action = spec.mod[name] as (...args: unknown[]) => unknown;
          const result = (await action(...(spec.args?.[name] ?? DEFAULT_ARGS))) as {
            ok: boolean;
            status: number;
          };
          expect(result).toMatchObject({ ok: false, status: 403 });
        });
      }
    });
  }

  describe('owner-scoped mutations (canMutate)', () => {
    const OTHERS_PROJECT = { id: 'proj-1', ownerId: 'owner-9' };
    const cases: Array<{ id: string; mod: ActionModule; names: string[] }> = [
      {
        id: 'lib/audit/actions',
        mod: auditActions,
        names: ['runCodeAudit', 'toggleIgnoreCodeFinding', 'fixCodeFinding', 'fixAllCodeFindings'],
      },
      {
        id: 'lib/seo/actions',
        mod: seoActions,
        names: ['runSeoAudit', 'toggleIgnoreFinding', 'fixSeoFinding', 'fixAllSeoFindings'],
      },
    ];
    for (const { id, mod, names } of cases) {
      for (const name of names) {
        it(`${id} ${name} rejects a MEMBER who does not own the project with 403`, async () => {
          session.user = MEMBER;
          db.handlers.set('project.findFirst', () => OTHERS_PROJECT);
          const action = mod[name] as (...args: unknown[]) => unknown;
          const result = (await action('proj-1', 'finding-1')) as { ok: boolean; status: number };
          expect(result).toMatchObject({ ok: false, status: 403 });
        });
      }
    }
  });

  describe('positive controls — the mocks can also let a caller through', () => {
    // Without these, a suite whose auth mock always rejected would stay green
    // while asserting nothing (the F-601 class). Both prove the session state
    // actually flips outcomes.
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
  });
});
