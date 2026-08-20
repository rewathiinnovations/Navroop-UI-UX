import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `removeProjectDomain` keeps the row and reports the failure when the Coolify detach fails (F-222).
 *
 * It used to catch the detach error with a `console.warn`, delete the `CustomDomain` row anyway,
 * and write the `domain.remove` audit row as if the removal had succeeded. The hostname then
 * stayed served on Coolify with nothing naming it. The row is the surviving receipt.
 *
 * Goes red if: a failed detach still deletes the row, reports `ok: true`, or writes a
 * `domain.remove` audit entry.
 */

const db = vi.hoisted(() => ({
  projectFindFirst: vi.fn(),
  deploymentFindFirst: vi.fn(),
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
}));
const session = vi.hoisted(() => ({ user: vi.fn() }));
const side = vi.hoisted(() => ({
  removeDomainFromCoolify: vi.fn(),
  applyPrimaryRedirects: vi.fn(),
  writeAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    project: { findFirst: db.projectFindFirst },
    deployment: { findFirst: db.deploymentFindFirst },
    $queryRaw: db.queryRaw,
    $executeRaw: db.executeRaw,
  },
}));
vi.mock('@/lib/auth', () => ({ getSessionUser: session.user }));
vi.mock('@/lib/domains/cleanup', () => ({ removeDomainFromCoolify: side.removeDomainFromCoolify }));
vi.mock('@/lib/domains/redirects', () => ({ applyPrimaryRedirects: side.applyPrimaryRedirects }));
vi.mock('@/lib/domains/notify', () => ({ emailDomainInstructions: vi.fn() }));
vi.mock('@/lib/domains/verify', () => ({ checkDomain: vi.fn() }));
vi.mock('@/lib/domains/create', () => ({ createCustomDomain: vi.fn() }));
vi.mock('@/lib/jobs/wrap', () => ({ withRecordedJob: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ writeAudit: side.writeAudit }));
vi.mock('@/lib/integrations/store', () => ({ peekRootDomain: async () => 'navroop.test' }));
vi.mock('@/lib/plans/limits', () => ({ checkCustomDomainAllowed: async () => ({ ok: true }) }));

const { removeProjectDomain } = await import('@/lib/domains/actions.ts');

const PROJECT = 'proj_1';
const OWNER = 'user_1';
const DOMAIN = 'dom_1';

function domainRow() {
  return {
    id: DOMAIN,
    deploymentId: 'dep_1',
    workspaceId: 'ws_1',
    hostname: 'shop.client.test',
    status: 'ACTIVE',
    verifyToken: 'token',
    expectedTarget: 'acme.navroop.test',
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

beforeEach(() => {
  vi.clearAllMocks();
  session.user.mockResolvedValue({ id: OWNER, role: 'USER', email: 'owner@navroop.test' });
  db.projectFindFirst.mockResolvedValue({ id: PROJECT, ownerId: OWNER });
  db.deploymentFindFirst.mockResolvedValue({ id: 'dep_1', projectId: PROJECT });
  db.queryRaw.mockResolvedValue([domainRow()]);
  db.executeRaw.mockResolvedValue(1);
  side.removeDomainFromCoolify.mockResolvedValue(undefined);
});

describe('removeProjectDomain', () => {
  it('keeps the row and returns an actionable error when the detach fails', async () => {
    side.removeDomainFromCoolify.mockRejectedValue(new Error('Coolify unreachable'));

    const result = await removeProjectDomain(PROJECT, DOMAIN);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/coolify unreachable/i);
    expect(db.executeRaw).not.toHaveBeenCalled();
    expect(side.writeAudit).not.toHaveBeenCalled();
  });

  it('deletes the row and audits the removal when the detach succeeds', async () => {
    const result = await removeProjectDomain(PROJECT, DOMAIN);

    expect(result.ok).toBe(true);
    expect(db.executeRaw).toHaveBeenCalledTimes(1);
    expect(side.writeAudit).toHaveBeenCalledTimes(1);
  });
});
