import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `notifyDomainFailed` reaches the project owner, not just the admins (F-263).
 *
 * The FAILED write and this send are deliberately coupled in `failDomain`, so this is the
 * only notification a user gets that their custom domain gave up — and it went to every
 * ADMIN and nobody else. Seven days after adding a hostname, the person holding the
 * registrar login heard nothing.
 *
 * Goes red if the owner or the publisher drops out of the recipient list, if one person who
 * holds all three roles gets three copies, or if the send stops being attempted at all.
 */

const db = vi.hoisted(() => ({
  appSettingUpsert: vi.fn(),
  deploymentFindUnique: vi.fn(),
  userFindMany: vi.fn(),
}));
const mail = vi.hoisted(() => ({ sendEmail: vi.fn() }));

vi.mock('@/lib/db', () => ({
  prisma: {
    appSetting: { upsert: db.appSettingUpsert },
    deployment: { findUnique: db.deploymentFindUnique },
    user: { findMany: db.userFindMany },
  },
}));
vi.mock('@/lib/email/client', () => ({ sendEmail: mail.sendEmail }));
vi.mock('@/lib/settings/app-url', () => ({ appPublicUrl: async () => 'https://navroop.test' }));

const { notifyDomainFailed } = await import('@/lib/domains/notify.ts');

const ROW = {
  id: 'dom_1',
  deploymentId: 'dep_1',
  workspaceId: 'ws_1',
  hostname: 'shop.client.test',
  status: 'FAILED' as const,
  verifyToken: 'tok',
  expectedTarget: '203.0.113.4',
  lastCheckedAt: null,
  lastError: 'TXT record not found',
  sslIssuedAt: null,
  isPrimary: false,
  path: 'A' as const,
  cloudflareZoneId: null,
  nameservers: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

function deployment(ownerEmail: string | null, publisherEmail: string | null) {
  return {
    projectId: 'proj_1',
    project: { name: 'Client shop', owner: { email: ownerEmail } },
    publishedBy: { email: publisherEmail },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.appSettingUpsert.mockResolvedValue({});
  mail.sendEmail.mockResolvedValue({ id: 'sent' });
});

const sentTo = () => mail.sendEmail.mock.calls.map((call) => call[0].to);

describe('notifyDomainFailed', () => {
  it('emails the project owner and the publisher alongside the admins', async () => {
    db.deploymentFindUnique.mockResolvedValue(
      deployment('owner@example.test', 'publisher@example.test'),
    );
    db.userFindMany.mockResolvedValue([{ email: 'admin@example.test' }]);

    await notifyDomainFailed(ROW);

    expect(sentTo()).toEqual([
      'owner@example.test',
      'publisher@example.test',
      'admin@example.test',
    ]);
  });

  it('sends one copy to a solo user who owns, published and administers', async () => {
    db.deploymentFindUnique.mockResolvedValue(deployment('solo@example.test', 'solo@example.test'));
    db.userFindMany.mockResolvedValue([{ email: 'solo@example.test' }]);

    await notifyDomainFailed(ROW);

    expect(sentTo()).toEqual(['solo@example.test']);
  });

  it('names the hostname, the reason and the page the user can act on', async () => {
    db.deploymentFindUnique.mockResolvedValue(deployment('owner@example.test', null));
    db.userFindMany.mockResolvedValue([]);

    await notifyDomainFailed(ROW);

    const [{ subject, text }] = mail.sendEmail.mock.calls[0];
    expect(subject).toContain('shop.client.test');
    expect(text).toContain('TXT record not found');
    expect(text).toContain('https://navroop.test/project/proj_1/domains');
  });

  it('is not exempt from the per-recipient email rate limit', async () => {
    // `emailClass: 'security'` exists so a password reset cannot be throttled away. A domain
    // that failed DNS is an operational notice and must not borrow that exemption.
    db.deploymentFindUnique.mockResolvedValue(deployment('owner@example.test', null));
    db.userFindMany.mockResolvedValue([]);

    await notifyDomainFailed(ROW);

    expect(mail.sendEmail.mock.calls[0][0].emailClass).toBeUndefined();
  });

  it('still records the failure and notifies the admins when the deployment row is gone', async () => {
    db.deploymentFindUnique.mockResolvedValue(null);
    db.userFindMany.mockResolvedValue([{ email: 'admin@example.test' }]);

    await notifyDomainFailed(ROW);

    expect(db.appSettingUpsert).toHaveBeenCalledTimes(1);
    expect(sentTo()).toEqual(['admin@example.test']);
  });

  it('records the failure even when nobody is reachable', async () => {
    db.deploymentFindUnique.mockResolvedValue(deployment(null, null));
    db.userFindMany.mockResolvedValue([]);

    await notifyDomainFailed(ROW);

    expect(db.appSettingUpsert).toHaveBeenCalledTimes(1);
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });
});
