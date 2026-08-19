import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Removing the sandbox subsystem deleted its API routes, but the client kept
 * calling them — including the apply step of every generation, which left
 * generation dead-ending on a 404. Nothing typechecks a fetch URL, so this
 * walks the client source and fails on a call to a route that no longer
 * exists.
 */

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLIENT_ROOTS = ['app', 'components', 'lib'];
const EXTENSIONS = ['.ts', '.tsx'];
const SKIP = new Set(['node_modules', '.next', 'generated', 'archive']);

/** Every internal path passed to fetch(), with the file it appears in. */
function fetchedApiPaths(): Array<{ file: string; route: string }> {
  const found: Array<{ file: string; route: string }> = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP.has(entry)) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!EXTENSIONS.includes(path.extname(entry))) continue;
      const source = readFileSync(full, 'utf8');
      const relative = path.relative(REPO_ROOT, full).replace(/\\/g, '/');
      // Route handlers legitimately mention their own path in comments.
      if (relative.startsWith('app/api/')) continue;
      for (const match of source.matchAll(/fetch\(\s*[`'"](\/api\/[^`'"?$]*)/g)) {
        found.push({ file: relative, route: match[1] });
      }
    }
  };
  for (const root of CLIENT_ROOTS) walk(path.join(REPO_ROOT, root));
  return found;
}

/** A literal route resolves to a directory with a route file. */
function routeExists(route: string): boolean {
  const segments = route
    .replace(/^\/api\//, '')
    .split('/')
    .filter(Boolean);
  let dir = path.join(REPO_ROOT, 'app', 'api');
  for (const segment of segments) {
    const direct = path.join(dir, segment);
    if (existsSync(direct) && statSync(direct).isDirectory()) {
      dir = direct;
      continue;
    }
    // A dynamic segment ([id]) stands in for any concrete value.
    const dynamic = readdirSync(dir).find(
      (entry) => entry.startsWith('[') && statSync(path.join(dir, entry)).isDirectory(),
    );
    if (!dynamic) return false;
    dir = path.join(dir, dynamic);
  }
  return ['route.ts', 'route.tsx'].some((file) => existsSync(path.join(dir, file)));
}

describe('client fetches only routes that exist', () => {
  it('finds the api calls it claims to scan', () => {
    const calls = fetchedApiPaths();
    expect(calls.length).toBeGreaterThan(5);
  });

  it('never calls a deleted route', () => {
    const broken = fetchedApiPaths()
      .filter(({ route }) => !routeExists(route))
      .map(({ file, route }) => `${route} (${file})`);
    expect([...new Set(broken)]).toEqual([]);
  });
});
