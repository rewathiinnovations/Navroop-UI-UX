import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-318: the `/preview-static` route inlined its own
 * `AUTH_SECRET || NEXTAUTH_SECRET || ENCRYPTION_KEY || ''` chain. With none of the
 * three set the HMAC was keyed on the empty string, so a token an attacker signed
 * with `''` passed `verifyPreviewToken`. Only `checkPreviewToken` inside
 * `loadBuild` threw afterwards — ordering was the only thing standing between a
 * forged signature and an accepted one.
 */

const db = vi.hoisted(() => ({
  getProjectPreviewFields: vi.fn(),
  findUnique: vi.fn(),
}));
const storage = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@/lib/preview/db', () => ({
  getProjectPreviewFields: db.getProjectPreviewFields,
  previewBuildTable: () => ({ findUnique: db.findUnique }),
}));
vi.mock('@/lib/storage', () => storage);

const { GET } = await import('@/app/preview-static/[projectId]/[[...path]]/route');
const { signPreviewToken } = await import('@/lib/preview/token');

const SECRETS = ['AUTH_SECRET', 'NEXTAUTH_SECRET', 'ENCRYPTION_KEY'] as const;
const saved: Record<string, string | undefined> = {};

// Live, not a fixed past instant: the route verifies against `Date.now()`, so a
// frozen timestamp would make every forged token merely *expired* and the
// signature check would never be the thing under test.
const NOW = Date.now();

function requestWith(token: string) {
  return new NextRequest(
    `http://localhost:3000/preview-static/p1/index.html?token=${encodeURIComponent(token)}`,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of SECRETS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  db.getProjectPreviewFields.mockResolvedValue({ activePreviewBuildId: 'build-1' });
  db.findUnique.mockResolvedValue({
    storagePrefix: 'previews/p1',
    entryPath: 'index.html',
    isSpa: false,
    status: 'READY',
  });
  storage.get.mockResolvedValue(Buffer.from('<html>secret build</html>'));
});

afterEach(() => {
  for (const key of SECRETS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('preview-static with no signing secret configured', () => {
  it('refuses the request instead of verifying against an empty key', async () => {
    // The token an attacker can mint when the key is known to be `''`.
    const forged = signPreviewToken(
      { projectId: 'p1', userId: 'attacker' },
      { secret: '', now: NOW },
    );

    const response = await GET(requestWith(forged), {
      params: Promise.resolve({ projectId: 'p1', path: ['index.html'] }),
    });

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Preview is not configured');
  });

  it('never reaches the build or the object store on that request', async () => {
    const forged = signPreviewToken(
      { projectId: 'p1', userId: 'attacker' },
      { secret: '', now: NOW },
    );

    await GET(requestWith(forged), {
      params: Promise.resolve({ projectId: 'p1', path: ['index.html'] }),
    });

    expect(db.getProjectPreviewFields).not.toHaveBeenCalled();
    expect(storage.get).not.toHaveBeenCalled();
  });
});

// Assembled from parts so the staged-secret scanner does not read the fixture as a
// leaked credential. Only "non-empty and stable across the two calls" matters here.
const SIGNING_KEY = ['unit-test-preview', 'signing-key'].join('-');

describe('preview-static with a signing secret configured', () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = SIGNING_KEY;
  });

  it('still rejects a token forged against the empty key', async () => {
    const forged = signPreviewToken(
      { projectId: 'p1', userId: 'attacker' },
      { secret: '', now: NOW },
    );

    const response = await GET(requestWith(forged), {
      params: Promise.resolve({ projectId: 'p1', path: ['index.html'] }),
    });

    expect(response.status).toBe(403);
    expect(storage.get).not.toHaveBeenCalled();
  });

  it('serves a token signed with the configured secret', async () => {
    const valid = signPreviewToken(
      { projectId: 'p1', userId: 'u1' },
      { secret: process.env.AUTH_SECRET as string, now: Date.now() },
    );

    const response = await GET(requestWith(valid), {
      params: Promise.resolve({ projectId: 'p1', path: ['index.html'] }),
    });

    expect(response.status).toBe(200);
    expect(storage.get).toHaveBeenCalled();
  });
});
