import { describe, expect, it, vi } from 'vitest';
import { resolveSentryMeta } from '../../app/(app)/admin/integrations/sentry-meta';

describe('resolveSentryMeta', () => {
  it('uses the server-provided redirect URL so SSR and the browser print the same string', () => {
    const meta = resolveSentryMeta({
      redirectUrl: 'https://navroop.app/api/integrations/sentry/callback',
      settingsUrl: 'https://sentry.io/settings/account/applications/',
      scopes: ['project:read'],
    });
    expect(meta.redirectUrl).toBe('https://navroop.app/api/integrations/sentry/callback');
    expect(JSON.parse(JSON.stringify(meta))).toEqual(meta);
  });

  it('falls back to a relative callback when sentry is missing — never window.location', () => {
    const missing = resolveSentryMeta(undefined);
    const empty = resolveSentryMeta({
      redirectUrl: '',
      settingsUrl: '',
      scopes: [],
    });
    expect(missing.redirectUrl).toBe('/api/integrations/sentry/callback');
    expect(empty.redirectUrl).toBe('/api/integrations/sentry/callback');
    expect(missing.redirectUrl).toBe(empty.redirectUrl);
    expect(missing.redirectUrl.startsWith('/')).toBe(true);
    expect(missing.redirectUrl).not.toContain('undefined');
    expect(missing.settingsUrl).toBe('https://sentry.io/settings/account/applications/');
    expect(missing.scopes).toEqual(['project:read', 'project:write', 'org:read', 'event:admin']);
  });

  it('does not read window.location when sentry is missing, so SSR and hydrate stay identical', () => {
    vi.stubGlobal('window', { location: { origin: 'https://evil.example' } });
    try {
      expect(resolveSentryMeta(undefined).redirectUrl).toBe('/api/integrations/sentry/callback');
      expect(resolveSentryMeta(undefined).redirectUrl).not.toContain('evil.example');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
