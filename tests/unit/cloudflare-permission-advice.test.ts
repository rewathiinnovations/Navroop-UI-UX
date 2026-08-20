import { describe, expect, it } from 'vitest';

import {
  cloudflarePermissionMessage,
  CLOUDFLARE_UNAUTHORIZED_CODE,
} from '@/lib/integrations/cloudflare.ts';

/**
 * F-248: any Cloudflare refusal was reported as a missing permission.
 *
 * The old branch fired on `body?.status === 403` regardless of the error text, and its
 * `joined.includes('edit') || joined.includes('permission')` terms matched unrelated
 * messages. An IP-restricted token, a suspended account and a rate limit all told the
 * admin to add a DNS Edit permission they already had — and Cloudflare's own sentence,
 * the one thing that named the real cause, was thrown away. The line above it also read
 * `a || b && c`, which only parses correctly if you know `&&` binds tighter.
 *
 * The contract now: advice comes from a recognised Cloudflare authorization code plus the
 * operation the caller was performing (only the caller knows whether it was reading zones
 * or writing DNS). Anything else declines, and the caller surfaces Cloudflare's own words.
 *
 * Goes red if a bare status becomes advice again, if substring guessing returns, or if the
 * caller stops passing the provider's message through on an unrecognised failure.
 */

const UNAUTHORIZED = {
  errors: [
    { code: CLOUDFLARE_UNAUTHORIZED_CODE, message: 'Unauthorized to access requested resource' },
  ],
  status: 403,
};

describe('cloudflarePermissionMessage', () => {
  it('names DNS Edit when a DNS write was refused for lack of authorization', () => {
    expect(cloudflarePermissionMessage(UNAUTHORIZED, 'edit-dns')).toBe(
      'Zone → DNS → Edit permission missing',
    );
  });

  it('names Zone Read when a zone listing was refused for lack of authorization', () => {
    expect(cloudflarePermissionMessage(UNAUTHORIZED, 'list-zones')).toBe(
      'Zone → Zone → Read permission missing',
    );
  });

  it('declines on a bare 403 with no recognised code', () => {
    expect(
      cloudflarePermissionMessage(
        { errors: [{ code: 10000, message: 'Authentication error' }], status: 403 },
        'edit-dns',
      ),
    ).toBeNull();
    expect(cloudflarePermissionMessage({ errors: [], status: 403 }, 'list-zones')).toBeNull();
    expect(cloudflarePermissionMessage(null, 'edit-dns')).toBeNull();
  });

  it('declines on a rate limit, a suspended account and an IP restriction', () => {
    const cases = [
      { code: 10000, message: 'More than 1200 requests per five minutes' },
      { code: 1010, message: 'This account is suspended' },
      { code: 9106, message: 'Client IP address is not in the allowed list for this token' },
    ];
    for (const error of cases) {
      expect(cloudflarePermissionMessage({ errors: [error], status: 403 }, 'edit-dns')).toBeNull();
    }
  });

  it('never guesses a permission from words like edit or permission in the message', () => {
    expect(
      cloudflarePermissionMessage(
        { errors: [{ code: 81044, message: 'You do not have permission to edit this ruleset' }] },
        'edit-dns',
      ),
    ).toBeNull();
  });

  it('declines for a token-verify call, which says nothing about which permission is missing', () => {
    expect(cloudflarePermissionMessage(UNAUTHORIZED, 'verify-token')).toBeNull();
  });
});
