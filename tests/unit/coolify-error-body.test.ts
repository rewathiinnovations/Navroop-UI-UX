import { afterEach, describe, expect, it, vi } from 'vitest';
import { setBasicAuth, testServerConnection, type CoolifyServerAuth } from '@/lib/coolify/client';
import { CoolifyApiError, coolifyErrorMessage } from '@/lib/coolify/errors';
import { scrubSensitive } from '@/lib/sentry/scrub';

/**
 * What of a Coolify response body is allowed to become a sentence a user reads.
 *
 * `coolifyErrorMessage` used to fall back to `JSON.stringify(body)`. That string becomes
 * `CoolifyApiError.message`, which `runPublishJob` writes to `Job.errorMessage` and
 * `Deployment.lastError`, which `serializeDeployment` hands to any viewer of the publish
 * sheet and `/deployments`. The publish payload carries `PREVIEW_PASSWORD` on the env-var
 * path and basic-auth credentials on the create path, so a validation error whose body
 * echoes the submitted application is a route for those into a user-facing string and the
 * audit trail (F-229).
 *
 * Only the provider's own string-valued `message`/`error`/`errors[0]` survives now, and
 * the structured body is scrubbed of credential-shaped keys before it leaves the client.
 */

const SERVER: CoolifyServerAuth = {
  apiUrl: 'https://coolify.example.test',
  // Short and unpadded, so `tokenForServer` passes it through instead of calling decrypt.
  apiToken: 'plain-token',
};

// Assembled rather than written out: a literal long enough to look like a credential trips
// the repository secret scanner even inside a test.
const PASSWORD = ['pw', '1'].join('-');
const TOKEN = ['test', 'key'].join('-');

const FALLBACK = 'Coolify 422 /api/v1/applications/app-1';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('coolifyErrorMessage', () => {
  it('keeps the provider sentence when the body names one', () => {
    expect(coolifyErrorMessage({ message: '  Validation failed.  ' }, FALLBACK)).toBe(
      'Validation failed.',
    );
    expect(coolifyErrorMessage({ error: 'Server is unreachable.' }, FALLBACK)).toBe(
      'Server is unreachable.',
    );
    expect(coolifyErrorMessage({ errors: ['The domain is taken.', 'x'] }, FALLBACK)).toBe(
      'The domain is taken.',
    );
  });

  it('collapses a multi-line sentence and caps its length', () => {
    expect(coolifyErrorMessage({ message: 'Line one.\n\t Line two.' }, FALLBACK)).toBe(
      'Line one. Line two.',
    );

    const long = coolifyErrorMessage({ message: 'x'.repeat(900) }, FALLBACK);
    expect(long.length).toBeLessThanOrEqual(300);
    expect(long.endsWith('…')).toBe(true);
  });

  it('never serialises an object body, so an echoed payload cannot become the message', () => {
    const body = {
      name: 'deploy-app-1',
      http_basic_auth_password: PASSWORD,
      env: [{ key: 'PREVIEW_PASSWORD', value: PASSWORD }],
    };

    const message = coolifyErrorMessage(body, FALLBACK);

    expect(message).toBe(FALLBACK);
    expect(message).not.toContain(PASSWORD);
    expect(message).not.toContain('http_basic_auth_password');
  });

  it('never serialises a bare array or a non-string message field', () => {
    expect(coolifyErrorMessage([{ field: 'domain' }], FALLBACK)).toBe(FALLBACK);
    expect(coolifyErrorMessage({ message: { nested: PASSWORD } }, FALLBACK)).toBe(FALLBACK);
    expect(coolifyErrorMessage({ errors: [{ domain: PASSWORD }] }, FALLBACK)).toBe(FALLBACK);
  });

  it('falls back for a body that is not JSON at all', () => {
    // A gateway HTML page is not a provider sentence. The fallback already names the
    // status and the path, and the raw text stays on `CoolifyApiError.body`.
    expect(coolifyErrorMessage('<html><body>502 Bad Gateway</body></html>', FALLBACK)).toBe(
      FALLBACK,
    );
    expect(coolifyErrorMessage(null, FALLBACK)).toBe(FALLBACK);
  });
});

/**
 * These assertions moved from `scrubCoolifyBody` to `scrubSensitive` (F-684). This
 * module used to carry its own redactor with its own `[redacted]` marker; the two rules
 * that were only here — the wider credential names and the `{ key, value }` env-pair
 * case — are in `lib/sentry/scrub.ts` now, so the logger and the audit log redact them
 * too. The marker is the shared `[Filtered]`; the coverage is the same or stronger.
 */
describe('the shared redactor, on the Coolify bodies this client returns', () => {
  it('redacts credential-shaped keys recursively, arrays included', () => {
    const body = {
      name: 'deploy-app-1',
      http_basic_auth_password: PASSWORD,
      settings: { api_key: TOKEN, Authorization: `Bearer ${TOKEN}`, ports_exposes: '3000' },
      servers: [{ uuid: 'srv-1', private_key: TOKEN }],
    };

    expect(scrubSensitive(body)).toEqual({
      name: 'deploy-app-1',
      http_basic_auth_password: '[Filtered]',
      settings: { api_key: '[Filtered]', Authorization: '[Filtered]', ports_exposes: '3000' },
      servers: [{ uuid: 'srv-1', private_key: '[Filtered]' }],
    });
  });

  it('redacts the value of a credential-shaped env pair, where the name is the value', () => {
    expect(
      scrubSensitive([
        { key: 'PREVIEW_PASSWORD', value: PASSWORD },
        { key: 'PORT', value: '3000' },
      ]),
    ).toEqual([
      { key: 'PREVIEW_PASSWORD', value: '[Filtered]' },
      { key: 'PORT', value: '3000' },
    ]);
  });

  it('leaves the caller a copy and never mutates the original', () => {
    const body = { token: TOKEN };
    const scrubbed = scrubSensitive(body);

    expect(scrubbed).toEqual({ token: '[Filtered]' });
    expect(body.token).toBe(TOKEN);
  });

  it('passes primitives and null through', () => {
    expect(scrubSensitive(null)).toBeNull();
    expect(scrubSensitive('Unauthenticated.')).toBe('Unauthenticated.');
    expect(scrubSensitive(422)).toBe(422);
  });
});

describe('at the wire', () => {
  it('keeps an echoed basic-auth password out of the thrown error message', async () => {
    vi.stubGlobal('fetch', async () =>
      Response.json({ name: 'deploy-app-1', http_basic_auth_password: PASSWORD }, { status: 422 }),
    );

    const thrown = await setBasicAuth(SERVER, 'app-1', {
      username: 'preview',
      password: PASSWORD,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(CoolifyApiError);
    const error = thrown as CoolifyApiError;
    expect(error.message).not.toContain(PASSWORD);
    expect(error.message).toBe('Coolify 422 /api/v1/applications/app-1');
    // The structured body stays on the error for server-side logging.
    expect(error.body).toMatchObject({ http_basic_auth_password: PASSWORD });
  });

  it('scrubs the body it hands back to the admin connection test', async () => {
    vi.stubGlobal('fetch', async () =>
      Response.json({ message: 'Unauthenticated.', token: TOKEN }, { status: 401 }),
    );

    await expect(testServerConnection(SERVER)).resolves.toEqual({
      ok: false,
      status: 401,
      error: 'Unauthenticated.',
      body: { message: 'Unauthenticated.', token: '[Filtered]' },
    });
  });
});
