import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { proxy } from '../../proxy';
import PublicPreviewShell from '@/components/preview/PublicPreviewShell';
import {
  PUBLIC_PREVIEW_VIEW_PATH,
  canOpenPreviewInNewTab,
  parsePublicPreviewViewSearch,
  publicPreviewViewHref,
  resolveNewTabPreviewHref,
} from '@/lib/preview/public-view';
import { issuePreviewToken } from '@/lib/preview/token';
import { getCurrentProjectFiles } from '@/lib/github/current-files';

vi.mock('@/components/workspace/BrowserPreview', () => ({
  BrowserPreview: ({ files, stack }: { files: Record<string, string>; stack: string }) =>
    createElement(
      'div',
      { 'data-preview': 'browser', 'data-stack': stack },
      Object.keys(files).sort().join(','),
    ),
}));

const PROJECT = 'proj-1';
const TOKEN = 'abc.def';

beforeEach(() => {
  process.env.AUTH_SECRET = 'preview-test-secret';
});

describe('publicPreviewViewHref', () => {
  it('builds /preview-view?projectId=&token= — not a Cloudflare u= URL', () => {
    const href = publicPreviewViewHref({ projectId: PROJECT, token: TOKEN });
    expect(href).toBe(`${PUBLIC_PREVIEW_VIEW_PATH}?projectId=${PROJECT}&token=${TOKEN}`);
    expect(href).not.toContain('u=');
    expect(href).not.toContain('preview-static');
    expect(href).not.toContain('navroop.app');
  });
});

describe('parsePublicPreviewViewSearch', () => {
  it('accepts projectId+token and refuses a leftover u= signed URL', () => {
    expect(parsePublicPreviewViewSearch({ projectId: PROJECT, token: TOKEN })).toEqual({
      projectId: PROJECT,
      token: TOKEN,
    });
    expect(
      parsePublicPreviewViewSearch({
        u: 'https://preview-static.navroop.app/proj-1/?token=abc',
      }),
    ).toBeNull();
    expect(parsePublicPreviewViewSearch({ projectId: PROJECT })).toBeNull();
    expect(parsePublicPreviewViewSearch({ token: TOKEN })).toBeNull();
  });
});

describe('canOpenPreviewInNewTab', () => {
  it('enables when the project has files — even before GET mints a previewUrl', () => {
    expect(
      canOpenPreviewInNewTab({
        hasStoredFiles: true,
        previewUrl: '/preview-view?projectId=p&token=t',
      }),
    ).toBe(true);
    expect(canOpenPreviewInNewTab({ hasStoredFiles: true, previewUrl: null })).toBe(true);
    expect(
      canOpenPreviewInNewTab({
        hasStoredFiles: false,
        previewUrl: '/preview-view?projectId=p&token=t',
      }),
    ).toBe(false);
    expect(canOpenPreviewInNewTab({ hasStoredFiles: false, previewUrl: null })).toBe(false);
  });
});

describe('resolveNewTabPreviewHref', () => {
  it('uses the existing /preview-view href and otherwise mints one', async () => {
    const href = '/preview-view?projectId=p&token=t';
    await expect(resolveNewTabPreviewHref({ previewUrl: href })).resolves.toBe(href);
    await expect(
      resolveNewTabPreviewHref({
        previewUrl: null,
        mint: async () => '/preview-view?projectId=p&token=minted',
      }),
    ).resolves.toBe('/preview-view?projectId=p&token=minted');
    await expect(resolveNewTabPreviewHref({ previewUrl: null })).resolves.toBeNull();
  });
});

describe('the public preview-view page', () => {
  it('is reachable without a session', async () => {
    const response = await proxy(
      new NextRequest('http://localhost:3000/preview-view', { method: 'GET' }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('signed-in /project/[id]/preview uses BrowserPreview, not an iframe of preview-view', () => {
    const source = readFileSync(resolve('app/project/[id]/preview/page.tsx'), 'utf8');
    expect(source).toContain('BrowserPreview');
    expect(source).toContain('useProjectFiles');
    expect(source).not.toContain('previewUrl');
    expect(source).not.toMatch(/<iframe/);
    expect(source).not.toContain('/api/projects/');
  });

  it('is a server page that loads token-gated files — not a Cloudflare iframe src', () => {
    const source = readFileSync(resolve('app/preview-view/page.tsx'), 'utf8');
    expect(source).not.toMatch(/['"]use client['"]/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toContain('previewStaticBaseUrl');
    expect(source).not.toContain('resolvePublicPreviewFrameSrc');
    expect(source).toContain('loadPublicPreviewSite');
    expect(source).toContain('projectId');
    expect(source).toContain('token');
  });
});

describe('PublicPreviewShell', () => {
  it('renders BrowserPreview for files — not an iframe pointed at preview-static', () => {
    const html = renderToStaticMarkup(
      createElement(PublicPreviewShell, {
        site: {
          ok: true,
          stack: 'NEXTJS',
          designDirection: 'minimal',
          files: { 'app/page.tsx': 'export default function Page() { return null }' },
        },
      }),
    );
    expect(html).toContain('data-preview="browser"');
    expect(html).toContain('app/page.tsx');
    expect(html).not.toContain('preview-static');
    expect(html).not.toContain('src="https://');
    expect(html).toContain('Navroop');
  });

  it('renders no preview when the token or files were refused', () => {
    const html = renderToStaticMarkup(createElement(PublicPreviewShell, { site: null }));
    expect(html).not.toContain('data-preview="browser"');
    expect(html).not.toContain('<iframe');
    expect(html).toContain('Preview is not available');
  });
});

describe('project files exist for a new-tab mint', () => {
  it('treats a non-empty lastCode as a site and an empty one as nothing to preview', () => {
    expect(
      Object.keys(getCurrentProjectFiles({ lastCode: '<file path="index.html">hi</file>' })).length,
    ).toBeGreaterThan(0);
    expect(Object.keys(getCurrentProjectFiles({ lastCode: null })).length).toBe(0);
    expect(Object.keys(getCurrentProjectFiles({ lastCode: '' })).length).toBe(0);
  });

  it('issues a token the public page can verify against the same project', () => {
    const token = issuePreviewToken({ projectId: PROJECT, userId: 'user-1' }, 1_700_000_000_000);
    const href = publicPreviewViewHref({ projectId: PROJECT, token });
    const parsed = parsePublicPreviewViewSearch(
      Object.fromEntries(new URL(href, 'http://x').searchParams),
    );
    expect(parsed?.projectId).toBe(PROJECT);
    expect(parsed?.token).toBe(token);
  });
});
