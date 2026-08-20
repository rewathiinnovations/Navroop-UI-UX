import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-300/F-070: the write path stores enc:v1 ciphertext, never the raw provider
 * key — `last4` is still derived from the plaintext so the UI hint survives.
 * F-081: org-key mutations audit like personal ones, and an org key can be
 * deleted at all. F-072: legacy provider rows (deepseek and friends) are
 * listed and deletable even though they can no longer be created.
 */

const KEY_MATERIAL = ['api-key-actions', 'fixture-key-material', 'over-32-bytes-long'].join('-');
process.env.ENCRYPTION_KEY = KEY_MATERIAL;

type UpsertArgs = {
  where: Record<string, unknown>;
  create: { secret: string; last4: string; provider?: string; userId?: string };
  update: { secret: string; last4: string };
};

const db = vi.hoisted(() => ({
  personalUpserts: [] as UpsertArgs[],
  orgUpserts: [] as UpsertArgs[],
  personalDeletes: [] as Array<{ where: Record<string, unknown> }>,
  orgDeletes: [] as Array<{ where: Record<string, unknown> }>,
  personalRows: [] as Array<{ provider: string; last4: string }>,
  orgRows: [] as Array<{ provider: string; last4: string }>,
  personalExisting: null as { id: string } | null,
  orgExisting: null as { id: string } | null,
}));

const auth = vi.hoisted(() => ({
  user: { id: 'user-1', email: 'admin@navroop.local', role: 'ADMIN' },
}));

const audit = vi.hoisted(() => ({ writeAudit: vi.fn(async () => undefined) }));

vi.mock('@/lib/db', () => ({
  prisma: {
    apiKey: {
      findUnique: async () => db.personalExisting,
      findMany: async () => db.personalRows,
      upsert: async (args: UpsertArgs) => {
        db.personalUpserts.push(args);
        return {};
      },
      deleteMany: async (args: { where: Record<string, unknown> }) => {
        db.personalDeletes.push(args);
        return { count: 1 };
      },
    },
    orgApiKey: {
      findUnique: async () => db.orgExisting,
      findMany: async () => db.orgRows,
      upsert: async (args: UpsertArgs) => {
        db.orgUpserts.push(args);
        return {};
      },
      deleteMany: async (args: { where: Record<string, unknown> }) => {
        db.orgDeletes.push(args);
        return { count: 1 };
      },
    },
  },
}));

vi.mock('@/lib/auth', () => ({
  requireSessionUser: async () => ({ user: auth.user, error: null, status: 200 }),
  requireAdmin: async () =>
    auth.user.role === 'ADMIN'
      ? { user: auth.user, error: null, status: 200 }
      : { user: null, error: 'Admin access required', status: 403 },
}));

vi.mock('@/lib/audit/log', () => audit);

// Dynamic on purpose: the vi.mock calls above must register before the module
// under test resolves its own imports.
const {
  deleteApiKey,
  deleteOrgApiKey,
  listOrgApiKeys,
  listPersonalApiKeys,
  setOrgApiKey,
  setPersonalApiKey,
} = await import('@/lib/api-keys/actions');
const { decrypt, isEncrypted } = await import('@/lib/crypto');

const PLAINTEXT = ['fixture', 'provider', 'key', 'wxyz'].join('-');

beforeEach(() => {
  db.personalUpserts.length = 0;
  db.orgUpserts.length = 0;
  db.personalDeletes.length = 0;
  db.orgDeletes.length = 0;
  db.personalRows = [];
  db.orgRows = [];
  db.personalExisting = null;
  db.orgExisting = null;
  audit.writeAudit.mockClear();
});

describe('write paths encrypt (F-300/F-070)', () => {
  it('setPersonalApiKey stores enc:v1 ciphertext with last4 from the plaintext', async () => {
    const result = await setPersonalApiKey('firecrawl', PLAINTEXT);

    expect(result.ok).toBe(true);
    const upsert = db.personalUpserts[0];
    expect(isEncrypted(upsert.create.secret)).toBe(true);
    expect(decrypt(upsert.create.secret)).toBe(PLAINTEXT);
    expect(isEncrypted(upsert.update.secret)).toBe(true);
    expect(decrypt(upsert.update.secret)).toBe(PLAINTEXT);
    expect(upsert.create.last4).toBe(PLAINTEXT.slice(-4));
    expect(upsert.update.last4).toBe(PLAINTEXT.slice(-4));
  });

  it('setOrgApiKey stores enc:v1 ciphertext with last4 from the plaintext', async () => {
    const result = await setOrgApiKey('firecrawl', PLAINTEXT);

    expect(result.ok).toBe(true);
    const upsert = db.orgUpserts[0];
    expect(isEncrypted(upsert.create.secret)).toBe(true);
    expect(decrypt(upsert.create.secret)).toBe(PLAINTEXT);
    expect(upsert.create.last4).toBe(PLAINTEXT.slice(-4));
  });
});

describe('org keys audit and can be deleted (F-081)', () => {
  it('setOrgApiKey writes an api_key.add audit entry, without the secret', async () => {
    await setOrgApiKey('firecrawl', PLAINTEXT);

    expect(audit.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'api_key.add',
        targetType: 'org_api_key',
        targetId: 'firecrawl',
      }),
    );
    expect(JSON.stringify(audit.writeAudit.mock.calls)).not.toContain(PLAINTEXT);
  });

  it('setOrgApiKey audits a rotation when a row already exists', async () => {
    db.orgExisting = { id: 'org_1' };

    await setOrgApiKey('firecrawl', PLAINTEXT);

    expect(audit.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'api_key.rotate', targetType: 'org_api_key' }),
    );
  });

  it('deleteOrgApiKey removes the row and audits', async () => {
    const result = await deleteOrgApiKey('deepseek');

    expect(result.ok).toBe(true);
    expect(db.orgDeletes[0].where).toEqual({ provider: 'deepseek' });
    expect(audit.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'api_key.delete',
        targetType: 'org_api_key',
        targetId: 'deepseek',
      }),
    );
  });
});

describe('legacy provider rows are visible and deletable (F-072)', () => {
  it('deleteApiKey accepts a provider that is no longer offered', async () => {
    const result = await deleteApiKey('deepseek');

    expect(result.ok).toBe(true);
    expect(db.personalDeletes[0].where).toEqual({ userId: 'user-1', provider: 'deepseek' });
  });

  it('listPersonalApiKeys surfaces a leftover deepseek row as legacy', async () => {
    db.personalRows = [{ provider: 'deepseek', last4: 'ab12' }];

    const result = await listPersonalApiKeys();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const providers = result.data.keys.map((key) => key.provider);
    expect(providers).toContain('firecrawl');
    const legacy = result.data.keys.find((key) => key.provider === 'deepseek');
    expect(legacy).toMatchObject({ last4: 'ab12', legacy: true });
  });

  it('listOrgApiKeys surfaces a leftover org deepseek row as legacy', async () => {
    db.orgRows = [{ provider: 'deepseek', last4: 'cd34' }];

    const result = await listOrgApiKeys();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const legacy = result.data.keys.find((key) => key.provider === 'deepseek');
    expect(legacy).toMatchObject({ last4: 'cd34', legacy: true });
  });
});
