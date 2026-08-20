import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { listRouteFiles } from '@/lib/auth/route-inventory';

/**
 * The product is cookie-authenticated and same-origin. Two routes nonetheless
 * shipped CORS headers:
 *
 * - F-012 `generate-ai-code-stream` declared `Access-Control-Allow-Origin: *` on
 *   an authenticated, credit-spending SSE endpoint and advertised `Authorization`
 *   as an accepted header, with no OPTIONS handler for the preflight it invited.
 * - F-322 `scrape-website` exported an `OPTIONS` handler answering
 *   `Access-Control-Allow-Origin: *` to any origin. Its `POST` set no CORS
 *   headers, so the preflight described a request that could never succeed — and
 *   the wildcard stood as an invitation for someone to later "fix" the POST by
 *   echoing it, at which point the session cookie becomes the live question.
 *
 * Both are removed. A single wildcard anywhere under `app/` fails this.
 */

const CORS_HEADERS = [
  'Access-Control-Allow-Origin',
  'Access-Control-Allow-Methods',
  'Access-Control-Allow-Headers',
  'Access-Control-Allow-Credentials',
] as const;

/** Line comments explain why the headers are absent; they are not the headers. */
function withoutComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

const routeFiles = listRouteFiles();

describe('no route advertises CORS', () => {
  it('walks the route tree', () => {
    // A walker matching nothing would make the assertion below vacuous.
    expect(routeFiles.length).toBeGreaterThan(100);
  });

  it('sets no Access-Control-* response header anywhere under app/', () => {
    const offenders: string[] = [];
    for (const file of routeFiles) {
      const source = withoutComments(readFileSync(file, 'utf8'));
      for (const header of CORS_HEADERS) {
        if (source.includes(header)) offenders.push(`${file}: ${header}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('exports no OPTIONS handler, since nothing needs a preflight', () => {
    const offenders = routeFiles.filter((file) =>
      /export\s+(async\s+)?function\s+OPTIONS\b/.test(withoutComments(readFileSync(file, 'utf8'))),
    );
    expect(offenders).toEqual([]);
  });
});
