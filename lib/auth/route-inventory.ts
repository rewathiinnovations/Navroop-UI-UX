import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Walks the App Router file tree and reports every route handler it finds.
 *
 * Used by `tests/unit/api-route-auth.test.ts` to prove that no route escapes
 * the proxy gate, and by `scripts/check-public-routes.ts` to prove that every
 * allowlist entry still corresponds to a real route. Both need the same view of
 * the filesystem, so the walker lives here rather than being written twice.
 */

/** Directories under `app/` whose routes the proxy gate covers. */
export const GUARDED_ROUTE_ROOTS = ['api', 'preview-static'] as const;

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

export type RouteEndpoint = {
  /** Repo-relative path, forward slashes. */
  file: string;
  /** Request path with `:param` segments and a trailing `/*` for catch-alls. */
  pattern: string;
  method: string;
};

function walk(dir: string, out: string[]) {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (entry === 'route.ts' || entry === 'route.tsx' || entry === 'route.js') {
      out.push(full);
    }
  }
  return out;
}

export function listRouteFiles(root: string = process.cwd()) {
  const files: string[] = [];
  for (const guarded of GUARDED_ROUTE_ROOTS) {
    walk(join(root, 'app', guarded), files);
  }
  return files.map((file) => relative(root, file).split(sep).join('/')).sort();
}

/**
 * Turn `app/api/projects/[id]/route.ts` into `/api/projects/:id`.
 *
 * An optional catch-all `[[...path]]` serves both the path with and without
 * those segments, so it yields two patterns; a required catch-all yields one.
 */
export function routePatternsForFile(file: string): string[] {
  const segments = file
    .replace(/^app\//, '')
    .replace(/\/route\.(ts|tsx|js)$/, '')
    .split('/')
    .filter((segment) => segment.length > 0 && !/^\(.*\)$/.test(segment));

  const base: string[] = [];
  let optionalCatchAll = false;

  for (const segment of segments) {
    if (/^\[\[\.\.\..+\]\]$/.test(segment)) {
      optionalCatchAll = true;
      base.push('*');
    } else if (/^\[\.\.\..+\]$/.test(segment)) {
      base.push('*');
    } else if (/^\[.+\]$/.test(segment)) {
      base.push(`:${segment.slice(1, -1)}`);
    } else {
      base.push(segment);
    }
  }

  const full = `/${base.join('/')}`;
  if (!optionalCatchAll) return [full];
  return [`/${base.slice(0, -1).join('/')}`, full];
}

/**
 * Read the HTTP methods a route file exports. Covers the three shapes used in
 * this repo: `export async function GET`, `export const { GET, POST } =`, and
 * `export { POST } from '…'`.
 */
export function methodsInSource(source: string): string[] {
  const found = new Set<string>();

  for (const method of HTTP_METHODS) {
    if (new RegExp(`export\\s+(async\\s+)?function\\s+${method}\\b`).test(source)) found.add(method);
    if (new RegExp(`export\\s+const\\s+${method}\\s*[:=]`).test(source)) found.add(method);
  }

  for (const match of source.matchAll(/export\s+(?:const\s+)?\{([^}]*)\}/g)) {
    for (const name of match[1].split(',')) {
      const cleaned = name.split(' as ').pop()?.trim() ?? '';
      if ((HTTP_METHODS as readonly string[]).includes(cleaned)) found.add(cleaned);
    }
  }

  return [...found].sort();
}

export function collectRouteEndpoints(root: string = process.cwd()): RouteEndpoint[] {
  const endpoints: RouteEndpoint[] = [];
  for (const file of listRouteFiles(root)) {
    const source = readFileSync(join(root, file), 'utf8');
    for (const pattern of routePatternsForFile(file)) {
      for (const method of methodsInSource(source)) {
        endpoints.push({ file, pattern, method });
      }
    }
  }
  return endpoints;
}

/**
 * Build a concrete request path from a route pattern by substituting sample
 * values, so the pattern can be run through the proxy or fetched.
 */
export function samplePath(pattern: string) {
  return pattern
    .split('/')
    .map((segment) => {
      if (segment === '*') return 'sample-path';
      if (segment.startsWith(':')) return `sample-${segment.slice(1).toLowerCase()}`;
      return segment;
    })
    .join('/');
}
