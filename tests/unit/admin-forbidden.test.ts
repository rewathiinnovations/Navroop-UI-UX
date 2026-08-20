import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-419: every admin loader answered a 403 with
 * `window.location.replace('/dashboard')` — a full document navigation with no
 * message. It only fires when an admin's role is revoked mid-session, which is
 * exactly the moment an explanation matters: the page blinked and the user
 * landed on the dashboard with no idea why, client state discarded.
 *
 * Two guards: the helper says something before it navigates, and no admin
 * screen may go back to the bare hard redirect.
 */

const toasts = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('@/lib/notify', () => ({ notify: { error: toasts.error } }));

const { ADMIN_ACCESS_REVOKED_MESSAGE, handleAdminForbidden } = await import(
  // Dynamic so the `vi.mock` factory above is in place: the helper imports
  // `@/lib/notify`, which pulls in react-toastify at module scope.
  '@/lib/admin/forbidden'
);

describe('handleAdminForbidden explains before it leaves', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the revocation message and then navigates', () => {
    const order: string[] = [];
    toasts.error.mockImplementation(() => {
      order.push('notify');
      return 1;
    });
    const router = {
      replace: (href: string) => {
        order.push(`replace:${href}`);
      },
    };

    handleAdminForbidden(router);

    // Order is load-bearing: a hard navigation would tear the toast host down
    // before it rendered, which is why this is a router replace.
    expect(order).toEqual(['notify', 'replace:/dashboard']);
    expect(toasts.error).toHaveBeenCalledWith(
      ADMIN_ACCESS_REVOKED_MESSAGE,
      expect.objectContaining({ key: expect.any(String) }),
    );
  });

  it('names the reason rather than failing silently', () => {
    expect(ADMIN_ACCESS_REVOKED_MESSAGE.toLowerCase()).toContain('admin access');
  });
});

describe('no admin screen answers a 403 with a silent hard redirect', () => {
  const root = join(process.cwd(), 'app', '(app)', 'admin');
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.tsx'))
    .map((entry) => entry.split(sep).join('/'));

  it('found the admin screens', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    const source = readFileSync(join(root, file), 'utf8');

    // `window.location.assign` is still right for an OAuth handoff that leaves
    // the app; what F-419 was about is bouncing to /dashboard, which throws the
    // toast host away along with the explanation.
    it(`${file} never document-navigates to the dashboard`, () => {
      expect(source).not.toMatch(/window\.location\.(?:replace|assign|href\s*=)\s*\(?\s*['"`]\//);
    });

    if (!/status === 403/.test(source)) continue;
    it(`${file} explains the 403 instead of just leaving`, () => {
      const explains =
        source.includes('handleAdminForbidden') || /admin access was removed/i.test(source);
      expect(explains, 'a revoked admin must be told why the page went away').toBe(true);
    });
  }
});
