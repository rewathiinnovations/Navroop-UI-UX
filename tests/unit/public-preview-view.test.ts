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
    // The page may probe the already-validated preview origin from the server —
    // a dead host otherwise renders as a blank cross-origin frame with nothing
    // for the viewer to act on — but it must never call this app's own API: it
    // is anonymous chrome, and a fetch of /api/projects from here would be a
    // second, unauthenticated minting path for the signed URL.
    expect(source).not.toMatch(/fetch\s*\([^)]*\/api\//);
    // The only fetch allowed is the probe of the resolved frame src itself.
    for (const match of source.matchAll(/fetch\s*\(\s*([\w.]+)/g)) {
      expect(match[1]).toBe('iframeSrc');
    }
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

describe('the loopback sibling frame src', () => {
  it('accepts plain http between two loopback names', () => {
    // Local development's sibling origin. It cannot leave the machine, and
    // browsers treat .localhost as a secure context.
    const src = resolvePublicPreviewFrameSrc(
      'http://preview-static.localhost:3000/cmproj/?token=t',
      'http://preview-static.localhost:3000',
    );
    expect(src).toBe('http://preview-static.localhost:3000/cmproj/?token=t');
  });

  it('still refuses http anywhere real', () => {
    expect(
      resolvePublicPreviewFrameSrc(
        'http://preview-static.navroop.example/cmproj/?token=t',
        'http://preview-static.navroop.example',
      ),
    ).toBeNull();
  });

  it('still refuses a target whose origin is not the preview origin, loopback included', () => {
    // localhost:3000 IS the app origin - framing it would put model-authored
    // markup on the app origin, which is the F-140 hole.
    expect(
      resolvePublicPreviewFrameSrc(
        'http://localhost:3000/preview-static/cmproj/?token=t',
        'http://preview-static.localhost:3000',
      ),
    ).toBeNull();
  });
});
