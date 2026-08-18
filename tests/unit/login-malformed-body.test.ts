import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * A malformed JSON body used to throw out of `request.json()` straight into
 * the route's outer catch and come back as a 500 "Could not sign in" — a
 * server error for what is a client mistake. It must be the same 400 an empty
 * body gets, and must never reach the credential check.
 */

const signIn = vi.hoisted(() => vi.fn());
vi.mock('@/auth', () => ({ signIn }));
vi.mock('@/lib/ensure-admin', () => ({ ensureAdminUser: vi.fn() }));
vi.mock('@/lib/auth', () => ({
  getSessionUser: vi.fn(),
  toPublicUser: vi.fn(),
}));

describe('POST /api/auth/login with a malformed body', () => {
  it('answers 400, not 500, and never calls signIn', async () => {
    const { POST } = await import('@/app/api/auth/login/route');
    const request = new NextRequest('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{broken',
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('Email and password are required');
    expect(signIn).not.toHaveBeenCalled();
  });
});
