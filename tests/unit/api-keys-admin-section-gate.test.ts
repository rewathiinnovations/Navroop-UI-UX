import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The admin-only "Team defaults" section must not appear the instant the
 * session resolves.
 *
 * This page is server-rendered with no session, so that section is never in
 * the server HTML. Rendering it as soon as `isAdmin` flips put it into the
 * tree while React was still hydrating, and React reported a hydration
 * failure (#418). It reproduced on the first load after a cold `next start`
 * — where the window between the HTML arriving and hydration finishing is
 * widest — and was invisible in dev and on warm reloads.
 *
 * Waiting for the team defaults to load puts the section behind a network
 * round trip, which lands well clear of hydration. Verified by the repro:
 * two cold starts failed before the gate, two were clean after, and removing
 * the section entirely was clean.
 */

const PAGE = fileURLToPath(new URL('../../app/(app)/settings/api-keys/page.tsx', import.meta.url));

describe('api-keys admin section is not rendered during hydration', () => {
  const source = readFileSync(PAGE, 'utf8');

  it('gates the section on loaded data, not on isAdmin alone', () => {
    expect(source).toContain('{isAdmin && orgLoaded && (');
    // A bare `{isAdmin && (` is the shape that broke hydration.
    expect(source).not.toContain('{isAdmin && (');
  });

  it('sets the gate only after the team defaults have been fetched', () => {
    const loadOrg = source.slice(source.indexOf('const loadOrg'), source.indexOf('useEffect('));
    expect(loadOrg).toContain('setOrgLoaded(true)');
    // Not before the request can fail — an early return must skip it. The anchor is
    // asserted first: `indexOf` returns -1 for a missing call, and `-1 < beforeLoaded`
    // passed on the exact edit this case exists to catch (F-609).
    const beforeError = loadOrg.indexOf('setError(');
    const beforeLoaded = loadOrg.indexOf('setOrgLoaded(true)');
    expect(beforeError).toBeGreaterThan(-1);
    expect(beforeError).toBeLessThan(beforeLoaded);
  });
});
