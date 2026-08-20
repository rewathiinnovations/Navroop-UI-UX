import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-228 — admin-supplied hosts were fetched with no validation beyond a `trim()`.
 *
 * `POST /api/integrations/coolify` handed the request body's `baseUrl` straight to `fetch`
 * and reflected the response status back in the error message, so an ADMIN could point it at
 * `http://169.254.169.254` and read cloud metadata, or walk internal ports. The Sentry DSN
 * verification did the same with the host inside a pasted DSN. `lib/security/url-guard` +
 * `safeFetch` exist for exactly this; the "trusted host" exemption covers the *configured*
 * Coolify, not a host typed into a form.
 */

const lookups = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock('@/lib/security/reject-log', () => ({
  logRejectedUrl: vi.fn(async () => ({ counted: false as const })),
  recordRejectedUrl: vi.fn(),
  SSRF_PRIVATE_REJECTS_KEY: 'ssrf.privateRejects',
}));
vi.mock('@/lib/db', () => ({ prisma: {} }));

const { CoolifyBaseUrlError, assertCoolifyBaseUrl } =
  await import('@/lib/integrations/coolify-connect.ts');
const { sendDsnVerificationEvent } = await import('@/lib/integrations/sentry-verify.ts');

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

beforeEach(() => {
  lookups.fn.mockReset();
});

describe('assertCoolifyBaseUrl', () => {
  it('refuses the cloud metadata address', async () => {
    await expect(assertCoolifyBaseUrl('http://169.254.169.254')).rejects.toBeInstanceOf(
      CoolifyBaseUrlError,
    );
  });

  it('refuses loopback and private ranges', async () => {
    for (const raw of [
      'http://127.0.0.1:8000',
      'http://localhost:8000',
      'http://10.1.2.3',
      'http://192.168.1.10:8000',
      'http://coolify.internal',
    ]) {
      await expect(assertCoolifyBaseUrl(raw), raw).rejects.toBeInstanceOf(CoolifyBaseUrlError);
    }
  });

  it('refuses a hostname whose DNS answer is private', async () => {
    await expect(
      assertCoolifyBaseUrl('https://coolify.example.com', {
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      }),
    ).rejects.toBeInstanceOf(CoolifyBaseUrlError);
  });

  it('refuses non-http protocols and embedded credentials', async () => {
    await expect(assertCoolifyBaseUrl('file:///etc/passwd')).rejects.toBeInstanceOf(
      CoolifyBaseUrlError,
    );
    await expect(
      assertCoolifyBaseUrl('https://user:pass@coolify.example.com', { lookup: publicLookup }),
    ).rejects.toBeInstanceOf(CoolifyBaseUrlError);
  });

  it('never puts the rejected address in the message', async () => {
    let message = '';
    try {
      await assertCoolifyBaseUrl('http://169.254.169.254');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('169.254');
  });

  it('accepts a public host and normalises it to an origin', async () => {
    expect(
      await assertCoolifyBaseUrl('https://coolify.example.com/api/v1/../', {
        lookup: publicLookup,
      }),
    ).toBe('https://coolify.example.com');
  });

  it('keeps a non-standard port, which a self-hosted Coolify needs', async () => {
    expect(
      await assertCoolifyBaseUrl('http://coolify.example.com:8000', { lookup: publicLookup }),
    ).toBe('http://coolify.example.com:8000');
  });
});

describe('sendDsnVerificationEvent', () => {
  it('refuses a DSN pointing at an internal host, without fetching it', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await sendDsnVerificationEvent('https://key@169.254.169.254/1');

      expect(result.ok).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sends to a public ingest host', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await sendDsnVerificationEvent('https://key@o1.ingest.sentry.io/456', {
        lookup: publicLookup,
      });

      expect(result.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = String(fetchMock.mock.calls[0]?.[0]);
      expect(url).toBe('https://o1.ingest.sentry.io/api/456/store/');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
