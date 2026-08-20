import { describe, expect, it } from 'vitest';

import { scrubSensitive } from '@/lib/sentry/scrub';

/**
 * F-684 — "one redactor, three destinations". Wave 4 made `lib/sentry/scrub.ts` the
 * single implementation behind the logger, the audit log and the Sentry pipeline, so
 * three of the four are already converged. `lib/coolify/errors.ts` was the fourth: a
 * second, independently written key matcher with a *broader* pattern list than the
 * shared one.
 *
 * That divergence was the actual defect, not the missing abstraction. `CREDENTIAL_KEY`
 * in the Coolify module matched `authorization`, `auth`, `credential` and `passwd`;
 * the shared `SENSITIVE_KEY` matched only `token|secret|password|key|pem`. So a field
 * the Coolify path redacted was written in the clear by `log.info` and by the audit
 * log — the two destinations whose output is retained longest.
 *
 * These tests pin the union: whatever either matcher redacted, the shared one redacts.
 */

const FILTERED = '[Filtered]';

/** Short on purpose: the repo's secret scanner rejects long credential-shaped literals. */
const RAW = 'abc123xyz';

describe('the shared redactor covers every credential key name', () => {
  // The four names the Coolify matcher caught and the shared one did not. None of
  // them contains `token`, `secret`, `password`, `key` or `pem` as a substring, so
  // none was matched by name; `authorization` only survived by accident when its
  // value happened to start with "Bearer ".
  for (const key of ['authorization', 'Authorization', 'auth', 'credential', 'passwd']) {
    it(`redacts a field named ${key} holding a bare value`, () => {
      const scrubbed = scrubSensitive({ [key]: RAW }) as Record<string, unknown>;
      expect(scrubbed[key]).toBe(FILTERED);
    });
  }

  for (const key of ['http_basic_auth_password', 'x-api-key', 'private_key']) {
    it(`redacts the compound name ${key}`, () => {
      const scrubbed = scrubSensitive({ [key]: RAW }) as Record<string, unknown>;
      expect(scrubbed[key]).toBe(FILTERED);
    });
  }

  it('still leaves an unremarkable field alone', () => {
    const scrubbed = scrubSensitive({ projectId: 'p-1', authorName: 'Ada' }) as Record<
      string,
      unknown
    >;
    expect(scrubbed.projectId).toBe('p-1');
    // `authorName` contains "auth" but names a person, and over-redacting a whole
    // field because of a substring makes logs unreadable. Word-boundary matching is
    // what separates this from `auth`.
    expect(scrubbed.authorName).toBe('Ada');
  });
});

describe('the shared redactor knows the {key,value} env-pair shape', () => {
  // An environment variable arrives as `{ key: 'PREVIEW_PASSWORD', value: '…' }`. The
  // credential name is in the *sibling* `key`, so a matcher that only looks at the
  // property name sees a field called `value` and lets it through. The Coolify module
  // had this rule; the shared redactor did not, and it is the shape Coolify env
  // payloads actually use.
  it('redacts value when its sibling key names a credential', () => {
    const scrubbed = scrubSensitive({ key: 'PREVIEW_PASSWORD', value: RAW }) as Record<
      string,
      unknown
    >;
    expect(scrubbed.value).toBe(FILTERED);
  });

  it('leaves value alone when the sibling key is not a credential', () => {
    const scrubbed = scrubSensitive({ key: 'NODE_ENV', value: 'production' }) as Record<
      string,
      unknown
    >;
    expect(scrubbed.value).toBe('production');
  });

  it('applies inside arrays of env pairs, which is how they arrive', () => {
    const scrubbed = scrubSensitive([
      { key: 'NODE_ENV', value: 'production' },
      { key: 'SMTP_PASSWORD', value: RAW },
    ]) as Array<Record<string, unknown>>;
    expect(scrubbed[0].value).toBe('production');
    expect(scrubbed[1].value).toBe(FILTERED);
  });
});

describe('the Coolify body path now goes through the one redactor', () => {
  // `scrubCoolifyBody` is gone: it was a second implementation, and after its two
  // extra rules moved into `lib/sentry/scrub.ts` it had nothing left to add.
  // `lib/coolify/client.ts` calls `scrubSensitive` directly.
  const body = {
    uuid: 'srv-1',
    authorization: RAW,
    settings: { http_basic_auth_password: RAW, name: 'prod' },
    envs: [{ key: 'PREVIEW_PASSWORD', value: RAW }],
  };

  it('redacts everything the Coolify-only matcher used to redact', () => {
    const scrubbed = scrubSensitive(body) as typeof body;
    expect(scrubbed.authorization).toBe(FILTERED);
    expect(scrubbed.settings.http_basic_auth_password).toBe(FILTERED);
    expect(scrubbed.envs[0].value).toBe(FILTERED);
    expect(scrubbed.uuid).toBe('srv-1');
    expect(scrubbed.settings.name).toBe('prod');
  });

  it('keeps the env variable name, so the log still says which one was redacted', () => {
    const scrubbed = scrubSensitive(body) as typeof body;
    expect(scrubbed.envs[0].key).toBe('PREVIEW_PASSWORD');
  });

  it('leaves the caller object untouched', () => {
    scrubSensitive(body);
    expect(body.authorization).toBe(RAW);
    expect(body.envs[0].value).toBe(RAW);
  });

  it('also redacts a secret embedded in free text, which the old matcher did not', () => {
    // The Coolify redactor only ever replaced whole values by key name, so a provider
    // message that quoted the credential back went out verbatim.
    const scrubbed = scrubSensitive({
      message: 'deploy failed: Authorization: Bearer abcdefghij1234567890',
    }) as { message: string };
    expect(scrubbed.message).not.toContain('abcdefghij1234567890');
    expect(scrubbed.message).toContain('deploy failed');
  });
});
