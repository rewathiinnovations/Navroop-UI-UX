import { createHash, randomBytes } from 'node:crypto';
import { DEFAULT_WORKSPACE_ID } from '@/lib/publish/constants';
import { SENTRY_COPY, SENTRY_OAUTH_SCOPES, sentryOAuthRedirectUrl } from './sentry';
import { persistSentryConnection } from './sentry-persist';
import { getIntegration, setIntegrationLastError, upsertIntegration } from './store';
import type { DecryptedIntegration } from './store';
import { consumeOauthState, createOauthState } from './oauth-state';
import { appPublicUrl } from '@/lib/settings/app-url';
import { workspaceDisplayName } from '@/lib/settings/workspace-name';

const CSRF_PREFIX = 'integration.sentry.oauth';
const TOKEN_URL = 'https://sentry.io/oauth/token/';
const AUTHORIZE_URL = 'https://sentry.io/oauth/authorize/';
const API = 'https://sentry.io/api/0';
const TTL_MS = 15 * 60 * 1000;

type OauthPayload = {
  state: string;
  verifier: string;
  userId: string;
  expiresAt: number;
};

function base64Url(buf: Buffer) {
  return buf.toString('base64url');
}

export function createPkce() {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export async function createSentryOauthState(userId: string) {
  const { verifier, challenge } = createPkce();
  const payload = await createOauthState<OauthPayload>(CSRF_PREFIX, {
    state: randomBytes(24).toString('hex'),
    verifier,
    userId,
    expiresAt: Date.now() + TTL_MS,
  });
  return { state: payload.state, challenge, verifier };
}

export async function consumeSentryOauthState(state: string | null | undefined) {
  return consumeOauthState<OauthPayload>(CSRF_PREFIX, state);
}

export async function sentryAuthorizeUrl(input: {
  clientId: string;
  state: string;
  challenge: string;
  redirectUrl?: string;
}) {
  const redirect = input.redirectUrl ?? sentryOAuthRedirectUrl(await appPublicUrl());
  const params = new URLSearchParams({
    client_id: input.clientId,
    response_type: 'code',
    redirect_uri: redirect,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    scope: SENTRY_OAUTH_SCOPES.join(' '),
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function sentryFetch(path: string, token: string, init?: RequestInit) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body };
}

export async function inspectSentryToken(input: {
  authToken: string;
  projectId?: string;
  fetchFn?: typeof fetch;
}) {
  const fetchFn = input.fetchFn ?? fetch;
  const response = await fetchFn(`${API}/projects/`, {
    headers: { Authorization: `Bearer ${input.authToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 403 || response.status === 401) {
    return { ok: false as const, missingScope: 'project:read' };
  }
  if (!response.ok) {
    return { ok: false as const, missingScope: 'project:read' };
  }
  const projects = (await response.json().catch(() => [])) as Array<{
    id?: string;
    slug?: string;
    organization?: { slug?: string };
  }>;
  const match = input.projectId
    ? projects.find((row) => String(row.id) === String(input.projectId))
    : projects[0];
  return {
    ok: true as const,
    orgSlug: match?.organization?.slug,
    projectSlug: match?.slug,
  };
}

export async function exchangeSentryCode(input: {
  code: string;
  verifier: string;
  clientId: string;
  clientSecret: string;
  redirectUrl?: string;
}) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUrl ?? sentryOAuthRedirectUrl(await appPublicUrl()),
      code_verifier: input.verifier,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
  } | null;
  if (!response.ok || !body?.access_token) {
    return { ok: false as const, error: body?.error || 'Sentry OAuth exchange failed' };
  }
  const scopes = String(body.scope || '')
    .split(/[\s,]+/)
    .filter(Boolean);
  // An empty list is "we could not tell", not "everything is present". The guard used to be
  // `!scopes.includes(required) && scopes.length > 0`, so a response with no `scope` field
  // skipped every check and the token was stored as fully scoped — after which quota,
  // heartbeat and issue calls failed with a 403 that read as a Sentry outage (F-236). The
  // caller stores an unverified connection as `limited` and says why.
  if (scopes.length > 0) {
    for (const required of SENTRY_OAUTH_SCOPES) {
      if (!scopes.includes(required)) {
        return { ok: false as const, error: `Auth token is missing the ${required} scope` };
      }
    }
  }
  return {
    ok: true as const,
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    scopesVerified: scopes.length > 0,
    // Left undefined when Sentry does not say. `ensureSentryAccessToken` treats an unknown
    // expiry as due for refresh rather than inventing one (F-237).
    expiresAt: body.expires_in
      ? new Date(Date.now() + body.expires_in * 1000).toISOString()
      : undefined,
  };
}

export async function refreshSentryToken(input: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: input.clientId,
      client_secret: input.clientSecret,
      refresh_token: input.refreshToken,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  } | null;
  if (!response.ok || !body?.access_token) {
    return { ok: false as const, error: SENTRY_COPY.refreshFailed };
  }
  return {
    ok: true as const,
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? input.refreshToken,
    expiresAt: body.expires_in
      ? new Date(Date.now() + body.expires_in * 1000).toISOString()
      : undefined,
  };
}

/**
 * A usable Sentry access token, refreshing it when it is expiring or when we cannot say.
 *
 * An absent `tokenExpiresAt` used to make the comparison `NaN`, so the guard was false and
 * the existing token was returned unconditionally — "we don't know when this expires"
 * silently became "it does not expire", and the token was used until Sentry rejected it
 * (F-237). Unknown now means due: a refresh is cheap and a 401 in the quota cron is not.
 *
 * When there is no refresh material the token is still returned, because it is the only one
 * there is and it may well work — but as `unverified`, with the reason recorded on the row
 * that `/admin/integrations` and `/admin/health` render. Returning it as plainly `ok` was
 * how a connection nobody could vouch for looked healthy.
 */
export async function ensureSentryAccessToken(row: DecryptedIntegration) {
  const token = row.secrets.authToken?.trim();
  const expiresAt = row.secrets.tokenExpiresAt ? Date.parse(row.secrets.tokenExpiresAt) : NaN;
  const expiryKnown = !Number.isNaN(expiresAt);
  const dueForRefresh = !expiryKnown || expiresAt - Date.now() < 5 * 60 * 1000;
  if (token && !dueForRefresh) return { ok: true as const, authToken: token, unverified: false };
  const refreshToken = row.secrets.refreshToken?.trim();
  const clientId = row.config.oauthClientId?.trim();
  const clientSecret = row.secrets.clientSecret?.trim();
  if (!refreshToken || !clientId || !clientSecret) {
    if (!token) return { ok: false as const, error: SENTRY_COPY.refreshFailed };
    // Recorded once. This runs on every quota and health check, and rewriting an unchanged
    // warning on each one would be a database write per cron tick.
    if (row.lastError !== SENTRY_COPY.unrefreshable) {
      await setIntegrationLastError({ kind: 'SENTRY', message: SENTRY_COPY.unrefreshable });
    }
    return { ok: true as const, authToken: token, unverified: true };
  }
  const refreshed = await refreshSentryToken({ refreshToken, clientId, clientSecret });
  if (!refreshed.ok) {
    await upsertIntegration({
      kind: 'SENTRY',
      status: 'ERROR',
      lastError: SENTRY_COPY.refreshFailed,
    });
    return { ok: false as const, error: SENTRY_COPY.refreshFailed };
  }
  await upsertIntegration({
    kind: 'SENTRY',
    status: row.status === 'ERROR' ? 'CONNECTED' : row.status,
    mergeSecrets: {
      authToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      tokenExpiresAt: refreshed.expiresAt,
    },
    lastError: null,
  });
  return { ok: true as const, authToken: refreshed.accessToken, unverified: false };
}

export async function listSentryOrgs(token: string) {
  const result = await sentryFetch('/organizations/', token);
  if (!result.ok) return { ok: false as const, error: 'Could not list Sentry organizations' };
  const orgs = (Array.isArray(result.body) ? result.body : []).map(
    (row: { slug?: string; name?: string }) => ({
      slug: String(row.slug || ''),
      name: String(row.name || row.slug || ''),
    }),
  );
  return { ok: true as const, orgs };
}

export async function listSentryProjects(token: string, orgSlug: string) {
  const result = await sentryFetch(
    `/organizations/${encodeURIComponent(orgSlug)}/projects/`,
    token,
  );
  if (!result.ok) return { ok: false as const, error: 'Could not list Sentry projects' };
  const projects = (Array.isArray(result.body) ? result.body : []).map(
    (row: { id?: string; slug?: string; name?: string }) => ({
      id: String(row.id || ''),
      slug: String(row.slug || ''),
      name: String(row.name || row.slug || ''),
    }),
  );
  return { ok: true as const, projects };
}

export async function createSentryProject(token: string, orgSlug: string, name: string) {
  const teams = await sentryFetch(`/organizations/${encodeURIComponent(orgSlug)}/teams/`, token);
  const teamSlug = (Array.isArray(teams.body) ? teams.body[0]?.slug : undefined) || orgSlug;
  const created = await sentryFetch(
    `/teams/${encodeURIComponent(orgSlug)}/${encodeURIComponent(teamSlug)}/projects/`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({ name, platform: 'javascript-nextjs' }),
    },
  );
  if (!created.ok) return { ok: false as const, error: 'Could not create a Sentry project' };
  const body = created.body as { id?: string; slug?: string; name?: string };
  return {
    ok: true as const,
    project: {
      id: String(body.id || ''),
      slug: String(body.slug || ''),
      name: String(body.name || name),
    },
  };
}

export async function fetchSentryDsn(token: string, orgSlug: string, projectSlug: string) {
  const result = await sentryFetch(
    `/projects/${encodeURIComponent(orgSlug)}/${encodeURIComponent(projectSlug)}/keys/`,
    token,
  );
  if (!result.ok) return { ok: false as const, error: 'Could not read the Sentry DSN' };
  const keys = Array.isArray(result.body) ? result.body : [];
  const dsn = keys[0]?.dsn?.public as string | undefined;
  if (!dsn) return { ok: false as const, error: 'Sentry project has no client key' };
  return { ok: true as const, dsn };
}

export async function finishSentryOauthSelect(input: {
  orgSlug: string;
  projectSlug?: string;
  createProject?: boolean;
  connectedById?: string;
}) {
  const row = await getIntegration(DEFAULT_WORKSPACE_ID, 'SENTRY');
  if (!row?.secrets.authToken)
    return { ok: false as const, error: 'Sentry OAuth is not in progress' };
  const token = row.secrets.authToken;
  let projectSlug = input.projectSlug?.trim() || '';
  let projectId = row.config.projectId || '';
  if (input.createProject || !projectSlug) {
    const workspaceName = await workspaceDisplayName();
    const created = await createSentryProject(token, input.orgSlug, workspaceName);
    if (!created.ok) return created;
    projectSlug = created.project.slug;
    projectId = created.project.id;
  }
  if (!projectId) {
    const listed = await listSentryProjects(token, input.orgSlug);
    const match = listed.ok ? listed.projects.find((row) => row.slug === projectSlug) : undefined;
    projectId = match?.id || '';
  }
  const dsnResult = await fetchSentryDsn(token, input.orgSlug, projectSlug);
  if (!dsnResult.ok) return dsnResult;
  const { parseSentryDsn } = await import('@/lib/observability/dsn');
  const parsed = parseSentryDsn(dsnResult.dsn);
  if (!parsed) return { ok: false as const, error: SENTRY_COPY.malformedDsn };
  await persistSentryConnection({
    dsn: dsnResult.dsn,
    projectId: parsed.projectId,
    host: parsed.host,
    environment: process.env.NODE_ENV || 'production',
    // Carried through, not asserted: a token whose scopes Sentry never reported stays
    // `limited` all the way to the connected row (F-236).
    limited: Boolean(row.config.limited),
    authToken: token,
    refreshToken: row.secrets.refreshToken,
    clientSecret: row.secrets.clientSecret,
    tokenExpiresAt: row.secrets.tokenExpiresAt,
    orgSlug: input.orgSlug,
    projectSlug,
    installationName: 'Sentry',
    connectedById: input.connectedById,
  });
  await upsertIntegration({
    kind: 'SENTRY',
    status: 'CONNECTED',
    config: {
      oauthClientId: row.config.oauthClientId,
      orgSlug: input.orgSlug,
      projectSlug,
      projectId: parsed.projectId,
    },
  });
  return { ok: true as const, orgSlug: input.orgSlug, projectSlug, projectId: parsed.projectId };
}
