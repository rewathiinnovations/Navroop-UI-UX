import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What an internal auditor is allowed to fetch.
 *
 * `Project.previewUrl` is owner-writable through `PATCH /api/projects/[id]`, and
 * the audit hands its preview URL to `page.goto` (`lib/audit/a11y.ts`), to a bare
 * `fetch` that deliberately skips `safeFetch` (`lib/seo/live.ts`) and to
 * Lighthouse. Both audit entry points read that column into a variable and then
 * overwrote it unconditionally — dead, but reading as a live fallback (F-759).
 *
 * The rule is now in one place: a signed URL for the active build, or nothing.
 */

const db = vi.hoisted(() => ({ queryRaw: vi.fn() }));
const store = vi.hoisted(() => ({ peekRootDomain: vi.fn(), getSetting: vi.fn() }));

vi.mock('@/lib/db', () => ({ prisma: { $queryRaw: db.queryRaw } }));
vi.mock('@/lib/integrations/store', () => ({ peekRootDomain: store.peekRootDomain }));
vi.mock('@/lib/settings/resolve', () => ({ getSetting: store.getSetting }));

const OWNER_WRITABLE = 'http://169.254.169.254/latest/meta-data/';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_SECRET = 'test-secret';
  // Production-shaped, or the loopback sibling preempts the zone: a loopback
  // app serves its own previews (lib/preview/url.ts), and this test is about
  // the zone-host path an audit URL takes in production.
  process.env.APP_URL = 'https://app.example.com';
  store.peekRootDomain.mockResolvedValue('example.com');
  store.getSetting.mockResolvedValue(null);
});

describe('auditPreviewUrl', () => {
  it('signs the served build, ignoring the owner-writable previewUrl column', async () => {
    db.queryRaw.mockResolvedValue([
      {
        previewMode: 'STATIC',
        activePreviewBuildId: 'b1',
        stack: 'NEXTJS',
        previewUrl: OWNER_WRITABLE,
      },
    ]);
    const { auditPreviewUrl } = await import('@/lib/preview/url');

    const url = await auditPreviewUrl('p1', 'seo-audit');

    expect(url).toMatch(/^https:\/\/preview-static\.example\.com\/p1\/\?token=/);
    expect(url).not.toContain('169.254');
  });

  it('returns nothing — never the project column — when no build is active', async () => {
    db.queryRaw.mockResolvedValue([
      {
        previewMode: 'STATIC',
        activePreviewBuildId: null,
        stack: 'NEXTJS',
        previewUrl: OWNER_WRITABLE,
      },
    ]);
    const { auditPreviewUrl } = await import('@/lib/preview/url');

    expect(await auditPreviewUrl('p1', 'seo-audit')).toBeNull();
  });

  it('returns nothing for a project that does not exist', async () => {
    db.queryRaw.mockResolvedValue([]);
    const { auditPreviewUrl } = await import('@/lib/preview/url');

    expect(await auditPreviewUrl('gone', 'code-audit')).toBeNull();
  });
});
