import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-213 — `upsertIntegration` merged `config` but replaced `secrets` wholesale, so every
 * caller that looked like a partial update was a total one. `sentry/start` writing
 * `{ clientSecret }` therefore destroyed the live `authToken`, `refreshToken` and
 * `tokenExpiresAt`, and the row dropped to PENDING: quota monitoring and heartbeats stopped
 * because an admin re-opened a form.
 *
 * F-214 — the first half of the Coolify and Cloudflare wizards wrote `status: 'PENDING'` and
 * the candidate token over the live row before the operator had picked a server or a zone.
 * The publish gate counts only CONNECTED, so pasting a token to re-check a connection took
 * publishing down workspace-wide, and `peekRootDomain` started returning null.
 *
 * Both are about the same thing: a write that claims to be partial must be partial, and
 * in-progress wizard state must not sit in the row that gates publishing.
 */

const state = vi.hoisted(() => ({
  row: null as null | Record<string, unknown>,
  upserts: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    integration: {
      findUnique: vi.fn(async () => state.row),
      upsert: vi.fn(
        async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
          const data = state.row ? args.update : args.create;
          state.upserts.push(data);
          state.row = {
            id: 'int_1',
            workspaceId: 'default',
            kind: 'COOLIFY',
            lastCheckedAt: null,
            lastError: null,
            connectedById: null,
            ...(state.row ?? {}),
            ...data,
          };
          return state.row;
        },
      ),
    },
    user: { findUnique: vi.fn(async () => ({ email: 'admin@example.com' })) },
  },
}));
vi.mock('@/lib/audit/log', () => ({ writeAudit: vi.fn(async () => undefined) }));

const { encryptSecretsBlob, readSecretsBlob } = await import('@/lib/integrations/secrets.ts');
const { IntegrationSecretsUnreadableError, upsertIntegration } =
  await import('@/lib/integrations/store.ts');
const { missingIntegrationKinds } = await import('@/lib/integrations/messages.ts');

beforeEach(() => {
  process.env.ENCRYPTION_KEY = 'the-original-encryption-key-32-bytes!!!!';
  state.row = null;
  state.upserts = [];
});

function seed(
  kind: string,
  status: string,
  secrets: Record<string, string>,
  config: Record<string, unknown> = {},
) {
  state.row = {
    id: 'int_1',
    workspaceId: 'default',
    kind,
    status,
    config,
    secrets: encryptSecretsBlob(secrets),
    lastCheckedAt: null,
    lastError: null,
    connectedById: null,
  };
}

function storedSecrets() {
  return readSecretsBlob(state.row?.secrets as string).secrets;
}

describe('upsertIntegration secrets semantics', () => {
  it('mergeSecrets keeps the credentials it was not given', async () => {
    seed('SENTRY', 'CONNECTED', {
      authToken: 'live-auth',
      refreshToken: 'live-refresh',
      tokenExpiresAt: '2026-09-01T00:00:00.000Z',
    });

    await upsertIntegration({
      kind: 'SENTRY',
      status: 'PENDING',
      mergeSecrets: { clientSecret: 'new-client-secret' },
    });

    expect(storedSecrets()).toEqual({
      authToken: 'live-auth',
      refreshToken: 'live-refresh',
      tokenExpiresAt: '2026-09-01T00:00:00.000Z',
      clientSecret: 'new-client-secret',
    });
  });

  it('secrets is still a total write, so erasing stays something a caller asks for', async () => {
    seed('SENTRY', 'CONNECTED', { authToken: 'live-auth', refreshToken: 'live-refresh' });

    await upsertIntegration({
      kind: 'SENTRY',
      status: 'CONNECTED',
      secrets: { authToken: 'replacement' },
    });

    expect(storedSecrets()).toEqual({ authToken: 'replacement' });
  });

  it('mergeSecrets removes exactly the keys set to undefined', async () => {
    seed('COOLIFY', 'CONNECTED', { token: 'live', pendingToken: 'candidate' });

    await upsertIntegration({
      kind: 'COOLIFY',
      status: 'CONNECTED',
      mergeSecrets: { pendingToken: undefined },
    });

    expect(storedSecrets()).toEqual({ token: 'live' });
  });

  it('refuses a partial write onto a blob it cannot read, rather than erasing it', async () => {
    seed('SENTRY', 'CONNECTED', { authToken: 'live-auth' });
    process.env.ENCRYPTION_KEY = 'a-different-encryption-key-32-bytes-min!!';

    await expect(
      upsertIntegration({
        kind: 'SENTRY',
        status: 'PENDING',
        mergeSecrets: { clientSecret: 'new' },
      }),
    ).rejects.toBeInstanceOf(IntegrationSecretsUnreadableError);
  });

  it('rejects a caller that passes both forms', async () => {
    await expect(
      upsertIntegration({
        kind: 'SENTRY',
        status: 'PENDING',
        secrets: { authToken: 'a' },
        mergeSecrets: { clientSecret: 'b' },
      }),
    ).rejects.toThrow(/either secrets .* or mergeSecrets/);
  });
});

describe('the Coolify connect wizard', () => {
  it('stages the candidate token and base URL without touching the live connection', async () => {
    const { stageCoolifyCandidate } = await import('@/lib/integrations/coolify-connect.ts');
    seed(
      'COOLIFY',
      'CONNECTED',
      { token: 'live-token' },
      { baseUrl: 'https://coolify.live.example', serverCount: 2 },
    );

    await stageCoolifyCandidate({
      baseUrl: 'https://coolify.new.example',
      token: 'candidate-token',
      userId: 'user_1',
    });

    expect(state.row?.status).toBe('CONNECTED');
    expect(storedSecrets()).toEqual({ token: 'live-token', pendingToken: 'candidate-token' });
    const config = state.row?.config as Record<string, unknown>;
    expect(config.baseUrl).toBe('https://coolify.live.example');
    expect(config.pendingBaseUrl).toBe('https://coolify.new.example');
  });

  it('leaves publishing unblocked while the wizard is open', async () => {
    const { stageCoolifyCandidate } = await import('@/lib/integrations/coolify-connect.ts');
    seed(
      'COOLIFY',
      'CONNECTED',
      { token: 'live-token' },
      { baseUrl: 'https://coolify.live.example' },
    );

    await stageCoolifyCandidate({
      baseUrl: 'https://coolify.new.example',
      token: 'candidate-token',
      userId: 'user_1',
    });

    expect(
      missingIntegrationKinds([
        { kind: 'GITHUB_DEPLOY', status: 'CONNECTED' },
        { kind: 'CLOUDFLARE', status: 'CONNECTED' },
        { kind: 'COOLIFY', status: state.row?.status as string },
      ]),
    ).toEqual([]);
  });

  it('still writes PENDING on a first-time connect, where there is nothing to protect', async () => {
    const { stageCoolifyCandidate } = await import('@/lib/integrations/coolify-connect.ts');

    await stageCoolifyCandidate({
      baseUrl: 'https://coolify.new.example',
      token: 'candidate-token',
      userId: 'user_1',
    });

    expect(state.row?.status).toBe('PENDING');
  });

  it('resolves the staged candidate in preference to the live values', async () => {
    const { coolifyWizardCredentials } = await import('@/lib/integrations/coolify-connect.ts');

    expect(
      coolifyWizardCredentials({
        config: { baseUrl: 'https://live', pendingBaseUrl: 'https://candidate' },
        secrets: { token: 'live', pendingToken: 'candidate' },
      }),
    ).toEqual({ baseUrl: 'https://candidate', token: 'candidate' });

    expect(
      coolifyWizardCredentials({
        config: { baseUrl: 'https://live' },
        secrets: { token: 'live' },
      }),
    ).toEqual({ baseUrl: 'https://live', token: 'live' });
  });
});

describe('the Cloudflare zone picker', () => {
  it('stages the candidate token without downgrading a live connection', async () => {
    const { stageCloudflareCandidate } = await import('@/lib/integrations/cloudflare-connect.ts');
    seed(
      'CLOUDFLARE',
      'CONNECTED',
      { token: 'live-token' },
      { zoneId: 'z1', zoneName: 'live.example' },
    );

    await stageCloudflareCandidate({ token: 'candidate-token', userId: 'user_1' });

    expect(state.row?.status).toBe('CONNECTED');
    expect(storedSecrets()).toEqual({ token: 'live-token', pendingToken: 'candidate-token' });
    expect((state.row?.config as Record<string, unknown>).zoneName).toBe('live.example');
  });
});
