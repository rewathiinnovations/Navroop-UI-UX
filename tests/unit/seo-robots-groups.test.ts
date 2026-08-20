/**
 * F-756: `isSitewideBlock` tested the whole robots.txt for `Disallow: /` and for
 * `Allow: /` with no association to the `User-agent` block each line belongs to. That
 * misread both ways:
 *
 *  - `User-agent: GPTBot` / `Disallow: /` — a common, deliberate configuration — landed
 *    in the user's audit as a high-severity "robots.txt blocks the whole site";
 *  - an `Allow: /` anywhere in the file (under any other agent) suppressed the finding
 *    even when the `*` group really did disallow everything, silencing the one check
 *    that catches an accidentally de-indexed site.
 *
 * The check now evaluates the group that applies to `*`, and only that group.
 */
import { describe, expect, it } from 'vitest';
import { checkRobots } from '../../lib/seo/checks/robots';
import type { SeoScanInput } from '../../lib/seo/types';

function scan(robots: string): SeoScanInput {
  return {
    stack: 'NEXTJS',
    files: [{ path: 'robots.txt', content: robots }],
    previewUrl: null,
    live: null,
    liveRobots: null,
    liveSitemap: null,
  };
}

function robotsStatus(robots: string) {
  const rows = checkRobots(scan(robots));
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe('robots.txt sitewide block is evaluated per User-agent group', () => {
  it('does not report a sitewide block when one named crawler is blocked', () => {
    const row = robotsStatus(
      ['User-agent: *', 'Allow: /', '', 'User-agent: GPTBot', 'Disallow: /', ''].join('\n'),
    );
    expect(row.status).toBe('pass');
    expect(row.id).toBe('robots:present');
  });

  it('does not report a sitewide block when the file has no * group at all', () => {
    const row = robotsStatus(['User-agent: GPTBot', 'Disallow: /', ''].join('\n'));
    expect(row.status).toBe('pass');
  });

  it('reports a sitewide block when the * group disallows everything', () => {
    const row = robotsStatus(['User-agent: *', 'Disallow: /', ''].join('\n'));
    expect(row.status).toBe('high');
    expect(row.id).toBe('robots:blocked');
  });

  it('still reports the * group block when another group allows everything', () => {
    // The inverse misread: `Allow: /` under Googlebot used to suppress the finding while
    // every other crawler was told to go away.
    const row = robotsStatus(
      ['User-agent: *', 'Disallow: /', '', 'User-agent: Googlebot', 'Allow: /', ''].join('\n'),
    );
    expect(row.status).toBe('high');
  });

  it('honours Allow: / inside the * group as a deliberate override', () => {
    const row = robotsStatus(['User-agent: *', 'Disallow: /', 'Allow: /', ''].join('\n'));
    expect(row.status).toBe('pass');
  });

  it('treats consecutive User-agent lines as one group, per the robots spec', () => {
    const row = robotsStatus(['User-agent: GPTBot', 'User-agent: *', 'Disallow: /', ''].join('\n'));
    expect(row.status).toBe('high');
  });

  it('ignores comments, blank Disallow, and a path deeper than the root', () => {
    const row = robotsStatus(
      [
        '# our crawl policy',
        'User-agent: *',
        'Disallow:',
        'Disallow: /admin/  # never index the panel',
        'Sitemap: https://example.test/sitemap.xml',
        '',
      ].join('\n'),
    );
    expect(row.status).toBe('pass');
  });

  it('reads a CRLF file the same as an LF one', () => {
    const row = robotsStatus('User-agent: *\r\nDisallow: /\r\n');
    expect(row.status).toBe('high');
  });
});
