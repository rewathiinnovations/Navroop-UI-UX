import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-321: `ensureAdminUser()` was the first statement in `POST /api/auth/login`.
 * It issued a `user.findFirst({ where: { role: 'ADMIN' } })` on every call —
 * before the JSON parse, before validation and before the login throttle — so an
 * unauthenticated flood drove one database query per request past the limiter
 * that exists to bound exactly that. The answer is also memoised now: "an admin
 * exists" is one-way, so it is asked once per process.
 */

const findFirst = vi.hoisted(() => vi.fn());
const signIn = vi.hoisted(() => vi.fn());
const auth = vi.hoisted(() => ({ getSessionUser: vi.fn(), toPublicUser: vi.fn() }));

vi.mock('@/lib/db', () => ({
  prisma: { user: { findFirst, findUnique: vi.fn(), create: vi.fn(), update: vi.fn() } },
}));
vi.mock('@/auth', () => ({ signIn }));
vi.mock('@/lib/auth', () => auth);

const { POST } = await import('@/app/api/auth/login/route');
const { ensureAdminUser, resetAdminSeedMemo } = await import('@/lib/ensure-admin');
const { clearLoginRateLimits } = await import('@/lib/auth/login-rate-limit');

function loginRequest(body: unknown, ip = '203.0.113.10') {
  return new NextRequest('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAdminSeedMemo();
  clearLoginRateLimits();
  findFirst.mockResolvedValue({ id: 'admin-1' });
  auth.getSessionUser.mockResolvedValue({ id: 'admin-1', email: 'a@b.test', role: 'ADMIN' });
  auth.toPublicUser.mockImplementation((user: unknown) => user);
});

describe('ensureAdminUser is off the unauthenticated hot path', () => {
  it('does not query the database for a request that fails validation', async () => {
    const response = await POST(loginRequest({ email: 'not-an-email', password: '' }));

    expect(response.status).toBe(400);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('does not query the database for a malformed body', async () => {
    const response = await POST(loginRequest('{broken'));

    expect(response.status).toBe(400);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('does not query the database once the throttle has tripped', async () => {
    // Burn the window with well-formed attempts that fail sign-in.
    signIn.mockRejectedValue(new Error('bad credentials'));
    let throttled: Response | null = null;
    for (let i = 0; i < 40 && !throttled; i += 1) {
      const response = await POST(
        loginRequest({ email: 'flood@example.test', password: 'hunter2!' }),
      );
      if (response.status === 429) throttled = response;
    }
    expect(throttled).not.toBeNull();

    // Clear the memo too, so this asserts the *ordering* rather than riding on
    // the earlier attempts having already answered "an admin exists".
    resetAdminSeedMemo();
    findFirst.mockClear();
    const next = await POST(loginRequest({ email: 'flood@example.test', password: 'hunter2!' }));

    expect(next.status).toBe(429);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('still seeds before sign-in for an attempt that gets past the throttle', async () => {
    signIn.mockResolvedValue(undefined);
    const response = await POST(
      loginRequest({ email: 'admin@example.test', password: 'hunter2!' }),
    );

    expect(response.status).toBe(200);
    expect(findFirst).toHaveBeenCalledTimes(1);
    // Ordering, not just presence: sign-in must not run before the seed.
    expect(findFirst.mock.invocationCallOrder[0]).toBeLessThan(signIn.mock.invocationCallOrder[0]);
  });
});

describe('ensureAdminUser memoises the admin-exists answer', () => {
  it('asks the database once per process when an admin is found', async () => {
    expect(await ensureAdminUser()).toEqual({ created: false });
    expect(await ensureAdminUser()).toEqual({ created: false, memoised: true });
    expect(await ensureAdminUser()).toEqual({ created: false, memoised: true });

    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('keeps asking while no admin exists and none can be seeded', async () => {
    // The memo is set the moment an admin is found, promoted or created. The one
    // state that must stay un-memoised is "no admin, and no seed credentials to
    // make one" — otherwise a deployment configured after boot never seeds.
    const seedEnv = ['SEED_ADMIN_EMAIL', 'ADMIN_EMAIL', 'SEED_ADMIN_PASSWORD', 'ADMIN_PASSWORD'];
    const saved = seedEnv.map((key) => [key, process.env[key]] as const);
    for (const key of seedEnv) delete process.env[key];
    findFirst.mockResolvedValue(null);

    try {
      await ensureAdminUser();
      await ensureAdminUser();
      expect(findFirst).toHaveBeenCalledTimes(2);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
