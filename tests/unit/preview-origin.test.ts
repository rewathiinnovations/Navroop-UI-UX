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

  it('opens a preview on a distinct origin, full size and as a device popup', () => {
    const open = stubWindow();
    openPreviewWindow('https://preview-static.zone.example/proj-1/?token=t');
    expect(open).toHaveBeenCalledWith(
      'https://preview-static.zone.example/proj-1/?token=t',
      '_blank',
      'noopener,noreferrer',
    );
    openPreviewWindow('https://preview-static.zone.example/proj-1/?token=t', {
      width: 390,
      height: 844,
    });
    expect(open).toHaveBeenCalledWith(
      'https://preview-static.zone.example/proj-1/?token=t',
      'navroop-preview-device',
      'width=390,height=844,noopener,noreferrer',
    );
  });
});
