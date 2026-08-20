import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A resolver failure is not evidence that the customer's DNS is wrong (F-219).
 *
 * All three resolvers used to swallow every error and return `[]`, so SERVFAIL, a timeout or a
 * container with no resolver read exactly like "the record does not exist". `checkDomain` then
 * wrote `TXT … is missing`, kept the row in PENDING_DNS, and after seven days the pre-lookup
 * expiry check marked it FAILED and emailed every admin — for DNS that may be perfectly correct.
 *
 * Goes red if: a failed lookup produces a mismatch sentence, reaches the FAILED verdict, fires
 * `notifyDomainFailed`, or stops throwing (the throw is what makes the cron run red instead of
 * reporting a healthy check).
 */

const store = vi.hoisted(() => ({
  findCustomDomain: vi.fn(),
  updateCustomDomain: vi.fn(),
  listCustomDomainsForDeployment: vi.fn(),
  clearPrimaryForDeployment: vi.fn(),
}));
const notify = vi.hoisted(() => ({ notifyDomainFailed: vi.fn() }));

vi.mock('@/lib/db', () => ({ prisma: { deployment: { findUnique: vi.fn() } } }));
vi.mock('@/lib/coolify/servers', () => ({
  serverAuth: () => ({ baseUrl: 'https://coolify.test', token: 'stub' }),
}));
vi.mock('@/lib/coolify/client', () => ({
  addApplicationDomain: vi.fn(),
  getApplication: vi.fn(),
  applicationListsHostname: vi.fn(() => false),
}));
vi.mock('@/lib/domains/ssl', () => ({
  probeHostnameCertificate: vi.fn(async () => ({ status: 'unavailable', reason: 'stubbed' })),
}));
vi.mock('@/lib/domains/redirects', () => ({ applyPrimaryRedirects: vi.fn() }));
vi.mock('@/lib/domains/notify', () => ({ notifyDomainFailed: notify.notifyDomainFailed }));
vi.mock('@/lib/domains/store', () => ({
  findCustomDomain: store.findCustomDomain,
  updateCustomDomain: store.updateCustomDomain,
  listCustomDomainsForDeployment: store.listCustomDomainsForDeployment,
  clearPrimaryForDeployment: store.clearPrimaryForDeployment,
}));

const { checkDomain } = await import('@/lib/domains/verify.ts');
const { DomainCheckUnavailableError } = await import('@/lib/domains/errors.ts');

const NOW = new Date('2026-08-20T12:00:00.000Z');
const CREATED = new Date('2026-08-10T12:00:00.000Z'); // 10 days old: past the 7-day expiry
const TOKEN = 'verify-token-value';

let row: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  row = {
    id: 'dom_1',
    deploymentId: 'dep_1',
    workspaceId: 'ws_1',
    hostname: 'shop.client.test',
    status: 'PENDING_DNS',
    verifyToken: TOKEN,
    expectedTarget: 'acme.navroop.test',
    lastCheckedAt: null,
    lastError: null,
    sslIssuedAt: null,
    isPrimary: false,
    path: 'A',
    cloudflareZoneId: null,
    nameservers: null,
    createdAt: CREATED,
  };
  store.findCustomDomain.mockImplementation(async () => ({ ...row }));
  store.updateCustomDomain.mockImplementation(
    async (_id: string, data: Record<string, unknown>) => {
      row = { ...row, ...data };
      return { ...row };
    },
  );
  store.listCustomDomainsForDeployment.mockResolvedValue([]);
});

function writes() {
  return store.updateCustomDomain.mock.calls.map((call) => call[1] as Record<string, unknown>);
}

describe('checkDomain with a resolver that fails', () => {
  it('does not blame the customer and does not reach FAILED past the 7-day mark', async () => {
    const dns = {
      resolveTxt: vi.fn(async () => ({ status: 'failed' as const, reason: 'SERVFAIL' })),
      resolve4: vi.fn(async () => ({ status: 'failed' as const, reason: 'SERVFAIL' })),
      resolveCname: vi.fn(async () => ({ status: 'failed' as const, reason: 'SERVFAIL' })),
    };

    await expect(checkDomain('dom_1', { dns, now: NOW })).rejects.toBeInstanceOf(
      DomainCheckUnavailableError,
    );

    const statuses = writes().map((data) => data.status);
    expect(statuses).not.toContain('FAILED');
    expect(notify.notifyDomainFailed).not.toHaveBeenCalled();

    const errorsWritten = writes()
      .map((data) => data.lastError)
      .filter((value): value is string => typeof value === 'string');
    expect(errorsWritten.length).toBeGreaterThan(0);
    for (const message of errorsWritten) {
      expect(message).not.toMatch(/is missing|does not match/i);
      expect(message).toMatch(/could not/i);
      expect(message).toContain('SERVFAIL');
    }
  });

  it('still fails the domain when the resolver really answered "no such record"', async () => {
    const dns = {
      resolveTxt: vi.fn(async () => ({ status: 'no-records' as const })),
      resolve4: vi.fn(async () => ({ status: 'no-records' as const })),
      resolveCname: vi.fn(async () => ({ status: 'no-records' as const })),
    };

    const result = await checkDomain('dom_1', { dns, now: NOW });

    expect(result.status).toBe('FAILED');
    expect(notify.notifyDomainFailed).toHaveBeenCalledTimes(1);
  });

  it('reports a mismatch, not an outage, when the records exist but are wrong', async () => {
    const dns = {
      resolveTxt: vi.fn(async () => ({ status: 'records' as const, records: [[TOKEN]] })),
      resolveCname: vi.fn(async () => ({
        status: 'records' as const,
        records: ['other.navroop.test'],
      })),
      resolve4: vi.fn(async () => ({ status: 'no-records' as const })),
    };
    row.createdAt = new Date('2026-08-20T11:00:00.000Z'); // fresh: expiry must not apply

    const result = await checkDomain('dom_1', { dns, now: NOW });

    expect(result.status).toBe('PENDING_DNS');
    expect(result.lastError).toContain('other.navroop.test');
    expect(notify.notifyDomainFailed).not.toHaveBeenCalled();
  });
});
