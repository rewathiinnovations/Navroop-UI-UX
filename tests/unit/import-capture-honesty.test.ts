/**
 * URL import used to treat a Firecrawl 4xx/5xx or network error as
 * "this page had no markdown" (`return ''`). That is a different fact from
 * a successful scrape of an empty page, and the user needs a different next
 * step. These tests pin the typed result and the English — no live Firecrawl
 * calls, no loopback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnsafeUrlError, URL_GUARD_MESSAGES } from '@/lib/security/url-guard';
import { toBlockedAccessError } from '@/lib/import/errors';
import {
  FIRECRAWL_EMPTY_IS_NOT_FAILURE,
  firecrawlFailureMessage,
  scrapeFirecrawlText,
  type FirecrawlScrapeFailed,
} from '@/lib/import/firecrawl';
import { runUrlImportPipeline } from '@/lib/import/pipeline';
import {
  IMPORT_NO_FILES_MESSAGE,
  sectionGenerateFailureMessage,
  sectionGenerationSeverity,
} from '@/lib/import/copy';
import { generateImportedSections } from '@/lib/import/generate-sections';
import { rehostImportAssets } from '@/lib/import/rehost-assets';
import { recordJobStepFailure } from '@/lib/jobs/step-failure';
import type { PageCapture } from '@/lib/import/types';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('@/lib/jobs/step-failure', () => ({
  recordJobStepFailure: vi.fn(async () => undefined),
}));

const recordStep = vi.mocked(recordJobStepFailure);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function pageCapture(overrides: Partial<PageCapture> = {}): PageCapture {
  return {
    sourceUrl: 'https://example.com',
    desktopPng: Buffer.from('desk'),
    mobilePng: Buffer.from('mob'),
    tokens: {
      fontFamily: 'Inter',
      fontSizes: ['16px'],
      colors: ['#111111'],
      radii: ['8px'],
      spacingRhythm: ['16px'],
    },
    images: [],
    firecrawlText: 'Welcome to Example',
    capturedAt: new Date('2026-08-18T00:00:00.000Z'),
    firecrawl: { ok: true, markdown: 'Welcome to Example' },
    ...overrides,
  };
}

beforeEach(() => {
  recordStep.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('failed fetch is not an empty page', () => {
  it('does not treat HTTP 401 as a successful empty scrape', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: false }, 401));

    const result = await scrapeFirecrawlText('https://example.com', {
      apiKey: 'test-key',
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failed fetch, not an empty page');
    expect(result.reason).toBe('unauthorized');
    expect(result.status).toBe(401);
    expect(result).not.toEqual({ ok: true, markdown: '' });
  });

  it('does not treat HTTP 429 as a successful empty scrape', async () => {
    const result = await scrapeFirecrawlText('https://example.com', {
      apiKey: 'test-key',
      fetchImpl: async () => jsonResponse({}, 429),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failed fetch, not an empty page');
    expect(result.reason).toBe('rate_limit');
    expect(result.status).toBe(429);
  });

  it('does not treat HTTP 503 as a successful empty scrape', async () => {
    const result = await scrapeFirecrawlText('https://example.com', {
      apiKey: 'test-key',
      fetchImpl: async () => jsonResponse({}, 503),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failed fetch, not an empty page');
    expect(result.reason).toBe('http');
    expect(result.status).toBe(503);
  });

  it('does not treat a network error as a successful empty scrape', async () => {
    const result = await scrapeFirecrawlText('https://example.com', {
      apiKey: 'test-key',
      fetchImpl: async () => {
        throw new Error('fetch failed');
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failed fetch, not an empty page');
    expect(result.reason).toBe('network');
    expect(result.detail).toMatch(/fetch failed/i);
  });

  it('does not treat a timeout as a successful empty scrape', async () => {
    const result = await scrapeFirecrawlText('https://example.com', {
      apiKey: 'test-key',
      fetchImpl: async () => {
        throw new Error('The operation was aborted due to timeout');
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failed fetch, not an empty page');
    expect(result.reason).toBe('timeout');
  });

  it('does not treat a missing Firecrawl key as a successful empty scrape', async () => {
    const fetchImpl = vi.fn();
    const result = await scrapeFirecrawlText('https://example.com', {
      apiKey: '',
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failed fetch, not an empty page');
    expect(result.reason).toBe('missing_key');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps a 200 with no markdown as fetched-but-empty, not a fetch failure', async () => {
    const result = await scrapeFirecrawlText('https://example.com', {
      apiKey: 'test-key',
      fetchImpl: async () => jsonResponse({ success: true, data: { markdown: '   ' } }),
    });

    expect(result).toEqual({ ok: true, markdown: '' });
    expect(FIRECRAWL_EMPTY_IS_NOT_FAILURE).toBe(true);
  });

  it('returns markdown when Firecrawl actually scraped the page', async () => {
    const result = await scrapeFirecrawlText('https://example.com', {
      apiKey: 'test-key',
      fetchImpl: async () =>
        jsonResponse({ success: true, data: { markdown: '# Hello from the source' } }),
    });

    expect(result).toEqual({ ok: true, markdown: '# Hello from the source' });
  });

  it('treats HTTP 200 with success:false as a failed scrape, not an empty page', async () => {
    const result = await scrapeFirecrawlText('https://example.com', {
      apiKey: 'test-key',
      fetchImpl: async () => jsonResponse({ success: false, data: {} }, 200),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failed fetch, not an empty page');
    expect(result.reason).toBe('http');
  });
});

describe('Firecrawl failure English', () => {
  it('names the status and a next step, and does not blame the user URL', () => {
    const unauthorized: FirecrawlScrapeFailed = { ok: false, reason: 'unauthorized', status: 401 };
    const message = firecrawlFailureMessage(unauthorized);
    expect(message).toMatch(/Firecrawl returned 401/);
    expect(message).toBe(
      'We could not read the page text — Firecrawl returned 401. Ask an administrator to check the Firecrawl key, then try the import again.',
    );
    expect(message).toMatch(/try the import again/i);
    expect(message).not.toMatch(/your URL/i);
    expect(message).not.toMatch(/no markdown/i);
    expect(message).not.toMatch(/build failed/i);
    expect(message).not.toContain('test-key');
  });

  it('does not leak the API key in a network detail', () => {
    const message = firecrawlFailureMessage({
      ok: false,
      reason: 'network',
      detail: 'Bearer test-key-should-not-appear refused',
    });
    expect(message).not.toContain('test-key-should-not-appear');
    expect(message).toMatch(/could not reach Firecrawl/i);
  });

  it('explains a missing key as our configuration, not an empty page', () => {
    const message = firecrawlFailureMessage({ ok: false, reason: 'missing_key' });
    expect(message).toMatch(/Firecrawl is not configured/);
    expect(message).toMatch(/administrator/);
    expect(message).not.toMatch(/no readable text/i);
  });
});

describe('import pipeline surfaces a Firecrawl failure', () => {
  it('tells chat and records a job step, then continues from the screenshot', async () => {
    const progress: string[] = [];
    const firecrawl: FirecrawlScrapeFailed = { ok: false, reason: 'unauthorized', status: 401 };

    const result = await runUrlImportPipeline({
      projectId: 'proj_test',
      sourceUrl: 'https://example.com',
      mode: 'reimagine',
      stack: 'NEXTJS',
      designDirection: 'minimal',
      userId: 'user_test',
      jobId: 'job_import_1',
      capture: async () =>
        pageCapture({
          firecrawlText: '',
          firecrawl,
        }),
      rehost: async () => ({ assets: [], warnings: [] }),
      segment: async () => [
        {
          id: 'hero',
          label: 'Hero',
          purpose: 'intro',
          contentSummary: 'Headline',
          approximateYRange: [0, 400],
        },
      ],
      generateSections: async () => ({
        filesXml: '<file path="app/page.tsx">from screenshot</file>',
        inputTokens: 10,
      }),
      generateFallback: async () => {
        throw new Error('must not fall back just because Firecrawl failed');
      },
      persistSource: async () => undefined,
      onProgress: (message) => progress.push(message),
    });

    const english = firecrawlFailureMessage(firecrawl);
    expect(progress).toContain(english);
    expect(result.warnings).toContain(english);
    expect(result.filesXml).toContain('from screenshot');
    expect(result.usedFallback).toBe(false);
    expect(recordStep).toHaveBeenCalledWith('job_import_1', {
      key: 'firecrawl',
      label: 'Reading page text',
      error: english,
    });
  });

  it('does not record a job step when the page was fetched but empty', async () => {
    const progress: string[] = [];
    await runUrlImportPipeline({
      projectId: 'proj_test',
      sourceUrl: 'https://example.com',
      mode: 'reimagine',
      stack: 'NEXTJS',
      designDirection: 'minimal',
      userId: 'user_test',
      jobId: 'job_import_2',
      capture: async () =>
        pageCapture({
          firecrawlText: '',
          firecrawl: { ok: true, markdown: '' },
        }),
      rehost: async () => ({ assets: [], warnings: [] }),
      segment: async () => [
        {
          id: 'hero',
          label: 'Hero',
          purpose: 'intro',
          contentSummary: 'Headline',
          approximateYRange: [0, 400],
        },
      ],
      generateSections: async () => ({
        filesXml: '<file path="app/page.tsx">from screenshot</file>',
        inputTokens: 10,
      }),
      persistSource: async () => undefined,
      onProgress: (message) => progress.push(message),
    });

    expect(recordStep).not.toHaveBeenCalled();
    expect(progress.join('\n')).not.toMatch(/Firecrawl returned/);
    expect(progress.join('\n')).not.toMatch(/Firecrawl is not configured/);
  });

  it('refuses to call an empty filesXml a successful import', async () => {
    await expect(
      runUrlImportPipeline({
        projectId: 'proj_test',
        sourceUrl: 'https://example.com',
        mode: 'reimagine',
        stack: 'NEXTJS',
        designDirection: 'minimal',
        userId: 'user_test',
        capture: async () => pageCapture(),
        rehost: async () => ({ assets: [], warnings: [] }),
        segment: async () => {
          throw new Error('No sections');
        },
        generateFallback: async () => ({ filesXml: '   ', inputTokens: 0 }),
        persistSource: async () => undefined,
      }),
    ).rejects.toThrow(IMPORT_NO_FILES_MESSAGE);
  });
});

describe('section generation severity', () => {
  it('keeps going when at least one section was written', () => {
    expect(sectionGenerationSeverity({ succeeded: 2, failed: 1 })).toBe('compose');
    expect(sectionGenerateFailureMessage('Pricing', 'model timed out')).toMatch(
      /Section "Pricing" could not be generated \(model timed out\)/,
    );
    expect(sectionGenerateFailureMessage('Pricing', 'model timed out')).toMatch(/other sections/);
    expect(sectionGenerateFailureMessage('Pricing', 'model timed out')).not.toMatch(/build failed/i);
  });

  it('falls back only when every section failed', () => {
    expect(sectionGenerationSeverity({ succeeded: 0, failed: 3 })).toBe('fallback');
  });

  it('writes the sections that succeeded when one section fails', async () => {
    const progress: string[] = [];
    const result = await generateImportedSections({
      projectId: 'proj_test',
      userId: 'user_test',
      stack: 'STATIC_HTML',
      designDirection: 'minimal',
      mode: 'reimagine',
      capture: pageCapture(),
      sections: [
        {
          id: 'hero',
          label: 'Hero',
          purpose: 'intro',
          contentSummary: 'Headline',
          approximateYRange: [0, 400],
        },
        {
          id: 'pricing',
          label: 'Pricing',
          purpose: 'plans',
          contentSummary: 'Tiers',
          approximateYRange: [400, 800],
        },
      ],
      assets: [],
      jobId: 'job_import_3',
      onProgress: (message) => progress.push(message),
      complete: async ({ volatileUser }) => {
        if (volatileUser.includes('Pricing')) {
          throw new Error('model timed out');
        }
        return { text: `<file path="ok.html">${volatileUser.slice(0, 24)}</file>`, inputTokens: 3 };
      },
    });

    expect(result.filesXml).toContain('ok.html');
    expect(result.warnings).toEqual([
      sectionGenerateFailureMessage('Pricing', 'model timed out'),
    ]);
    expect(progress).toContain(sectionGenerateFailureMessage('Pricing', 'model timed out'));
    expect(recordStep).toHaveBeenCalledWith('job_import_3', {
      key: 'section:pricing',
      label: 'Building Pricing',
      error: sectionGenerateFailureMessage('Pricing', 'model timed out'),
    });
  });
});

describe('SSRF rejection stays a failure and explains itself', () => {
  it('does not rewrite an UnsafeUrlError into an empty page or a blocked-site line', () => {
    const error = new UnsafeUrlError('private');
    const next = toBlockedAccessError(error);
    expect(next).toBe(error);
    expect(next).toBeInstanceOf(UnsafeUrlError);
    expect((next as UnsafeUrlError).message).toBe(URL_GUARD_MESSAGES.private);
    expect((next as UnsafeUrlError).message).not.toBe('');
    expect((next as UnsafeUrlError).message).toMatch(/private network/i);
  });
});

describe('capture.ts no longer collapses Firecrawl failures', () => {
  it('does not return an empty string on a failed Firecrawl response', () => {
    const source = readFileSync(path.join(process.cwd(), 'lib/import/capture.ts'), 'utf8');
    expect(source).not.toMatch(/if\s*\(\s*!response\.ok\s*\)\s*return\s*''/);
    expect(source).toMatch(/scrapeFirecrawlText/);
  });
});

describe('rehost sibling: a failed image fetch is a warning, not an empty asset', () => {
  it('includes the real error instead of a silent skip', async () => {
    const result = await rehostImportAssets({
      projectId: 'proj_test',
      images: [{ url: 'https://example.com/hero.png', width: 100, height: 80 }],
      fetchImpl: async () => {
        throw new Error('ECONNRESET');
      },
    });

    expect(result.assets).toEqual([]);
    expect(result.warnings).toEqual([
      'skipped https://example.com/hero.png (fetch failed: ECONNRESET)',
    ]);
  });
});
