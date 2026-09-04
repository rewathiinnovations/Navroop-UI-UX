/**
 * Every mutating API endpoint is classified, and the list comes from the tree
 * (F-313).
 *
 * `lib/auth/route-policy.ts` names ten routes and `tests/unit/auth-matrix.test.ts`
 * drives all ten for real, five actors each. That part is good and untouched.
 * What F-313 filed is the other 103: the mutating surface is 113 endpoints, the
 * list was hand-written, and a new POST route joined the product without any
 * test noticing.
 *
 * So the list here is derived from `collectRouteEndpoints()` — the same walker
 * `tests/unit/api-route-auth.test.ts` and `scripts/check-public-routes.ts` use.
 * A new POST/PUT/PATCH/DELETE handler fails this file until it is classified.
 *
 * Five claims, in descending strength:
 *
 *  1. COMPLETENESS. The registry and the filesystem must name the same set of
 *     mutating endpoints, in both directions.
 *  2. THE PROXY AGREES. `open` and `cron` entries must appear in
 *     `PUBLIC_API_ROUTES` for that exact method, and everything else must NOT.
 *     "Public" therefore cannot be this file's private opinion — it has to be a
 *     line in the allowlist that `proxy.ts` reads and
 *     `scripts/check-public-routes.ts` audits.
 *  3. DELEGATION IS PROVED, NOT ASSERTED. About half these routes are thin
 *     wrappers over a `'use server'` action. Each such entry names the action;
 *     the route source must really import that name from that module, and the
 *     action's classification in `ACTION_AUTHZ` must equal the route's. Those
 *     gates are then proved by running them in
 *     `tests/unit/server-action-authz.test.ts` — 401 signed out, 403 for the
 *     wrong actor — rather than by matching source text.
 *  4. A GATE NAME IS STILL PRESENT. For the rest, the same deliberately weak
 *     text tripwire `auth-matrix.test.ts` uses, over the route source. It cannot
 *     prove the gate runs; it catches a gate deleted wholesale.
 *  5. CSRF IS DECLARED, NOT ASSUMED (F-350). Every endpoint here must be one
 *     the origin check in `proxy.ts` covers. The mechanism is computed from
 *     `lib/auth/csrf.ts` rather than typed into the table, so it cannot rot:
 *     the day something is added to `ORIGIN_CHECK_EXEMPT`, this file fails
 *     until that endpoint's row says so in writing. The refusal itself is
 *     driven for real against every endpoint in
 *     `tests/unit/api-csrf-origin.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ORIGIN_CHECK_EXEMPT,
  csrfMechanismFor,
  validateOriginCheckExemptions,
} from '@/lib/auth/csrf';
import { PUBLIC_API_ROUTES, matchPublicRoute } from '@/lib/auth/public-routes';
import { collectRouteEndpoints } from '@/lib/auth/route-inventory';
import { MUTATING_ROUTE_POLICIES } from '@/lib/auth/route-policy';
import { ACTION_AUTHZ, actionAuthz, type Gate } from '../support/action-authz-registry';

const MUTATING_METHODS: Record<string, true> = {
  POST: true,
  PUT: true,
  PATCH: true,
  DELETE: true,
};

/**
 * `admin`    — refuses a non-ADMIN.
 * `owner`    — refuses a MEMBER who does not own the target row.
 * `session`  — signed-in only; the target is the caller, or the read/write is
 *              workspace-wide by decision (Navroop is a single workspace).
 * `cron`     — no session; `authorizeCron` checks the CRON_SECRET bearer token.
 * `open`     — deliberately reachable without a session; needs `why` and an
 *              allowlist entry naming what protects it instead.
 * `nextauth` — the Auth.js catch-all, which is allowlisted action by action in
 *              `PUBLIC_API_ROUTES` rather than as a bare `/api/auth/*` wildcard,
 *              precisely so a sibling like `/api/auth/me` stays private.
 */
type RouteGate = Gate | 'cron' | 'open' | 'nextauth';

type RouteAuthz = {
  gate: RouteGate;
  /** `lib/x/actions#exportName` when the route is a wrapper over an action. */
  action?: string;
  /**
   * Module the gate lives in when it is neither the route file nor a registered
   * `'use server'` action — e.g. the plan and checkpoint routes call into a
   * plain `lib` module. The text tripwire reads this instead of the route file.
   */
  gateFile?: string;
  /** Required for `session`, `open`. */
  why?: string;
  /**
   * Only for an endpoint that `ORIGIN_CHECK_EXEMPT` lets a cross-origin
   * browser drive (F-350). The default — the origin check in `proxy.ts` — is
   * derived from `lib/auth/csrf.ts`, not declared here, so it cannot rot; this
   * field is how an exemption is stated in writing before the sweep accepts
   * it.
   */
  csrf?: { mechanism: 'declared-exempt'; why: string };
};

const OWNER_BY_ACTION =
  'gate lives in the action, proved by running it in server-action-authz.test.ts';

const ROUTE_AUTHZ: Record<string, RouteAuthz> = {
  /* ------------------------------------------------------------------ admin */
  'PUT /api/admin/api-keys': { gate: 'admin', action: 'lib/api-keys/actions#setOrgApiKey' },
  'DELETE /api/admin/api-keys': { gate: 'admin', action: 'lib/api-keys/actions#deleteOrgApiKey' },
  'POST /api/admin/backups/run': { gate: 'admin' },
  'PUT /api/admin/deploy': { gate: 'admin', action: 'lib/coolify/actions#saveDeploySettings' },
  'POST /api/admin/deploy/test': {
    gate: 'admin',
    action: 'lib/coolify/actions#testDeployConnection',
  },
  'POST /api/admin/health/rollback': { gate: 'admin' },
  'POST /api/admin/health/sentry-test': { gate: 'admin' },
  'POST /api/admin/integrations/check': { gate: 'admin' },
  'POST /api/admin/integrations/disconnect': { gate: 'admin' },
  'POST /api/admin/integrations/sentry/restart': { gate: 'admin' },
  'POST /api/admin/invite': { gate: 'admin' },
  'POST /api/admin/jobs/:id/abandon': { gate: 'admin' },
  'POST /api/admin/plans': { gate: 'admin', action: 'lib/plans/actions#createPlan' },
  'PATCH /api/admin/plans': { gate: 'admin', action: 'lib/plans/actions#updatePlan' },
  'POST /api/admin/servers': {
    gate: 'admin',
    action: 'lib/coolify/server-actions#createCoolifyServer',
  },
  'PATCH /api/admin/servers/:id': {
    gate: 'admin',
    action: 'lib/coolify/server-actions#updateCoolifyServer',
  },
  'DELETE /api/admin/servers/:id': {
    gate: 'admin',
    action: 'lib/coolify/server-actions#deleteCoolifyServer',
  },
  'POST /api/admin/servers/:id/test': {
    gate: 'admin',
    action: 'lib/coolify/server-actions#testCoolifyServerAction',
  },
  'PUT /api/admin/settings': { gate: 'admin' },
  'POST /api/admin/settings/test': { gate: 'admin' },
  'POST /api/admin/team/:id/reset-link': { gate: 'admin' },
  'POST /api/admin/templates': {
    gate: 'admin',
    action: 'lib/templates/actions#adminCreateTemplate',
  },
  'POST /api/admin/templates/thumbnails': {
    gate: 'admin',
    action: 'lib/templates/actions#adminGenerateThumbnails',
  },
  'PATCH /api/admin/templates/:id': {
    gate: 'admin',
    action: 'lib/templates/actions#adminUpdateTemplate',
  },
  'DELETE /api/admin/templates/:id': {
    gate: 'admin',
    action: 'lib/templates/actions#adminDeleteTemplate',
  },
  'POST /api/admin/templates/:id/test': {
    gate: 'admin',
    action: 'lib/templates/actions#adminTestTemplate',
  },
  'POST /api/admin/templates/:id/thumbnail': {
    gate: 'admin',
    action: 'lib/templates/actions#adminUploadThumbnail',
  },
  'PATCH /api/admin/workspace': {
    gate: 'admin',
    action: 'lib/plans/actions#updateWorkspaceAdminSettings',
  },
  'POST /api/integrations/cloudflare': { gate: 'admin' },
  'POST /api/integrations/cloudflare/zone': { gate: 'admin' },
  'POST /api/integrations/coolify': { gate: 'admin' },
  'POST /api/integrations/coolify/select': { gate: 'admin' },
  'POST /api/integrations/sentry/connect': { gate: 'admin' },
  'POST /api/integrations/sentry/select': { gate: 'admin' },
  'POST /api/integrations/sentry/settings': { gate: 'admin' },
  'POST /api/integrations/sentry/start': { gate: 'admin' },
  'POST /api/integrations/sentry/verify': { gate: 'admin' },
  // Taking a lock away from whoever holds it is an operator action, not the
  // project owner's: `forceRelease` refuses a non-ADMIN and the route checks
  // `role !== 'ADMIN'` itself before calling it.
  'POST /api/projects/:id/lock/release': { gate: 'admin' },
  'PATCH /api/team': { gate: 'admin', action: 'lib/team/actions#updateMemberRole' },
  'POST /api/team/deactivate': { gate: 'admin', action: 'lib/team/actions#deactivateMember' },
  'POST /api/team/reactivate': { gate: 'admin', action: 'lib/team/actions#reactivateMember' },

  /* ------------------------------------------------------------------ owner */
  'POST /api/conversation-state': { gate: 'owner' },
  'POST /api/deployments/:id': { gate: 'owner', action: 'lib/publish/actions#redeployAction' },
  // The route that had no ownership check at all (F-313): it spends credits,
  // takes the owner's project lock and settles generated code onto the project,
  // with the project id read from the request body.
  'POST /api/generate-ai-code-stream': { gate: 'owner' },
  'POST /api/github/push': { gate: 'owner', action: 'lib/github/actions#pushProjectToGitHub' },
  'POST /api/projects/:id/assets': {
    gate: 'owner',
    action: 'lib/assets/actions#uploadProjectAsset',
  },
  'PATCH /api/projects/:id/assets/:assetId': {
    gate: 'owner',
    action: 'lib/assets/actions#updateProjectAssetAlt',
  },
  'DELETE /api/projects/:id/assets/:assetId': {
    gate: 'owner',
    action: 'lib/assets/actions#deleteProjectAsset',
  },
  'POST /api/projects/:id/audit': { gate: 'owner', action: 'lib/audit/actions#runCodeAudit' },
  'POST /api/projects/:id/checkpoints/exit': {
    gate: 'owner',
    gateFile: 'lib/checkpoints/actions.ts',
  },
  'POST /api/projects/:id/checkpoints/restore-working': {
    gate: 'owner',
    gateFile: 'lib/checkpoints/actions.ts',
  },
  'POST /api/projects/:id/checkpoints/:checkpointId/bookmark': {
    gate: 'owner',
    gateFile: 'lib/checkpoints/actions.ts',
  },
  'POST /api/projects/:id/checkpoints/:checkpointId/preview': {
    gate: 'owner',
    gateFile: 'lib/checkpoints/actions.ts',
  },
  'POST /api/projects/:id/checkpoints/:checkpointId/restore': {
    gate: 'owner',
    gateFile: 'lib/checkpoints/actions.ts',
  },
  'POST /api/projects/:id/domains': {
    gate: 'owner',
    action: 'lib/domains/actions#addProjectDomain',
  },
  'POST /api/projects/:id/domains/:domainId': {
    gate: 'owner',
    action: 'lib/domains/actions#makeProjectDomainPrimary',
  },
  'DELETE /api/projects/:id/domains/:domainId': {
    gate: 'owner',
    action: 'lib/domains/actions#removeProjectDomain',
  },
  'POST /api/projects/:id/duplicate': {
    gate: 'owner',
    action: 'lib/projects/actions#duplicateProject',
  },
  'POST /api/projects/:id/import': { gate: 'owner' },
  'POST /api/projects/:id/job/keep': { gate: 'owner' },
  'POST /api/projects/:id/job/retry': { gate: 'owner' },
  'POST /api/projects/:id/job/start-over': { gate: 'owner' },
  'POST /api/projects/:id/job/cancel': { gate: 'owner' },
  'POST /api/projects/:id/plan': { gate: 'owner', gateFile: 'lib/projects/plan.ts' },
  'PATCH /api/projects/:id/plan': { gate: 'owner', gateFile: 'lib/projects/plan.ts' },
  'POST /api/projects/:id/plan/approve': { gate: 'owner', gateFile: 'lib/projects/plan.ts' },
  'POST /api/projects/:id/plan/followup': { gate: 'owner', gateFile: 'lib/projects/plan.ts' },
  'POST /api/projects/:id/plan/refine': { gate: 'owner', gateFile: 'lib/projects/plan.ts' },
  'POST /api/projects/:id/preview': { gate: 'owner' },
  'POST /api/projects/:id/publish': { gate: 'owner', action: 'lib/publish/actions#startPublish' },
  'POST /api/projects/:id/publish/password': {
    gate: 'owner',
    action: 'lib/publish/actions#setPreviewPasswordAction',
  },
  'DELETE /api/projects/:id/publish/password': {
    gate: 'owner',
    action: 'lib/publish/actions#setPreviewPasswordAction',
  },
  // Also had no ownership check (F-313): a thumbs rating is a QualitySignal row
  // on someone else's project, and it moves the numbers on /admin/quality.
  'POST /api/projects/:id/quality-signals': { gate: 'owner' },
  'POST /api/projects/:id/restore': {
    gate: 'owner',
    action: 'lib/projects/actions#restoreProject',
  },
  'PATCH /api/projects/:id': { gate: 'owner', action: 'lib/projects/actions#updateProject' },
  'DELETE /api/projects/:id': { gate: 'owner', action: 'lib/projects/actions#deleteProject' },
  'POST /api/projects/:id/seo': { gate: 'owner', action: 'lib/seo/actions#runSeoAudit' },
  'POST /api/templates/from-project': {
    gate: 'owner',
    action: 'lib/templates/actions#saveProjectAsTemplate',
  },

  /* ---------------------------------------------------------------- session */
  'POST /api/analyze-edit-intent': {
    gate: 'session',
    why: 'classifies a prompt with no project id and writes nothing',
  },
  'POST /api/extract-brand-styles': {
    gate: 'session',
    why: 'reads a URL the caller supplies and returns styles; touches no project row',
  },
  'POST /api/github/disconnect': {
    gate: 'session',
    action: 'lib/github/actions#disconnectGitHub',
    why: 'disconnects the caller\u2019s own GitHub connection; the user id comes from the session',
  },
  'POST /api/legal/accept': {
    gate: 'session',
    why: 'stamps termsAcceptedAt on the caller\u2019s own user row',
  },
  'POST /api/legal/data-request': {
    gate: 'session',
    why: 'emails a data request about the caller\u2019s own account',
  },
  'POST /api/onboarding': {
    gate: 'session',
    why: 'writes the caller\u2019s own onboarding dismissal timestamps',
  },
  'POST /api/projects': {
    gate: 'session',
    action: 'lib/projects/actions#createProject',
    why: 'creates a row owned by the caller; ownerId comes from the session, so there is no pre-existing target',
  },
  'POST /api/projects/:id/presence': {
    gate: 'session',
    why: 'workspace-wide presence: the single workspace shows who is looking at a project, and the row is keyed on the caller',
  },
  'POST /api/scrape-screenshot': {
    gate: 'session',
    why: 'screenshots a caller-supplied URL through the SSRF guard; touches no project row',
  },
  'POST /api/scrape-url-enhanced': {
    gate: 'session',
    why: 'scrapes a caller-supplied URL through the SSRF guard; touches no project row',
  },
  'POST /api/scrape-website': {
    gate: 'session',
    why: 'scrapes a caller-supplied URL through the SSRF guard; touches no project row',
  },
  'POST /api/search': {
    gate: 'session',
    why: 'workspace-wide search, the same surface listProjects already exposes to every member',
  },
  'PUT /api/settings/api-keys': {
    gate: 'session',
    action: 'lib/api-keys/actions#setPersonalApiKey',
    why: 'writes the caller\u2019s own personal key',
  },
  'DELETE /api/settings/api-keys': {
    gate: 'session',
    action: 'lib/api-keys/actions#deleteApiKey',
    why: 'deletes the caller\u2019s own personal key',
  },
  'PATCH /api/settings/password': {
    gate: 'session',
    action: 'lib/profile/actions#changePassword',
    why: 'changes the caller\u2019s own password after re-verifying the current one',
  },
  'PATCH /api/settings/profile': {
    gate: 'session',
    action: 'lib/profile/actions#updateProfile',
    why: 'edits the caller\u2019s own user row',
  },
  'POST /api/templates/:id/create': {
    gate: 'session',
    action: 'lib/templates/actions#createFromTemplate',
    why: 'creates a new project owned by the caller from a workspace-visible template',
  },
  'DELETE /api/templates/:id': {
    gate: 'session',
    action: 'lib/templates/actions#deleteTemplate',
    why: 'deletes a Template the caller saved in this workspace, or any visible template if ADMIN; built-ins refuse a MEMBER in English',
  },

  /* --------------------------------------------------------------- cron/open */
  'POST /api/cron/backup-db': { gate: 'cron' },
  'POST /api/cron/check-certs': { gate: 'cron' },
  'POST /api/cron/check-domains': { gate: 'cron' },
  'POST /api/cron/check-integrations': { gate: 'cron' },
  'POST /api/cron/check-uptime': { gate: 'cron' },
  'POST /api/cron/cleanup-orphans': { gate: 'cron' },
  'POST /api/cron/observability-heartbeat': { gate: 'cron' },
  'POST /api/cron/observability-quota': { gate: 'cron' },
  'POST /api/cron/purge-projects': { gate: 'cron' },
  'POST /api/cron/reap-jobs': { gate: 'cron' },
  'POST /api/cron/sweep-tmp': { gate: 'cron' },
  'POST /api/cron/system-checks-digest': { gate: 'cron' },
  'POST /api/cron/thin-checkpoints': { gate: 'cron' },
  'POST /api/cron/verify-storage': { gate: 'cron' },
  'POST /api/auth/accept-invite': {
    gate: 'open',
    why: 'an invitee has no password yet, so no session can exist; single-use sha256-hashed invite token with an expiry, claimed by a conditional UPDATE (F-351)',
  },
  'POST /api/auth/dev-login': {
    gate: 'open',
    why: 'local quick login, used before a session exists; returns 404 unless dev quick login is enabled',
  },
  'POST /api/auth/forgot-password': {
    gate: 'open',
    why: 'a locked-out user has no session by definition; generic response plus per-email and per-IP rate limits',
  },
  'POST /api/auth/login': {
    gate: 'open',
    why: 'signing in is the act of obtaining a session; password verification plus rate limits',
  },
  'POST /api/auth/logout': {
    gate: 'open',
    why: 'must succeed after the session token has expired; clears the caller cookie only',
  },
  'POST /api/auth/register': {
    gate: 'open',
    why: 'kept reachable so the closed-registration message is returned rather than a 401; always 403',
  },
  'POST /api/auth/reset-password': {
    gate: 'open',
    why: 'the reset link is opened without a session; single-use hashed token with an expiry',
  },
  'POST /api/auth/signup': {
    gate: 'open',
    why: 'kept reachable so the disabled-signup message is returned rather than a 401; always 403',
  },
  'POST /api/integrations/github/webhook': {
    gate: 'open',
    why: 'GitHub delivers App events with no session; the HMAC-SHA256 body signature is verified against the stored App webhook secret before anything is parsed or written (F-265)',
  },
  'POST /api/auth/*': {
    gate: 'nextauth',
    why: 'Auth.js catch-all; its public actions (signin, callback, signout, …) are allowlisted one by one so a private sibling like /api/auth/me is not exposed',
  },
};

/* ------------------------------------------------------------------ helpers */

const GATE_PATTERN: Record<RouteGate, RegExp | null> = {
  admin: /requireAdmin\s*\(|role !== 'ADMIN'/,
  owner: /ownerId|canMutate|mayMint|requireActor/,
  session: /getSessionUser\s*\(|requireSessionUser\s*\(/,
  cron: /authorizeCron\s*\(|handleCron\s*\(/,
  open: null,
  nextauth: null,
  none: null,
};

/** Route-policy paths use `[id]`; the inventory and this registry use `:id`. */
function policyKey(method: string, path: string): string {
  return `${method} ${path.replace(/\[(\.\.\.)?(\w+)\]/g, ':$2')}`;
}

function routeKeys(): string[] {
  return collectRouteEndpoints()
    .filter((endpoint) => MUTATING_METHODS[endpoint.method])
    .map((endpoint) => `${endpoint.method} ${endpoint.pattern}`)
    .sort();
}

function fileFor(key: string): string {
  const [method, pattern] = key.split(' ');
  const endpoint = collectRouteEndpoints().find(
    (candidate) => candidate.method === method && candidate.pattern === pattern,
  );
  if (!endpoint) throw new Error(`${key} is not a route in the tree`);
  return endpoint.file;
}

function publicMethodsFor(pattern: string): string[] {
  return PUBLIC_API_ROUTES.filter((rule) => rule.pattern === pattern).flatMap(
    (rule) => rule.methods,
  );
}

/** `/api/cron/reap-jobs` is covered by the `/api/cron/*` allowlist entry. */
function allowlistCovers(pattern: string, method: string): boolean {
  if (publicMethodsFor(pattern).includes(method)) return true;
  return PUBLIC_API_ROUTES.some(
    (rule) =>
      rule.pattern.endsWith('/*') &&
      pattern.startsWith(rule.pattern.slice(0, -1)) &&
      rule.methods.includes(method),
  );
}

/* -------------------------------------------------------------------- tests */

describe('every mutating API endpoint is classified (F-313)', () => {
  it('registry and route tree name the same endpoints', () => {
    // Both directions: a new mutating handler fails here, and an entry for a
    // route that was deleted or renamed cannot rot in the table.
    expect(Object.keys(ROUTE_AUTHZ).sort()).toEqual(routeKeys());
    // Anti-vacuity: an empty walk would satisfy the equality if the registry
    // were also emptied. The surface F-313 measured was ~113.
    expect(routeKeys().length).toBeGreaterThanOrEqual(110);
  });

  it('covers more than the ten routes the behavioural matrix drives', () => {
    // The point of the finding. `auth-matrix.test.ts` still owns the strong
    // per-actor assertions for its ten; this file owns completeness.
    expect(Object.keys(ROUTE_AUTHZ).length).toBeGreaterThan(MUTATING_ROUTE_POLICIES.length * 10);
  });

  it('agrees with lib/auth/route-policy.ts on every route that list names', () => {
    const stronger: Record<string, RouteGate[]> = {
      requireAdmin: ['admin'],
      requireSessionUser: ['admin', 'owner', 'session'],
      getSessionUser: ['admin', 'owner', 'session'],
      public: ['open', 'cron'],
    };
    const disagreements: string[] = [];
    for (const policy of MUTATING_ROUTE_POLICIES) {
      const key = policyKey(policy.method, policy.path);
      const entry = ROUTE_AUTHZ[key];
      if (!entry) {
        disagreements.push(`${key} missing from ROUTE_AUTHZ`);
        continue;
      }
      if (!stronger[policy.gate].includes(entry.gate)) {
        disagreements.push(`${key} policy says ${policy.gate}, registry says ${entry.gate}`);
      }
    }
    expect(disagreements.join(' | ')).toBe('');
  });
});

describe('the proxy allowlist and this registry agree on what is public', () => {
  for (const [key, entry] of Object.entries(ROUTE_AUTHZ)) {
    const [method, pattern] = key.split(' ');
    if (entry.gate === 'nextauth') {
      it(`${key} is allowlisted action by action, not as a bare wildcard`, () => {
        // The catch-all pattern itself must NOT be a single allowlist entry —
        // that is what keeps a private sibling under /api/auth private.
        expect(publicMethodsFor('/api/auth/*')).toEqual([]);
        // A real public action resolves; a made-up sibling does not.
        expect(matchPublicRoute('/api/auth/callback/credentials', 'POST')).not.toBeNull();
        expect(matchPublicRoute('/api/auth/me', 'POST')).toBeNull();
        expect(entry.why ?? '').not.toBe('');
      });
    } else if (entry.gate === 'open' || entry.gate === 'cron') {
      it(`${key} is in PUBLIC_API_ROUTES, so proxy.ts really lets it through`, () => {
        expect(allowlistCovers(pattern, method)).toBe(true);
        expect(entry.why ?? (entry.gate === 'cron' ? 'CRON_SECRET' : '')).not.toBe('');
      });
    } else {
      it(`${key} is not allowlisted, so an anonymous caller is stopped at the proxy`, () => {
        expect(allowlistCovers(pattern, method)).toBe(false);
      });
    }
  }
});

describe('delegating routes inherit a gate that is proved by running it', () => {
  const registeredModules = ACTION_AUTHZ.map((entry) => entry.id);

  for (const [key, entry] of Object.entries(ROUTE_AUTHZ)) {
    if (!entry.action) continue;
    const [moduleId, exportName] = entry.action.split('#');

    it(`${key} delegates to ${entry.action}, classified the same there`, () => {
      expect(registeredModules).toContain(moduleId);
      const classified = actionAuthz(moduleId, exportName);
      // A renamed or deleted action breaks this, not just the route.
      expect(classified, `${entry.action} is not in ACTION_AUTHZ`).toBeDefined();
      expect(classified?.gate, `${key} vs ${entry.action}`).toBe(entry.gate);

      // And the claim is checked against the route source: the declared action
      // must actually be imported there, so the link cannot be decorative.
      const source = readFileSync(join(process.cwd(), fileFor(key)), 'utf8');
      const importOfModule = new RegExp(
        `import\\s*\\{([^}]*)\\}\\s*from\\s*'@/${moduleId.replace(/\//g, '\\/')}'`,
      );
      const imported = source.match(importOfModule);
      expect(imported, `${fileFor(key)} does not import from @/${moduleId}`).not.toBeNull();
      expect(imported?.[1]).toContain(exportName);
    });
  }
});

describe('gate names in source', () => {
  it('text-presence tripwire: every non-public mutating route still mentions a gate', () => {
    // Deliberately weak and titled to say so, exactly like the tripwire in
    // `auth-matrix.test.ts`. For a delegating route the gate is one module away,
    // so the action module counts as the gate's home.
    const missing: string[] = [];
    for (const [key, entry] of Object.entries(ROUTE_AUTHZ)) {
      const pattern = GATE_PATTERN[entry.gate];
      if (!pattern) continue;
      const file =
        entry.gateFile ?? (entry.action ? `${entry.action.split('#')[0]}.ts` : fileFor(key));
      if (!pattern.test(readFileSync(join(process.cwd(), file), 'utf8'))) {
        missing.push(`${key} lost its ${entry.gate} gate in ${file}`);
      }
    }
    expect(missing.join(' | ')).toBe('');
  });

  it('the tripwire can fail', () => {
    // Without this the loop above would pass on an empty pattern set or a
    // regex that matches everything.
    expect(GATE_PATTERN.admin?.test('const x = 1')).toBe(false);
    expect(GATE_PATTERN.admin?.test('await requireAdmin()')).toBe(true);
    expect(OWNER_BY_ACTION.length).toBeGreaterThan(0);
  });
});

describe('cross-origin writes are covered for every endpoint (F-350)', () => {
  it('the exemption list is empty and well formed', () => {
    // Empty is the claim: nothing in the product lets another origin drive a
    // mutation with the caller's cookie. `validateOriginCheckExemptions`
    // refuses a pattern or a lowercase method, so a future entry cannot be
    // wider than whoever wrote it intended.
    expect(ORIGIN_CHECK_EXEMPT).toEqual([]);
    expect(validateOriginCheckExemptions()).toEqual([]);
  });

  it('every exemption names an endpoint that exists and declares itself here', () => {
    // Both directions, the same shape as the allowlist agreement above: an
    // exemption for a route nobody classified, and an exemption the route's own
    // row does not admit to, are both failures.
    const undeclared: string[] = [];
    for (const rule of ORIGIN_CHECK_EXEMPT) {
      const key = `${rule.method.toUpperCase()} ${rule.pattern}`;
      const entry = ROUTE_AUTHZ[key];
      if (!entry) {
        undeclared.push(`${key} is exempt from the origin check but is not a classified route`);
        continue;
      }
      if (!entry.csrf?.why?.trim()) {
        undeclared.push(`${key} is exempt from the origin check with no written reason`);
      }
    }
    expect(undeclared.join(' | ')).toBe('');
  });

  for (const [key, entry] of Object.entries(ROUTE_AUTHZ)) {
    const [method, pattern] = key.split(' ');
    it(`${key} is covered by the origin check in proxy.ts`, () => {
      // Computed, never copied: the mechanism comes from the module the proxy
      // itself calls. A route exempted there fails here until its row says so,
      // and a row claiming an exemption it does not have fails too.
      const mechanism = csrfMechanismFor(method, pattern);
      expect(entry.csrf?.mechanism ?? 'proxy-origin-check').toBe(mechanism);
      if (mechanism === 'declared-exempt') {
        expect(entry.csrf?.why ?? '').not.toBe('');
      }
    });
  }

  it('the coverage assertion can fail', () => {
    // Anti-vacuity: `csrfMechanismFor` is not a function that returns
    // "covered" for everything. A GET is not a state change, and an exempted
    // path reports the exemption.
    expect(csrfMechanismFor('GET', '/api/projects')).toBe('not-state-changing');
    expect(
      csrfMechanismFor('POST', '/api/projects', [
        { pattern: '/api/projects', method: 'POST', reason: 'test only' },
      ]),
    ).toBe('declared-exempt');
  });
});
