import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-212 — an integration row whose secrets blob cannot be decrypted used to read as
 * CONNECTED with `secrets: {}`.
 *
 * `decryptSecretsBlob` swallowed every decrypt failure and returned `{}`, so a rotated
 * `ENCRYPTION_KEY` produced a row that said CONNECTED and carried no credentials. The
 * publish gate looked only at `status`, so it passed; the failure then surfaced deep inside
 * a running publish as "GitHub is not connected" — advice the admin could see was already
 * done, on a screen showing three green pills.
 *
 * "No secrets stored" and "stored secrets could not be read on this instance" are different
 * answers. These tests pin that distinction end to end: the blob reader, the row, the
 * publish gate, the operator-facing message, and the two provider credential helpers.
 */

const ROTATED_KEY = 'a-different-encryption-key-32-bytes-min!!';
const ORIGINAL_KEY = 'the-original-encryption-key-32-bytes!!!!';

const db = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    integration: { findUnique: db.findUnique, findMany: db.findMany },
    workspace: { findUnique: vi.fn(async () => null) },
  },
}));

const { SECRETS_UNREADABLE_MESSAGE, encryptSecretsBlob, readSecretsBlob } =
  await import('@/lib/integrations/secrets.ts');
const { getIntegration, getMissingIntegrations, getPublishReadiness } =
  await import('@/lib/integrations/store.ts');
const { missingIntegrationKinds, publishBlockedMessage } =
  await import('@/lib/integrations/messages.ts');
const { publicIntegration } = await import('@/lib/integrations/public.ts');

/** A blob that is genuine `enc:v1:` ciphertext this instance's key cannot open. */
function unreadableBlob() {
  const previous = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
  const blob = encryptSecretsBlob({ token: 'cf-live' });
  process.env.ENCRYPTION_KEY = previous;
  return blob;
}

let blob = '';

beforeEach(() => {
  process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
  blob = unreadableBlob();
  process.env.ENCRYPTION_KEY = ROTATED_KEY;
  db.findUnique.mockReset();
  db.findMany.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'int_1',
    workspaceId: 'default',
    kind: 'CLOUDFLARE',
    status: 'CONNECTED',
    config: { zoneId: 'z1', zoneName: 'example.com' },
    secrets: blob,
    lastCheckedAt: null,
    lastError: null,
    connectedById: null,
    ...overrides,
  };
}

describe('readSecretsBlob', () => {
  it('reports an undecryptable blob as unreadable, not as empty', () => {
    const result = readSecretsBlob(blob);
    expect(result.unreadable).toBe(true);
    expect(result.secrets).toEqual({});
  });

  it('reports an absent blob as readable and empty', () => {
    expect(readSecretsBlob(null)).toEqual({ secrets: {}, unreadable: false });
    expect(readSecretsBlob('')).toEqual({ secrets: {}, unreadable: false });
  });

  it('round-trips a blob written under this instance key', () => {
    process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
    const result = readSecretsBlob(blob);
    expect(result).toEqual({ secrets: { token: 'cf-live' }, unreadable: false });
  });

  it('never puts the ciphertext or the key in the operator message', () => {
    expect(SECRETS_UNREADABLE_MESSAGE).not.toContain(blob);
    expect(SECRETS_UNREADABLE_MESSAGE).not.toContain(ROTATED_KEY);
    expect(SECRETS_UNREADABLE_MESSAGE).toMatch(/encryption key/i);
  });
});

describe('getIntegration', () => {
  it('marks the row unusable instead of handing back a CONNECTED row with no credentials', async () => {
    db.findUnique.mockResolvedValue(row());

    const loaded = await getIntegration('default', 'CLOUDFLARE');

    expect(loaded?.status).toBe('CONNECTED');
    expect(loaded?.secretsUnreadable).toBe(true);
    expect(loaded?.secrets).toEqual({});
  });

  it('leaves a genuinely empty secrets column readable', async () => {
    db.findUnique.mockResolvedValue(row({ secrets: null }));

    const loaded = await getIntegration('default', 'CLOUDFLARE');

    expect(loaded?.secretsUnreadable).toBe(false);
  });
});

describe('the publish gate', () => {
  it('counts a CONNECTED row whose secrets cannot be read as missing', () => {
    expect(
      missingIntegrationKinds([
        { kind: 'GITHUB_DEPLOY', status: 'CONNECTED' },
        { kind: 'CLOUDFLARE', status: 'CONNECTED', secretsUnreadable: true },
        { kind: 'COOLIFY', status: 'CONNECTED' },
      ]),
    ).toEqual(['CLOUDFLARE']);
  });

  it('refuses with the key-mismatch message, not "is not connected"', async () => {
    db.findMany.mockResolvedValue([
      { kind: 'GITHUB_DEPLOY', status: 'CONNECTED', secrets: null },
      { kind: 'CLOUDFLARE', status: 'CONNECTED', secrets: blob },
      { kind: 'COOLIFY', status: 'CONNECTED', secrets: null },
    ]);

    const readiness = await getPublishReadiness('default');

    expect(readiness.unreadable).toEqual(['CLOUDFLARE']);
    expect(readiness.missing).toEqual(['CLOUDFLARE']);
    const message = publishBlockedMessage(readiness.missing, true, readiness.unreadable);
    expect(message).toContain(SECRETS_UNREADABLE_MESSAGE);
    expect(message).not.toContain('is not connected');
  });

  it('still says "is not connected" when the row really is not connected', async () => {
    db.findMany.mockResolvedValue([
      { kind: 'GITHUB_DEPLOY', status: 'CONNECTED', secrets: null },
      { kind: 'CLOUDFLARE', status: 'PENDING', secrets: null },
      { kind: 'COOLIFY', status: 'CONNECTED', secrets: null },
    ]);

    const readiness = await getPublishReadiness('default');

    expect(readiness.unreadable).toEqual([]);
    expect(publishBlockedMessage(readiness.missing, true, readiness.unreadable)).toBe(
      'Cloudflare is not connected',
    );
  });

  it('keeps the member-facing copy for a non-admin whatever the reason', async () => {
    expect(publishBlockedMessage(['CLOUDFLARE'], false, ['CLOUDFLARE'])).toBe(
      'Ask an admin to finish setup',
    );
  });

  it('getMissingIntegrations still answers with the kinds alone', async () => {
    db.findMany.mockResolvedValue([
      { kind: 'GITHUB_DEPLOY', status: 'CONNECTED', secrets: null },
      { kind: 'CLOUDFLARE', status: 'CONNECTED', secrets: blob },
      { kind: 'COOLIFY', status: 'CONNECTED', secrets: null },
    ]);

    expect(await getMissingIntegrations('default')).toEqual(['CLOUDFLARE']);
  });
});

describe('/admin/integrations', () => {
  it('shows a red Error pill rather than a green Connected one', () => {
    const view = publicIntegration(
      {
        id: 'int_1',
        workspaceId: 'default',
        kind: 'CLOUDFLARE',
        status: 'CONNECTED',
        config: { zoneName: 'example.com' },
        secrets: {},
        secretsUnreadable: true,
        lastCheckedAt: null,
        lastError: null,
        connectedById: null,
      },
      'CLOUDFLARE',
    );

    expect(view.status).toBe('ERROR');
    expect(view.statusLabel).toBe('Error');
    expect(view.lastError).toBe(SECRETS_UNREADABLE_MESSAGE);
  });
});

describe('the provider credential helpers', () => {
  it('Cloudflare says the credentials cannot be read, not that it is not connected', async () => {
    db.findUnique.mockResolvedValue(row());
    const { listZoneARecords } = await import('@/lib/cloudflare/dns.ts');

    await expect(listZoneARecords('default')).rejects.toThrow(SECRETS_UNREADABLE_MESSAGE);
  });

  it('GitHub says the credentials cannot be read, not "Connect GitHub"', async () => {
    db.findUnique.mockResolvedValue(
      row({
        kind: 'GITHUB_DEPLOY',
        config: { appId: 123, installationId: '77', org: 'acme' },
      }),
    );
    const { getInstallationToken } = await import('@/lib/github/deploy-client.ts');

    await expect(getInstallationToken('default')).rejects.toThrow(SECRETS_UNREADABLE_MESSAGE);
  });
});
