import { describe, expect, it } from 'vitest';
import { checkMetadata } from '@/lib/seo/checks/metadata';
import { checkOpenGraph } from '@/lib/seo/checks/open-graph';
import { checkPageBasics } from '@/lib/seo/checks/page-basics';
import { seoScoreFromFindings } from '@/lib/signals/score';
import type { SeoFinding, SeoScanInput } from '@/lib/seo/types';

/**
 * F-731. Two shapes of false verdict fed the SEO score.
 *
 * (a) The duplicate-title check compared the *live homepage title* against the
 *     titles extracted from source. The live title is rendered from one of those
 *     files, so it always duplicated one of them: the finding fired on a
 *     single-page project and on a project whose routes all had distinct titles
 *     — every case it was meant to tell apart.
 *
 * (b) Several checks passed if a substring appeared anywhere in the whole
 *     repository concatenated together: `/viewport/i`, `/og:title/`,
 *     `rel="canonical"`. A CSS comment or a helper that builds meta tags
 *     satisfied them.
 */

function scan(files: Array<{ path: string; content: string }>, html?: string): SeoScanInput {
  return {
    stack: 'NEXTJS',
    files,
    previewUrl: html ? 'https://preview.example/' : null,
    live: html
      ? { url: 'https://preview.example/', status: 200, html, headers: {}, unreachable: false }
      : null,
    liveRobots: null,
    liveSitemap: null,
  };
}

function byId(findings: SeoFinding[], id: string): SeoFinding | undefined {
  return findings.find((row) => row.id === id);
}

const HOME = `export const metadata = { title: 'Saffron Clay — Bandra West' };`;
const LIVE_HOME = '<html lang="en"><head><title>Saffron Clay — Bandra West</title></head></html>';

describe('duplicate titles are counted across routes, not against the live page', () => {
  it('does not report a single-page project as having duplicate titles', () => {
    const findings = checkMetadata(scan([{ path: 'app/page.tsx', content: HOME }], LIVE_HOME));
    expect(byId(findings, 'metadata:duplicate-title')).toBeUndefined();
  });

  it('does not report two routes whose titles genuinely differ', () => {
    const findings = checkMetadata(
      scan(
        [
          {
            path: 'app/page.tsx',
            content: `export const metadata = { title: 'Home — Saffron Clay' };`,
          },
          {
            path: 'app/menu/page.tsx',
            content: `export const metadata = { title: 'Menu — Saffron Clay' };`,
          },
        ],
        '<html><head><title>Home — Saffron Clay</title></head></html>',
      ),
    );
    expect(byId(findings, 'metadata:duplicate-title')).toBeUndefined();
  });

  it('does not count one route that declares the same title twice', () => {
    const findings = checkMetadata(
      scan([
        {
          path: 'app/layout.tsx',
          content: `<title>Saffron Clay</title>\nexport const metadata = { title: 'Saffron Clay' };`,
        },
      ]),
    );
    expect(byId(findings, 'metadata:duplicate-title')).toBeUndefined();
  });

  it('reports two routes that share a title, and names both files', () => {
    const findings = checkMetadata(
      scan([
        { path: 'app/page.tsx', content: `export const metadata = { title: 'Saffron Clay' };` },
        {
          path: 'app/menu/page.tsx',
          content: `export const metadata = { title: 'Saffron Clay' };`,
        },
      ]),
    );
    const dupe = byId(findings, 'metadata:duplicate-title');
    expect(dupe?.status).toBe('medium');
    expect(dupe?.detail).toContain('app/page.tsx');
    expect(dupe?.detail).toContain('app/menu/page.tsx');
  });
});

describe('document-level checks look at the file that owns the concern', () => {
  it('does not pass viewport because a stylesheet comment says the word', () => {
    const findings = checkPageBasics(
      scan([{ path: 'src/styles/app.css', content: '/* viewport-relative sizing */\n.a{}' }]),
    );
    const viewport = byId(findings, 'page-basics:viewport');
    expect(viewport?.status).not.toBe('pass');
    // No root document in the snapshot and no preview: unknown, not the
    // project's defect, and excluded from the score.
    expect(viewport?.status).toBe('info');
    expect(viewport?.fixable).toBe(false);
  });

  it('passes viewport when the root document declares it', () => {
    const findings = checkPageBasics(
      scan([
        {
          path: 'index.html',
          content: '<html><head><meta name="viewport" content="width=device-width"></head></html>',
        },
      ]),
    );
    expect(byId(findings, 'page-basics:viewport')?.status).toBe('pass');
  });

  it('reports a missing viewport when the root document exists and omits it', () => {
    const findings = checkPageBasics(
      scan([
        { path: 'app/layout.tsx', content: 'export default function Layout() { return null; }' },
      ]),
    );
    expect(byId(findings, 'page-basics:viewport')?.status).toBe('medium');
  });

  it('does not pass canonical because a helper mentions rel="canonical"', () => {
    const findings = checkMetadata(
      scan([
        { path: 'lib/seo-helper.ts', content: `const tag = '<link rel="canonical" href="">';` },
        { path: 'app/page.tsx', content: HOME },
      ]),
    );
    expect(byId(findings, 'metadata:canonical')?.status).toBe('medium');
  });

  it('passes canonical from a route metadata alternates block', () => {
    const findings = checkMetadata(
      scan([
        {
          path: 'app/page.tsx',
          content: `export const metadata = { title: 'Saffron Clay', alternates: { canonical: 'https://x.dev/' } };`,
        },
      ]),
    );
    expect(byId(findings, 'metadata:canonical')?.status).toBe('pass');
  });

  it('does not pass Open Graph because a helper contains the string og:title', () => {
    const findings = checkOpenGraph(
      scan([
        {
          path: 'lib/meta.ts',
          content: `const keys = ['og:title', 'og:description', 'og:image'];`,
        },
      ]),
    );
    const tags = byId(findings, 'open-graph:tags');
    expect(tags?.status).not.toBe('pass');
    expect(tags?.status).toBe('info');
    expect(tags?.fixable).toBe(false);
  });

  it('passes Open Graph from a route metadata openGraph block', () => {
    const findings = checkOpenGraph(
      scan([
        {
          path: 'app/layout.tsx',
          content: `export const metadata = { openGraph: { title: 'A', description: 'B', images: ['/og.png'] }, twitter: { card: 'summary_large_image' } };`,
        },
      ]),
    );
    expect(byId(findings, 'open-graph:tags')?.status).toBe('pass');
    expect(byId(findings, 'open-graph:twitter-card')?.status).toBe('pass');
  });

  it('reports the Open Graph tags a route metadata block leaves out', () => {
    const findings = checkOpenGraph(
      scan([
        { path: 'app/page.tsx', content: `export const metadata = { openGraph: { title: 'A' } };` },
      ]),
    );
    const tags = byId(findings, 'open-graph:tags');
    expect(tags?.status).toBe('medium');
    expect(tags?.detail).toContain('og:description');
    expect(tags?.detail).toContain('og:image');
  });
});

describe('an undeterminable check does not move the recorded SEO score', () => {
  it('excludes "could not be checked" findings the way F-755 excludes unreachable previews', () => {
    const findings = [
      ...checkPageBasics(scan([{ path: 'src/styles/app.css', content: '/* viewport */' }])),
      ...checkOpenGraph(scan([{ path: 'lib/meta.ts', content: `'og:title'` }])),
    ];
    expect(findings.some((row) => row.status === 'info')).toBe(true);
    const applicable = findings.filter((row) => row.status !== 'info');
    const passing = applicable.filter((row) => row.status === 'pass').length;
    expect(seoScoreFromFindings(findings)).toBe(
      applicable.length === 0 ? 1 : passing / applicable.length,
    );
  });
});
