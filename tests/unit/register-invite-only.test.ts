import { describe, expect, it, vi } from 'vitest';
import { POST as register } from '@/app/api/auth/register/route';
import { POST as signup } from '@/app/api/auth/signup/route';
import { matchPublicRoute } from '@/lib/auth/public-routes';
import * as legalRegister from '@/lib/legal/register';
import type * as PasswordModule from '@/lib/password';

/**
 * `POST /api/auth/register` used to mint a MEMBER for anyone who posted a form, while
 * `lib/auth/public-routes.ts` claimed "a valid single-use invite token is required".
 * Since project reads are workspace-wide by design, that gave any stranger the whole
 * workspace.
 *
 * The first fix gated it on a pending `Invite` row — a control nothing could satisfy:
 * the only invite producer, `POST /api/admin/invite`, creates the User itself and writes
 * the invite already accepted. So the endpoint returned 403 to everyone including real
 * invitees, while the auth modal still offered the form, and this file's predecessor
 * "proved" single-use semantics against a fake that reached a state the real system
 * cannot.
 *
 * Navroop has no self-serve registration, so what is pinned here is the closed contract:
 * the same refusal as `POST /api/auth/signup`, with no database work and no password
 * hashing. That last part is not incidental — it is what removes the timing side channel
 * that told an attacker whether an address had a pending invite, since a fast 403 and a
 * bcrypt-slow 403 were distinguishable while the message was not.
 */

const prismaTouched = vi.hoisted(() => vi.fn());
// Any property access at all is a failure, so "does no database work" is enforced by the
// mock rather than asserted call by call.
vi.mock('@/lib/db', () => ({
  prisma: new Proxy(
    {},
    {
      get(_target, property) {
        prismaTouched(String(property));
        throw new Error(`the closed register route must not reach prisma.${String(property)}`);
      },
    },
  ),
}));

const hashPassword = vi.hoisted(() => vi.fn(async () => 'hashed'));
vi.mock('@/lib/password', async (importOriginal) => ({
  ...(await importOriginal<typeof PasswordModule>()),
  hashPassword,
}));

const CLOSED_MESSAGE = 'Public signup is disabled. Ask an admin to invite you.';

describe('POST /api/auth/register is closed', () => {
  it('refuses with the same status and copy as POST /api/auth/signup', async () => {
    const refused = await register();
    const closed = await signup();

    expect(refused.status).toBe(403);
    expect(closed.status).toBe(refused.status);

    const refusedBody = await refused.json();
    expect(refusedBody).toEqual({ error: CLOSED_MESSAGE });
    expect(await closed.json()).toEqual(refusedBody);
  });

  it('consults no request, no database and no password hash, so there is nothing to time', async () => {
    // A handler that declares no request parameter cannot branch on the submitted email,
    // which is the machine-checkable form of "no enumeration oracle survives here".
    expect(register.length).toBe(0);

    const refused = await register();
    expect(refused.status).toBe(403);
    expect(prismaTouched).not.toHaveBeenCalled();
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it('stays on the public allowlist so callers get the refusal, not a 401', () => {
    expect(matchPublicRoute('/api/auth/register', 'POST')).not.toBeNull();
  });

  it('leaves no account-creation code behind in lib/legal/register', () => {
    // Terms acceptance for an already-invited user is all this module still does; a
    // reintroduced `registerAccount` would fail here rather than sit around looking live.
    expect(Object.keys(legalRegister).sort()).toEqual([
      'TERMS_REQUIRED_MESSAGE',
      'TERMS_VERSION',
      'acceptTermsForUser',
      'getTermsStatus',
    ]);
  });
});
