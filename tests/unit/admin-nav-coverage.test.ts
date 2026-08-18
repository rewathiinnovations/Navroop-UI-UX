import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADMIN_NAV, ADMIN_NAV_ITEMS, isAdminNavItemActive } from '@/components/admin/admin-nav';

/**
 * The admin tab list used to exist in six places that had drifted apart, and
 * `/admin/templates` appeared in none of them — it was reachable only by typing
 * the URL. This asserts the single list still covers every page that exists, so
 * adding a route without adding it to the navigation fails here rather than
 * quietly producing another unreachable page.
 */

const ADMIN_DIR = join(process.cwd(), 'app', '(app)', 'admin');

/** Pages that intentionally have no navigation entry, with the reason. */
const NOT_IN_NAV: Record<string, string> = {
  deploy: 'redirects to /admin/integrations; superseded by the integrations page',
};

function adminRouteSegments() {
  return readdirSync(ADMIN_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(ADMIN_DIR, name, 'page.tsx')));
}

describe('admin navigation', () => {
  it('lists every admin page that is not deliberately excluded', () => {
    const hrefs = new Set(ADMIN_NAV_ITEMS.map((item) => item.href));
    const missing = adminRouteSegments()
      .filter((segment) => !(segment in NOT_IN_NAV))
      .filter((segment) => !hrefs.has(`/admin/${segment}`));

    expect(missing).toEqual([]);
  });

  it('points only at pages that exist', () => {
    const segments = new Set(adminRouteSegments());
    const dangling = ADMIN_NAV_ITEMS.filter((item) => item.href !== '/admin').filter(
      (item) => !segments.has(item.href.replace('/admin/', '')),
    );

    expect(dangling.map((item) => item.href)).toEqual([]);
  });

  it('has no duplicate destinations', () => {
    const hrefs = ADMIN_NAV_ITEMS.map((item) => item.href);
    expect(hrefs.length).toBe(new Set(hrefs).size);
  });

  it('gives every entry a plain-language description', () => {
    for (const item of ADMIN_NAV_ITEMS) {
      expect(item.description.length).toBeGreaterThan(20);
    }
  });

  it('groups every entry', () => {
    expect(ADMIN_NAV.length).toBeGreaterThan(1);
    for (const group of ADMIN_NAV) {
      expect(group.items.length).toBeGreaterThan(0);
    }
  });

  it('does not let Home claim every nested admin route as active', () => {
    const home = ADMIN_NAV_ITEMS.find((item) => item.href === '/admin')!;
    const team = ADMIN_NAV_ITEMS.find((item) => item.href === '/admin/team')!;

    expect(isAdminNavItemActive(home, '/admin')).toBe(true);
    expect(isAdminNavItemActive(home, '/admin/team')).toBe(false);
    expect(isAdminNavItemActive(team, '/admin/team')).toBe(true);
  });
});
