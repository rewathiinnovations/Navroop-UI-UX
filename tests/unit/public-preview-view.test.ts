import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { proxy } from '../../proxy';
import PublicPreviewShell from '@/components/preview/PublicPreviewShell';
import {
  PUBLIC_PREVIEW_VIEW_PATH,
  publicPreviewViewHref,
  resolvePublicPreviewFrameSrc,
} from '@/lib/preview/public-view';

const PREVIEW_ORIGIN = 'https://preview-static.zone.example';
const SIGNED = `${PREVIEW_ORIGIN}/proj-1/?token=abc.def`;
const APP_ORIGIN = 'https://navroop.example';

describe('resolvePublicPreviewFrameSrc', () => {
  it('accepts a signed URL on the configured preview origin', () => {
    expect(resolvePublicPreviewFrameSrc(SIGNED, PREVIEW_ORIGIN)).toBe(SIGNED);
  });

  it('rejects an app-origin URL even when someone pastes it as the destination', () => {
    expect(
      resolvePublicPreviewFrameSrc(`${APP_ORIGIN}/preview-static/proj-1/?token=t`, PREVIEW_ORIGIN),
    ).toBeNull();
  });

  it('rejects any other host — this is not an open redirect or generic iframe', () => {
    expect(
      resolvePublicPreviewFrameSrc('https://evil.example/proj-1/?token=t', PREVIEW_ORIGIN),
    ).toBeNull();
  });

  it('rejects when no distinct preview origin is configured', () => {
    expect(resolvePublicPreviewFrameSrc(SIGNED, null)).toBeNull();
  });

  it('rejects a relative or javascript URL', () => {
    expect(
      resolvePublicPreviewFrameSrc('/preview-static/proj-1/?token=t', PREVIEW_ORIGIN),
    ).toBeNull();
    expect(resolvePublicPreviewFrameSrc('javascript:alert(1)', PREVIEW_ORIGIN)).toBeNull();
  });

  it('rejects a preview-origin URL that has no token', () => {
    expect(resolvePublicPreviewFrameSrc(`${PREVIEW_ORIGIN}/proj-1/`, PREVIEW_ORIGIN)).toBeNull();
  });
});

describe('publicPreviewViewHref', () => {
  it('wraps the already-minted signed destination in the public shell path', () => {
    expect(publicPreviewViewHref(SIGNED)).toBe(
      `${PUBLIC_PREVIEW_VIEW_PATH}?u=${encodeURIComponent(SIGNED)}`,
    );
  });
});

describe('the public preview-view page', () => {
  it('is reachable without a session — chrome only, no new API to mint', async () => {
    const response = await proxy(
      new NextRequest('http://localhost:3000/preview-view', { method: 'GET' }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('is a server page that validates the query URL — not a client fetch of /api/projects', () => {
    const source = readFileSync(resolve('app/preview-view/page.tsx'), 'utf8');
    expect(source).not.toMatch(/['"]use client['"]/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).toContain('resolvePublicPreviewFrameSrc');
    expect(source).toContain('previewStaticBaseUrl');
  });
});

describe('PublicPreviewShell', () => {
  it('iframes only the given src with the BrowserPreview sandbox (no allow-same-origin)', () => {
    const html = renderToStaticMarkup(createElement(PublicPreviewShell, { iframeSrc: SIGNED }));
    expect(html).toContain(`src="${SIGNED}"`);
    expect(html).toContain('sandbox="allow-scripts allow-forms allow-modals allow-popups"');
    expect(html).not.toContain('allow-same-origin');
    expect(html).toContain('Navroop');
  });

  it('renders no iframe when the destination was refused', () => {
    const html = renderToStaticMarkup(createElement(PublicPreviewShell, { iframeSrc: null }));
    expect(html).not.toContain('<iframe');
    expect(html).toContain('Preview is not available');
  });
});
