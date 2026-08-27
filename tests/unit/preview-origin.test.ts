import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-140: the static preview serves model-authored HTML and JavaScript. It must
 * never do so from the application's own origin — a top-level preview document
 * on the app origin runs with the viewer's session cookies and can call
 * `/api/*` as the signed-in user.
 *
 * Resolution order pinned here: connected Cloudflare zone → the `preview.host`
 * setting → refuse (null). The old behaviour, falling back to
 * `${appOrigin}/preview-static`, was the bug.
 */

const integrations = vi.hoisted(() => ({ peekRootDomain: vi.fn() }));
const settings = vi.hoisted(() => ({ getSetting: vi.fn() }));

vi.mock('@/lib/integrations/store', () => ({ peekRootDomain: integrations.peekRootDomain }));
vi.mock('@/lib/settings/resolve', () => ({ getSetting: settings.getSetting }));

import { previewResponseHeaders } from '../../lib/preview/headers';
import { handlePreviewRequest } from '../../lib/preview/serve';
import { signPreviewToken } from '../../lib/preview/token';
import { previewStaticBaseUrl, signedPreviewUrl } from '../../lib/preview/url';
import { openPreviewWindow } from '../../lib/preview/devices';

const APP_ORIGIN = 'https://navroop.example';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_URL = APP_ORIGIN;
  process.env.AUTH_SECRET = 'preview-test';
  integrations.peekRootDomain.mockResolvedValue(null);
  settings.getSetting.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('previewStaticBaseUrl', () => {
  it('uses the connected Cloudflare zone first', async () => {
    integrations.peekRootDomain.mockResolvedValue('zone.example');
    settings.getSetting.mockResolvedValue('preview.other.example');
    await expect(previewStaticBaseUrl()).resolves.toBe('https://preview-static.zone.example');
  });

  it('falls back to the preview.host setting when no zone is connected', async () => {
    settings.getSetting.mockResolvedValue('preview.navroop.example');
    await expect(previewStaticBaseUrl()).resolves.toBe('https://preview.navroop.example');
    expect(settings.getSetting).toHaveBeenCalledWith('preview.host');
  });

  it('accepts a preview host written as a URL or with a trailing slash', async () => {
    settings.getSetting.mockResolvedValue('https://preview.navroop.example/');
    await expect(previewStaticBaseUrl()).resolves.toBe('https://preview.navroop.example');
  });

  it('refuses when nothing is configured — never the app origin', async () => {
    await expect(previewStaticBaseUrl()).resolves.toBeNull();
  });

  it('refuses a preview host that IS the app host', async () => {
    // An operator pasting the app address into the preview-host field must not
    // re-open the same-origin hole the setting exists to close.
    settings.getSetting.mockResolvedValue('navroop.example');
    await expect(previewStaticBaseUrl()).resolves.toBeNull();
  });
});

describe('signedPreviewUrl', () => {
  it('returns null instead of an app-origin URL when no preview origin exists', async () => {
    await expect(signedPreviewUrl({ projectId: 'proj-1', userId: 'user-1' })).resolves.toBeNull();
  });

  it('mints a tokenised URL on the distinct preview origin', async () => {
    integrations.peekRootDomain.mockResolvedValue('zone.example');
    const url = await signedPreviewUrl({ projectId: 'proj-1', userId: 'user-1' });
    expect(url).not.toBeNull();
    const parsed = new URL(url as string);
    expect(parsed.origin).toBe('https://preview-static.zone.example');
    expect(parsed.pathname).toBe('/proj-1/');
    expect(parsed.searchParams.get('token')).toBeTruthy();
  });
});

describe('preview response headers', () => {
  it('does not allow the preview frame to be treated as the parent origin', () => {
    const headers = previewResponseHeaders({ appOrigin: APP_ORIGIN });
    expect(headers['Content-Security-Policy']).toContain(`frame-ancestors 'self' ${APP_ORIGIN}`);
    expect(headers['Referrer-Policy']).toBe('no-referrer');
    expect(headers['Content-Security-Policy']).not.toMatch(/frame-ancestors \*/);
  });

  it('never permits eval and scopes every source', () => {
    const csp = previewResponseHeaders({ appOrigin: APP_ORIGIN })['Content-Security-Policy'];
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("default-src 'self';");
    // The built document inlines its bundle and import map, loads the Tailwind
    // Play CDN, and resolves bare imports from esm.sh (lib/preview/html.ts,
    // lib/preview/deps.ts) — exactly those hosts, not a blanket https:.
    expect(csp).toContain(
      "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://esm.sh",
    );
    // Design briefs import Google Fonts stylesheets
    // (lib/ui-ux-pro-max/build-design-brief.ts).
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(csp).toContain("img-src 'self' data: https:");
    expect(csp).not.toMatch(/default-src[^;]*https:/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-eval'/);
  });
});

describe('preview cache and framing headers', () => {
  it('sends no X-Frame-Options: the only value that ever meant this is dead', () => {
    // `ALLOW-FROM <origin>` was implemented by legacy IE/Edge only and is out of
    // the spec, so every current browser ignores the whole header. Shipping it
    // read as a second layer of framing protection that does not exist (F-150);
    // `frame-ancestors` above is the control, and SAMEORIGIN would be a lie in
    // the other direction — the preview host is deliberately NOT the app origin.
    const headers = previewResponseHeaders({ appOrigin: APP_ORIGIN });
    expect(headers['X-Frame-Options']).toBeUndefined();
  });

  it('never marks a served preview object immutable', async () => {
    // F-149: the flag was `prefix.includes(prefix.split('/').pop())`, which is
    // true of every string, so every 200 — index.html included — went out as
    // `max-age=31536000, immutable`. Nothing in a preview build is
    // content-addressed (lib/preview/bundle.ts writes a fixed `preview.js`), so
    // the entry document would pin permanently the moment the token stopped
    // varying the cache key.
    const now = Date.now();
    const token = signPreviewToken(
      { projectId: 'proj-1', userId: 'user-1' },
      { secret: 'preview-test', now, ttlMs: 60_000 },
    );
    const result = await handlePreviewRequest({
      projectId: 'proj-1',
      path: '/',
      token,
      appOrigin: APP_ORIGIN,
      secret: 'preview-test',
      now,
      loadBuild: async () => ({
        storagePrefix: 'previews/proj-1/build-1',
        entryPath: 'index.html',
        isSpa: false,
      }),
      getObject: async () => Buffer.from('<!doctype html>'),
    });
    expect(result.status).toBe(200);
    expect(result.headers['Cache-Control']).toBe('private, no-store');
  });
});

describe('openPreviewWindow', () => {
  function stubWindow() {
    const open = vi.fn();
    vi.stubGlobal('window', {
      location: { origin: APP_ORIGIN, href: `${APP_ORIGIN}/project/p1` },
      open,
    });
    return open;
  }

  it('refuses to open a same-origin preview URL top-level', () => {
    const open = stubWindow();
    openPreviewWindow(`${APP_ORIGIN}/preview-static/proj-1/?token=t`);
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses a relative preview URL (same-origin by construction)', () => {
    const open = stubWindow();
    openPreviewWindow('/preview-static/proj-1/?token=t');
    expect(open).not.toHaveBeenCalled();
  });

  it('opens a preview on a distinct origin in a plain new tab', () => {
    const open = stubWindow();
    openPreviewWindow('https://preview-static.zone.example/proj-1/?token=t');
    expect(open).toHaveBeenCalledWith(
      'https://preview-static.zone.example/proj-1/?token=t',
      '_blank',
      'noopener,noreferrer',
    );
    // There is no sized-popup variant to assert any more: the "Mobile view" item
    // that opened one was deleted with the header's preview-options dropdown, and
    // the device sizes now live on `/project/[id]/preview`, which iframes the
    // build instead of resizing a browser window.
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('sends a project to the in-app preview page rather than the served origin', () => {
    const open = stubWindow();
    openPreviewWindow('https://preview-static.zone.example/proj-1/?token=t', 'proj 1');
    expect(open).toHaveBeenCalledWith('/project/proj%201/preview', '_blank', 'noopener,noreferrer');
  });
});
