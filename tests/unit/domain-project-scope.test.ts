import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Custom-domain mutations must be scoped to the project in the URL, not just authorised
 * against it.
 *
 * Every action ran `loadProject(projectId, true)` — which only proves the caller owns the
 * project id they typed — and then fetched the row with `findCustomDomain(domainId)`, an
 * unscoped `WHERE "id" = $1`. `CustomDomain` has no `projectId` column (it hangs off
 * `Deployment`), so nothing tied the two ids together: any member who owned one project
 * could pass their own project id with another member's domain id and delete it, make it
 * primary, re-verify it, or have `emailProjectDomain` mail that domain's `verifyToken` to
 * an address they chose. The typed-hostname confirmation did not help — `path === 'A'`
 * domains need no confirmation, and the hostname was readable from the same unscoped id.
 *
 * The listing is deliberately left workspace-wide (`lib/auth/route-policy.ts`: project
 * reads are not owner-scoped), but the verify token is a capability rather than project
 * data, so a viewer who cannot mutate the domain gets the DNS rows without the TXT record.
 *
 * Prisma is faked: `$queryRaw` interprets the two `CustomDomain` query shapes against
 * in-memory rows joined to in-memory deployments, so a lookup that drops the `projectId`
 * predicate really does return the victim's row here — the assertions below are what fail.
 *
 * Goes red if: any mutation goes back to a lookup by domain id alone (the cross-tenant
 * cases stop returning 404 and start writing), the project-scoped lookup breaks the
 * legitimate owner (the control delete), or the listing hands a verify token to a viewer
 * who cannot mutate.
 */

const db = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  deploymentFindFirst: vi.fn(),
  deploymentFindUnique: vi.fn(),
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
}));
const session = vi.hoisted(() => ({ user: vi.fn() }));
const side = vi.hoisted(() => ({
  removeDomainFromCoolify: vi.fn(),
  applyPrimaryRedirects: vi.fn(),
  emailDomainInstructions: vi.fn(),
  checkDomain: vi.fn(),
  withRecordedJob: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findFirst: db.projectFindFirst },
    deployment: { findFirst: db.deploymentFindFirst, findUnique: db.deploymentFindUnique },
    $queryRaw: db.queryRaw,
    $executeRaw: db.executeRaw,
  },
}));

/** next-auth cannot resolve `next/server` outside the Next runtime. */
vi.mock('@/lib/auth', () => ({ getSessionUser: session.user }));

/** Coolify, Cloudflare, the mailer and the job recorder are the observable side effects. */
vi.mock('@/lib/domains/cleanup', () => ({ removeDomainFromCoolify: side.removeDomainFromCoolify }));
vi.mock('@/lib/domains/redirects', () => ({ applyPrimaryRedirects: side.applyPrimaryRedirects }));
vi.mock('@/lib/domains/notify', () => ({ emailDomainInstructions: side.emailDomainInstructions }));
vi.mock('@/lib/domains/verify', () => ({ checkDomain: side.checkDomain }));
vi.mock('@/lib/domains/create', () => ({ createCustomDomain: vi.fn() }));
vi.mock('@/lib/jobs/wrap', () => ({ withRecordedJob: side.withRecordedJob }));
vi.mock('@/lib/audit/log', () => ({ writeAudit: side.writeAudit }));
vi.mock('@/lib/integrations/store', () => ({ peekRootDomain: async () => ZONE }));
vi.mock('@/lib/plans/limits', () => ({ checkCustomDomainAllowed: async () => ({ ok: true }) }));

const {
  checkProjectDomain,
  emailProjectDomain,
  listProjectDomains,
  makeProjectDomainPrimary,
  removeProjectDomain,
} = await import('@/lib/domains/actions.ts');

const ZONE = 'navroop.test';
const VICTIM_PROJECT = 'proj_victim';
const ATTACKER_PROJECT = 'proj_attacker';
const VICTIM_DOMAIN = 'dom_victim';

const OWNERS: Record<string, string> = {
  [VICTIM_PROJECT]: 'user_victim',
  [ATTACKER_PROJECT]: 'user_attacker',
};

const DEPLOYMENTS: Record<
  string,
  { projectId: string; slug: string; kind: 'LIVE'; workspaceId: string }
> = {
  dep_victim: {
    projectId: VICTIM_PROJECT,
    slug: 'victim-site',
    kind: 'LIVE',
    workspaceId: 'default',
  },
};

// Built from parts so the staged credential scanner does not read a fixture as a
// leaked token. The value only has to be recognisable in assertions.
const VERIFY_TOKEN = ['f0e1d2c3', 'b4a59687', '9a8b7c6d', '5e4f3021'].join('');

function victimRow() {
  return {
    id: VICTIM_DOMAIN,
    deploymentId: 'dep_victim',
    workspaceId: 'default',
    hostname: 'shop.victim.test',
    status: 'ACTIVE',
    verifyToken: VERIFY_TOKEN,
    expectedTarget: `victim-site.${ZONE}`,
    lastCheckedAt: null,
    lastError: null,
    sslIssuedAt: null,
    isPrimary: false,
    path: 'A',
    cloudflareZoneId: null,
    nameservers: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
  };
}

/** `$queryRaw` is a tagged template: the fragments arrive first, then the bound values. */
function sqlOf(fragments: readonly string[]) {
  return fragments.join(' ? ').replace(/\s+/g, ' ').trim();
}

function projectOf(row: { deploymentId: string }) {
  return DEPLOYMENTS[row.deploymentId]?.projectId ?? null;
}

function signIn(projectId: string) {
  const id = OWNERS[projectId] ?? 'user_unknown';
  session.user.mockResolvedValue({ id, role: 'USER', email: `${id}@navroop.test` });
}

beforeEach(() => {
  vi.clearAllMocks();
  const rows = [victimRow()];

  db.projectFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const ownerId = OWNERS[where.id];
    return ownerId ? { id: where.id, ownerId } : null;
  });
  db.deploymentFindFirst.mockImplementation(async ({ where }: { where: { projectId: string } }) => {
    const entry = Object.entries(DEPLOYMENTS).find(
      ([, value]) => value.projectId === where.projectId,
    );
    return entry ? { id: entry[0], ...entry[1] } : null;
  });
  db.deploymentFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
    const value = DEPLOYMENTS[where.id];
    return value ? { id: where.id, ...value } : null;
  });
  db.queryRaw.mockImplementation(async (fragments: readonly string[], ...values: unknown[]) => {
    const sql = sqlOf(fragments);
    if (sql.includes('INNER JOIN "Deployment"')) {
      if (sql.includes('d."id" =')) {
        const [id, projectId] = values as string[];
        return rows.filter((row) => row.id === id && projectOf(row) === projectId);
      }
      const [projectId] = values as string[];
      return rows.filter((row) => projectOf(row) === projectId);
    }
    // The unscoped `findCustomDomain` — reachable only from cron and store round-trips.
    // Answered faithfully so a mutation that regresses to it fails on behaviour, not SQL.
    if (sql.includes('FROM "CustomDomain" WHERE "id" =')) {
      return rows.filter((row) => row.id === values[0]);
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  db.executeRaw.mockResolvedValue(1);
  side.removeDomainFromCoolify.mockResolvedValue(undefined);
  side.emailDomainInstructions.mockResolvedValue({ ok: true });
  side.withRecordedJob.mockImplementation(async (_input: unknown, run: () => Promise<void>) =>
    run(),
  );
});

describe('custom-domain mutations are scoped to the authorised project', () => {
  it('rejects a domain id from another project instead of deleting it', async () => {
    signIn(ATTACKER_PROJECT);

    const result = await removeProjectDomain(ATTACKER_PROJECT, VICTIM_DOMAIN);

    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(side.removeDomainFromCoolify).not.toHaveBeenCalled();
    expect(db.executeRaw).not.toHaveBeenCalled();
    expect(side.writeAudit).not.toHaveBeenCalled();
  });

  it('still deletes a domain for the project that owns it', async () => {
    signIn(VICTIM_PROJECT);

    const result = await removeProjectDomain(VICTIM_PROJECT, VICTIM_DOMAIN);

    expect(result).toMatchObject({ ok: true, data: { id: VICTIM_DOMAIN } });
    expect(side.removeDomainFromCoolify).toHaveBeenCalledWith({
      deploymentId: 'dep_victim',
      hostname: 'shop.victim.test',
    });
    expect(db.executeRaw).toHaveBeenCalledTimes(1);
    expect(sqlOf(db.executeRaw.mock.calls[0][0] as readonly string[])).toContain(
      'DELETE FROM "CustomDomain"',
    );
  });

  it("does not re-point another project's domain", async () => {
    signIn(ATTACKER_PROJECT);

    const result = await makeProjectDomainPrimary(ATTACKER_PROJECT, VICTIM_DOMAIN);

    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(db.executeRaw).not.toHaveBeenCalled();
    expect(side.applyPrimaryRedirects).not.toHaveBeenCalled();
  });

  it("does not re-verify another project's domain", async () => {
    signIn(ATTACKER_PROJECT);

    const result = await checkProjectDomain(ATTACKER_PROJECT, VICTIM_DOMAIN);

    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(side.withRecordedJob).not.toHaveBeenCalled();
    expect(side.checkDomain).not.toHaveBeenCalled();
  });

  it("does not mail another project's verify token to an attacker-supplied address", async () => {
    signIn(ATTACKER_PROJECT);

    const result = await emailProjectDomain(ATTACKER_PROJECT, VICTIM_DOMAIN, 'attacker@evil.test');

    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(side.emailDomainInstructions).not.toHaveBeenCalled();
  });
});

describe('the workspace-wide domain listing withholds the verify token', () => {
  it('gives the owner the token and the TXT record', async () => {
    signIn(VICTIM_PROJECT);

    const result = await listProjectDomains(VICTIM_PROJECT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [domain] = result.data.domains;
    expect(domain?.verifyToken).toBe(VERIFY_TOKEN);
    expect(domain?.instructions.some((row) => row.value === VERIFY_TOKEN)).toBe(true);
  });

  it('lists the domain for a member who cannot mutate it, without the token', async () => {
    signIn(ATTACKER_PROJECT);

    const result = await listProjectDomains(VICTIM_PROJECT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [domain] = result.data.domains;
    expect(domain?.hostname).toBe('shop.victim.test');
    expect(domain?.verifyToken).toBe('');
    expect(domain?.instructions.map((row) => row.type)).toEqual(['CNAME']);
    expect(JSON.stringify(result.data)).not.toContain(VERIFY_TOKEN);
  });
});
