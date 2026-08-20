import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { log } from '@/lib/logger';
import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';
import {
  consumeSentryOauthState,
  exchangeSentryCode,
  listSentryOrgs,
} from '@/lib/integrations/sentry-oauth';
import { SENTRY_COPY } from '@/lib/integrations/sentry';
import { getIntegration, upsertIntegration } from '@/lib/integrations/store';
import { appPublicUrl } from '@/lib/settings/app-url';

/**
 * Sentry redirects here after the operator authorises the OAuth app.
 *
 * Admin-gated, and the nonce is bound to that admin's user id — the same two checks its
 * GitHub App twin has always made. This route used to be on the public allowlist with no
 * session check at all, so anyone holding the redirect URL (browser history, a proxy log, a
 * `Referer`) could complete the exchange and write the workspace's Sentry credentials and
 * `connectedById` (F-227). It is a top-level GET navigation, so the session cookie rides
 * along under SameSite=Lax exactly as it does for the GitHub callback; the allowlist entry
 * was never load-bearing.
 */
export async function GET(request: NextRequest) {
  const { user, error, status } = await requireAdmin();
  if (!user) return NextResponse.json({ error }, { status });

  const origin = await appPublicUrl();
  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  const consumed = await consumeSentryOauthState(state);
  if (!consumed.ok || consumed.payload.userId !== user.id) {
    // The reason is logged rather than reflected: it says whether the nonce was unknown,
    // expired or already used, which is what makes a repeated failure diagnosable (F-242).
    log.warn('integrations.sentry_oauth_state_refused', {
      reason: consumed.ok ? 'other-user' : consumed.reason,
      userId: user.id,
    });
    const url = new URL('/admin/integrations', origin);
    url.searchParams.set('sentry', 'oauth-error');
    url.searchParams.set('reason', consumed.ok ? 'state-other-user' : `state-${consumed.reason}`);
    return NextResponse.redirect(url);
  }
  if (!code) {
    return NextResponse.redirect(
      new URL('/admin/integrations?sentry=oauth-error&reason=code', origin),
    );
  }
  const row = await getIntegration(DEFAULT_WORKSPACE_ID, 'SENTRY');
  const clientId = row?.config.oauthClientId?.trim() || '';
  const clientSecret = row?.secrets.clientSecret?.trim() || '';
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(
      new URL('/admin/integrations?sentry=oauth-error&reason=client', origin),
    );
  }
  const exchanged = await exchangeSentryCode({
    code,
    verifier: consumed.payload.verifier,
    clientId,
    clientSecret,
  });
  if (!exchanged.ok) {
    await upsertIntegration({
      kind: 'SENTRY',
      status: 'ERROR',
      lastError: exchanged.error,
    });
    return NextResponse.redirect(
      new URL('/admin/integrations?sentry=oauth-error&reason=exchange', origin),
    );
  }
  await upsertIntegration({
    kind: 'SENTRY',
    status: 'PENDING',
    // A token response that did not name its scopes is stored as `limited` with the reason,
    // rather than accepted as fully scoped and left to fail later as a 403 that reads like a
    // Sentry outage (F-236).
    config: { oauthClientId: clientId, limited: !exchanged.scopesVerified },
    // Partial: this leaves the `clientSecret` the start step stored, and anything else on the
    // row, in place. A total write here is what used to erase live credentials (F-213).
    mergeSecrets: {
      authToken: exchanged.accessToken,
      refreshToken: exchanged.refreshToken,
      tokenExpiresAt: exchanged.expiresAt,
    },
    connectedById: consumed.payload.userId,
    lastError: exchanged.scopesVerified ? null : SENTRY_COPY.scopesUnconfirmed,
  });
  const orgs = await listSentryOrgs(exchanged.accessToken);
  const auto = orgs.ok && orgs.orgs.length === 1 ? orgs.orgs[0].slug : '';
  const next = new URL('/admin/integrations', origin);
  next.searchParams.set('sentry', 'oauth');
  if (auto) next.searchParams.set('org', auto);
  return NextResponse.redirect(next);
}
