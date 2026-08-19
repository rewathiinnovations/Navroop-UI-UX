import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';
import {
  consumeSentryOauthState,
  exchangeSentryCode,
  listSentryOrgs,
} from '@/lib/integrations/sentry-oauth';
import { getIntegration, upsertIntegration } from '@/lib/integrations/store';
import { appPublicUrl } from '@/lib/settings/app-url';

export async function GET(request: NextRequest) {
  const origin = await appPublicUrl();
  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  const csrf = await consumeSentryOauthState(state);
  if (!csrf || !code) {
    return NextResponse.redirect(new URL('/admin/integrations?sentry=oauth-error', origin));
  }
  const row = await getIntegration(DEFAULT_WORKSPACE_ID, 'SENTRY');
  const clientId = row?.config.oauthClientId?.trim() || '';
  const clientSecret = row?.secrets.clientSecret?.trim() || '';
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(new URL('/admin/integrations?sentry=oauth-error', origin));
  }
  const exchanged = await exchangeSentryCode({
    code,
    verifier: csrf.verifier,
    clientId,
    clientSecret,
  });
  if (!exchanged.ok) {
    await upsertIntegration({
      kind: 'SENTRY',
      status: 'ERROR',
      lastError: exchanged.error,
    });
    return NextResponse.redirect(new URL('/admin/integrations?sentry=oauth-error', origin));
  }
  await upsertIntegration({
    kind: 'SENTRY',
    status: 'PENDING',
    config: { oauthClientId: clientId },
    secrets: {
      authToken: exchanged.accessToken,
      refreshToken: exchanged.refreshToken,
      clientSecret,
      tokenExpiresAt: exchanged.expiresAt,
    },
    connectedById: csrf.userId,
    lastError: null,
  });
  const orgs = await listSentryOrgs(exchanged.accessToken);
  const auto = orgs.ok && orgs.orgs.length === 1 ? orgs.orgs[0].slug : '';
  const next = new URL('/admin/integrations', origin);
  next.searchParams.set('sentry', 'oauth');
  if (auto) next.searchParams.set('org', auto);
  return NextResponse.redirect(next);
}
