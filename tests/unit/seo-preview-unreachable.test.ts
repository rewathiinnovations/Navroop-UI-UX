import { describe, expect, it, vi, afterEach } from 'vitest';
import { fetchPreviewDocument, fetchPreviewText } from '@/lib/seo/live';
import { checkIndexing } from '@/lib/seo/checks/indexing';
import { seoScoreFromFindings } from '@/lib/signals/score';
import type { LiveDocument, SeoScanInput } from '@/lib/seo/types';

/**
 * An SEO audit reports on the user's site. A preview we could not reach is our
 * outage, and reporting it as a high-severity fault in their homepage blames
 * them for it, feeds `seoScoreFromFindings` so the recorded quality number
 * drops, and points the "Fix" button at a homepage that is fine (F-755).
 *
 * "Could not check" is a third state, distinct from pass and from broken — the
 * same distinction `lib/backup/verify.ts`, `lib/health/check.ts` and
 * `lib/validation/build-check.ts` already make.
 */

const HOME = 'export default function Page(){return <h1>Hi</h1>}';

function scanInput(live: LiveDocument | null): SeoScanInput {
  return {
    stack: 'NEXTJS',
    files: [{ path: 'app/page.tsx', content: HOME }],
    previewUrl: 'https://preview.example.com/p1/?token=t0ken',
    live,
    liveRobots: null,
    liveSitemap: null,
  };
}

function liveDoc(over: Partial<LiveDocument>): LiveDocument {
  return {
    url: 'https://preview.example.com/p1/',
    status: 200,
    html: '<html><head><title>Hi</title></head><body></body></html>',
    headers: {},
    unreachable: false,
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchPreview* on a failed fetch', () => {
  it('reports unreachable rather than a status code the site never sent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );

    const doc = await fetchPreviewDocument('https://preview.example.com/p1/');
    const text = await fetchPreviewText('https://preview.example.com/p1/', '/robots.txt');

    expect(doc.unreachable).toBe(true);
    expect(text.unreachable).toBe(true);
  });

  it('reports a real response as reachable, whatever its status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 503 })),
    );

    const doc = await fetchPreviewDocument('https://preview.example.com/p1/');

    expect(doc.unreachable).toBe(false);
    expect(doc.status).toBe(503);
  });
});

describe('checkIndexing', () => {
  it('does not blame the project for a preview it could not reach', () => {
    const findings = checkIndexing(scanInput(liveDoc({ status: 0, html: '', unreachable: true })));

    expect(findings.map((row) => row.id)).toEqual(['indexing:preview-unreachable']);
    const [row] = findings;
    expect(row.status).toBe('info');
    expect(row.fixable).toBe(false);
    // Not the verdict for a homepage that really answered 5xx.
    expect(row.title).not.toMatch(/error/i);
  });

  it('keeps the high verdict for a homepage that really failed', () => {
    const findings = checkIndexing(scanInput(liveDoc({ status: 500 })));

    expect(findings[0]).toMatchObject({ id: 'indexing:homepage-error', status: 'high' });
  });

  it('still reports a file-level noindex when the preview is unreachable', () => {
    const input = scanInput(liveDoc({ status: 0, html: '', unreachable: true }));
    input.files = [{ path: 'app/page.tsx', content: '// robots: noindex\n' + HOME }];

    const findings = checkIndexing(input);

    expect(findings.map((row) => row.id)).toContain('indexing:noindex');
  });

  it('still passes a reachable, indexable homepage', () => {
    const findings = checkIndexing(scanInput(liveDoc({})));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ id: 'indexing:public', status: 'pass' });
  });
});

describe('seoScoreFromFindings', () => {
  it('leaves the score alone when a check could not run', () => {
    const passing = [
      { id: 'a', status: 'pass', ignored: false },
      { id: 'b', status: 'pass', ignored: false },
    ];

    expect(seoScoreFromFindings(passing)).toBe(1);
    expect(seoScoreFromFindings([...passing, { id: 'c', status: 'info', ignored: false }])).toBe(1);
  });

  it('still counts a real failure against the score', () => {
    expect(
      seoScoreFromFindings([
        { id: 'a', status: 'pass', ignored: false },
        { id: 'b', status: 'high', ignored: false },
      ]),
    ).toBe(0.5);
  });
});
