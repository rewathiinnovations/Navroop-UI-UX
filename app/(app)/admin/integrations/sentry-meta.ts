import { SENTRY_OAUTH_SCOPES, sentryOAuthSettingsUrl } from '@/lib/integrations/sentry';

const RELATIVE_CALLBACK = '/api/integrations/sentry/callback';

export type SentryAdminMeta = {
  redirectUrl: string;
  settingsUrl: string;
  scopes: readonly string[];
};

/**
 * Same string on the server and in the browser. A missing `initial.sentry` used
 * to pick `window.location.origin` only after hydrate, which flipped the
 * redirect URL and could throw a hydration overlay.
 */
export function resolveSentryMeta(sentry?: Partial<SentryAdminMeta> | null): SentryAdminMeta {
  const redirectUrl = sentry?.redirectUrl?.trim();
  if (sentry && redirectUrl) {
    return {
      redirectUrl,
      settingsUrl: sentry.settingsUrl?.trim() || sentryOAuthSettingsUrl(),
      scopes: sentry.scopes?.length ? sentry.scopes : SENTRY_OAUTH_SCOPES,
    };
  }
  return {
    redirectUrl: RELATIVE_CALLBACK,
    settingsUrl: sentryOAuthSettingsUrl(),
    scopes: SENTRY_OAUTH_SCOPES,
  };
}
