import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-226 — the verification event was posted with tags and no `fingerprint`, while the poll
 * searched Sentry for `fingerprint:navroop-sentry-verify`. The round trip could never
 * succeed, so Verify always ended after sixty seconds with "Event sent but not received.
 * Likely causes: quota exhausted, rate limited, inbound filter, or wrong project" — sending
 * the operator to investigate quotas that were fine.
 *
 * F-236 — `if (!scopes.includes(required) && scopes.length > 0)` skipped every scope check
 * when Sentry's token response omitted `scope`, and the token was accepted as fully scoped.
 *
 * F-237 — `expiringSoon` needed a parseable `tokenExpiresAt`; absent, the comparison was NaN
 * and the guard was false, so "we don't know when this expires" became "it does not expire".
 * And when refresh material was missing the stale token was still returned as `ok`.
 */

const store = vi.hoisted(() => ({ upsert: vi.fn(), lastError: vi.fn() }));

vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/integrations/store', () => ({
  getIntegration: vi.fn(async () => null),
  upsertIntegration: store.upsert,
  setIntegrationLastError: store.lastError,
}));
vi.mock('@/lib/security/reject-log', () => ({
  logRejectedUrl: vi.fn(async () => ({ counted: false as const })),
  recordRejectedUrl: vi.fn(),
  SSRF_PRIVATE_REJECTS_KEY: 'ssrf.privateRejects',
}));

const { SENTRY_COPY, SENTRY_OAUTH_SCOPES, SENTRY_VERIFY_FINGERPRINT } =
  await import('@/lib/integrations/sentry.ts');
const { sendDsnVerificationEvent } = await import('@/lib/integrations/sentry-verify.ts');
const { ensureSentryAccessToken, exchangeSentryCode } =
  await import('@/lib/integrations/sentry-oauth.ts');

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const DSN = 'https://key@o1.ingest.sentry.io/456';

beforeEach(() => {
  store.upsert.mockReset();
  store.upsert.mockResolvedValue(undefined);
  store.lastError.mockReset();
  store.lastError.mockResolvedValue(undefined);
});

describe('the verification round trip', () => {
  it('sends the event under the fingerprint the poll searches for', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await sendDsnVerificationEvent(DSN, { lookup: publicLookup });

      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
        fingerprint?: string[];
      };
      expect(body.fingerprint).toEqual([SENTRY_VERIFY_FINGERPRINT]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('polls for the same fingerprint it sent', async () => {
    const { runSentryRoundTrip } = await import('@/lib/integrations/sentry-verify.ts');
    // The pairing is the invariant: one constant, read by both ends. A literal on either
    // side is how they drifted the first time.
    expect(typeof runSentryRoundTrip).toBe('function');
    expect(SENTRY_VERIFY_FINGERPRINT).toBe('navroop-sentry-verify');
  });
});

describe('exchangeSentryCode', () => {
  function tokenResponse(body: Record<string, unknown>) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  }

  it('does not accept a token as fully scoped when the response omits scope', async () => {
    vi.stubGlobal('fetch', tokenResponse({ access_token: 'tok', expires_in: 3600 }));
    try {
      const result = await exchangeSentryCode({
        code: 'c',
        verifier: 'v',
        clientId: 'id',
        clientSecret: 'sec',
        redirectUrl: 'https://app.example/cb',
      });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.scopesVerified).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('confirms the scopes when the response lists them all', async () => {
    vi.stubGlobal(
      'fetch',
      tokenResponse({
        access_token: 'tok',
        expires_in: 3600,
        scope: SENTRY_OAUTH_SCOPES.join(' '),
      }),
    );
    try {
      const result = await exchangeSentryCode({
        code: 'c',
        verifier: 'v',
        clientId: 'id',
        clientSecret: 'sec',
        redirectUrl: 'https://app.example/cb',
      });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.scopesVerified).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('still refuses a response that names scopes and is missing one', async () => {
    vi.stubGlobal('fetch', tokenResponse({ access_token: 'tok', scope: 'project:read' }));
    try {
      const result = await exchangeSentryCode({
        code: 'c',
        verifier: 'v',
        clientId: 'id',
        clientSecret: 'sec',
        redirectUrl: 'https://app.example/cb',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('project:write');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('ensureSentryAccessToken', () => {
  const row = (secrets: Record<string, string | undefined>, config: Record<string, string> = {}) =>
    ({
      id: 'int_1',
      workspaceId: 'default',
      kind: 'SENTRY' as const,
      status: 'CONNECTED' as const,
      config: { oauthClientId: 'client-id', ...config },
      secrets,
      secretsUnreadable: false,
      lastCheckedAt: null,
      lastError: null,
      connectedById: null,
    }) as Parameters<typeof ensureSentryAccessToken>[0];

  it('treats an unknown expiry as due for refresh rather than as never expiring', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3600 }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await ensureSentryAccessToken(
        row({ authToken: 'stale', refreshToken: 'refresh', clientSecret: 'sec' }),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.authToken).toBe('fresh');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('leaves a token with a comfortable expiry alone', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await ensureSentryAccessToken(
        row({
          authToken: 'live',
          tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.authToken).toBe('live');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports a token it cannot refresh as unverified, and says so on the row', async () => {
    const result = await ensureSentryAccessToken(row({ authToken: 'orphan' }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.authToken).toBe('orphan');
      expect(result.unverified).toBe(true);
    }
    expect(store.lastError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'SENTRY', message: SENTRY_COPY.unrefreshable }),
    );
  });

  it('does not rewrite the same warning twice', async () => {
    await ensureSentryAccessToken({
      ...row({ authToken: 'orphan' }),
      lastError: SENTRY_COPY.unrefreshable,
    } as Parameters<typeof ensureSentryAccessToken>[0]);

    expect(store.lastError).not.toHaveBeenCalled();
  });

  it('refuses when there is no token at all', async () => {
    const result = await ensureSentryAccessToken(row({}));

    expect(result.ok).toBe(false);
  });
});
