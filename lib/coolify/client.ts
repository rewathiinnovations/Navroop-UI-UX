import { decryptServerToken } from './server-token';
import { CoolifyApiError, coolifyErrorMessage } from './errors';
import { scrubSensitive } from '@/lib/sentry/scrub';
import { getCoolifyCredentials } from './settings';

export type CoolifyClient = {
  baseUrl: string;
  last4: string;
  /**
   * Always `'stored'`. The union used to include `'env'`, which nothing could ever produce
   * (no Coolify token is read from the environment), so the admin branches on it were dead
   * (F-252).
   */
  source: 'stored';
  request: (path: string, init?: RequestInit) => Promise<Response>;
  getJson: <T = unknown>(path: string) => Promise<{ ok: boolean; status: number; data: T | null }>;
};

/**
 * Identify the product, not a browser. Both request paths used to send a full desktop Chrome
 * `User-Agent`, which made every server-to-server call indistinguishable from a human in
 * Coolify's own access log — so an operator could not attribute deploy traffic to us, and the
 * spoof read like an attempt to get past something (F-272).
 */
const COOLIFY_USER_AGENT = `Navroop/${process.env.npm_package_version ?? '0.1.0'} (+coolify-api)`;

/**
 * `coolifyFetch` has always had this; the `getCoolifyClient` path had none, so an unresponsive
 * Coolify hung `testCoolifyApiConnection` and `restartNavroopApplication` until the platform
 * killed the request (F-273).
 */
const COOLIFY_TIMEOUT_MS = 30_000;

/** Coolify Integration store first, then encrypted AppSetting. No env token. */
export async function getCoolifyClient(): Promise<CoolifyClient | null> {
  const creds = await getCoolifyCredentials();
  if (!creds.token || creds.source === 'none') return null;

  const request: CoolifyClient['request'] = (path, init) => {
    const url = `${creds.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    // Trusted host — do not route through safeFetch.
    return fetch(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${creds.token}`,
        'User-Agent': COOLIFY_USER_AGENT,
        ...(init?.headers ?? {}),
      },
      // A caller-supplied signal wins: it is the only one that can carry a shorter deadline
      // or a cancellation the caller actually owns.
      signal: init?.signal ?? AbortSignal.timeout(COOLIFY_TIMEOUT_MS),
    });
  };

  return {
    baseUrl: creds.baseUrl,
    last4: creds.last4 ?? '',
    source: creds.source,
    request,
    async getJson<T = unknown>(path: string) {
      const response = await request(path);
      const data = (await response.json().catch(() => null)) as T | null;
      return { ok: response.ok, status: response.status, data };
    },
  };
}

export async function testCoolifyApiConnection() {
  const client = await getCoolifyClient();
  if (!client) {
    return { ok: false as const, status: 0, error: 'Coolify API token is not configured' };
  }

  const version = await client.getJson<{ version?: string } | string>('/api/v1/version');
  if (version.ok) {
    const raw = version.data;
    const label =
      typeof raw === 'string'
        ? raw
        : raw && typeof raw === 'object' && typeof raw.version === 'string'
          ? raw.version
          : 'ok';
    return {
      ok: true as const,
      status: version.status,
      endpoint: '/api/v1/version',
      version: label,
    };
  }

  const servers = await client.getJson('/api/v1/servers');
  if (servers.ok) {
    return { ok: true as const, status: servers.status, endpoint: '/api/v1/servers' };
  }

  return {
    ok: false as const,
    status: version.status || servers.status,
    error: `Coolify API returned ${version.status || servers.status}`,
    endpoint: version.status ? '/api/v1/version' : '/api/v1/servers',
  };
}

export type CoolifyServerAuth = {
  apiUrl: string;
  apiToken: string;
};

export type CreateApplicationInput = {
  repoUrl: string;
  branch: string;
  domain: string;
  deployType: 'static' | 'node';
  buildCommand: string | null;
  outputDir: string | null;
  startCommand: string | null;
  port: number | null;
  dockerfile?: string | null;
  envVars?: Record<string, string>;
  name?: string;
  projectUuid: string;
  serverIp: string;
  basicAuth?: { username: string; password: string } | null;
};

export type DeploymentHealth = 'healthy' | 'failed' | 'building';

function normalizeBase(url: string) {
  return url.trim().replace(/\/+$/, '');
}

/**
 * The bearer token for one server.
 *
 * `decryptServerToken` decides "encrypted or not" from the `enc:v1:` envelope, so the old
 * `includes('==') || length > 80` heuristics are gone — and so is the `catch` that turned a
 * failed decrypt into "send the ciphertext and hope" (F-216). An enc:v1 value that will not
 * open raises before any request is made.
 */
function tokenForServer(server: CoolifyServerAuth) {
  return decryptServerToken(server.apiToken);
}

async function parseBody(response: Response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Retry is opt-in per call site, never inferred from the method.
 *
 * `coolifyFetch` used to retry any `status >= 500` regardless of method, so a 502 that
 * arrived after Coolify had already created the application re-POSTed
 * `/api/v1/applications/public` — a duplicate that runs and bills forever with nothing in
 * the product pointing at it, since cleanup deletes strictly by recorded provenance
 * (F-215). Only pure reads pass `retryOnServerError`. Mutating calls are re-driven by the
 * publish step machine, which persists resource ids and skips completed steps;
 * `createApplication` additionally re-reads by name (`findApplicationByName`) before every
 * attempt, which is the idempotency guard the audit accepts. Note that `triggerDeploy` and
 * `stopApplication` are GETs but MUTATE, so they must never be retried by the transport.
 */
type CoolifyFetchOptions = { retryOnServerError?: boolean };

// One retry: a single transient 5xx on a read is worth absorbing; a persistent one is a
// real failure the caller should see.
const SERVER_ERROR_RETRIES = 1;

async function coolifyFetch(
  server: CoolifyServerAuth,
  path: string,
  init: RequestInit = {},
  { retryOnServerError = false }: CoolifyFetchOptions = {},
): Promise<{ status: number; data: unknown }> {
  const url = `${normalizeBase(server.apiUrl)}${path.startsWith('/') ? path : `/${path}`}`;
  const maxAttempts = retryOnServerError ? SERVER_ERROR_RETRIES + 1 : 1;
  for (let attempt = 1; ; attempt += 1) {
    let response: Response;
    try {
      // Trusted host — do not route through safeFetch.
      response = await fetch(url, {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${tokenForServer(server)}`,
          'Content-Type': 'application/json',
          'User-Agent': COOLIFY_USER_AGENT,
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(COOLIFY_TIMEOUT_MS),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Coolify request failed';
      throw new CoolifyApiError(message, 0, null, path);
    }

    const data = await parseBody(response);
    if (response.ok) return { status: response.status, data };

    if (response.status >= 500 && attempt < maxAttempts) continue;

    throw new CoolifyApiError(
      coolifyErrorMessage(data, `Coolify ${response.status} ${path}`),
      response.status,
      data,
      path,
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pickUuid(value: unknown): string | null {
  const row = asRecord(value);
  const nested = asRecord(row.application ?? row.data);
  const uuid = row.uuid ?? nested.uuid;
  return typeof uuid === 'string' && uuid ? uuid : null;
}

async function resolveServerUuid(server: CoolifyServerAuth, serverIp: string) {
  const { data } = await coolifyFetch(server, '/api/v1/servers', {}, { retryOnServerError: true });
  const list = Array.isArray(data)
    ? data
    : Array.isArray(asRecord(data).data)
      ? (asRecord(data).data as unknown[])
      : [];
  const match = list.find((item) => {
    const row = asRecord(item);
    return (
      row.ip === serverIp || row.ip === `${serverIp}` || String(row.ip || '').includes(serverIp)
    );
  });
  const uuid = match ? pickUuid(match) : null;
  if (uuid) return uuid;
  if (list.length === 1) {
    const only = pickUuid(list[0]);
    if (only) return only;
  }
  throw new CoolifyApiError(
    `Coolify server UUID was not found for ${serverIp}`,
    422,
    data,
    '/api/v1/servers',
  );
}

/**
 * POST creates, PATCH updates: Coolify rejects a POST for a key that already exists,
 * so an update has to fall through to `/envs/update`. Exported because the preview
 * password gate keeps its plaintext on the Coolify application (as `PREVIEW_PASSWORD`)
 * and nowhere else — see `updatePreviewPassword`.
 */
export async function setApplicationEnvVars(
  server: CoolifyServerAuth,
  appUuid: string,
  envVars: Record<string, string>,
) {
  for (const [key, value] of Object.entries(envVars)) {
    await coolifyFetch(server, `/api/v1/applications/${appUuid}/envs`, {
      method: 'POST',
      body: JSON.stringify({ key, value, is_preview: false, is_literal: true }),
    }).catch(async () => {
      await coolifyFetch(server, `/api/v1/applications/${appUuid}/envs/update`, {
        method: 'PATCH',
        body: JSON.stringify({ key, value }),
      });
    });
  }
}

/**
 * The current value of one application env var, or null when the application carries no
 * such key.
 *
 * Reading before writing is what makes a preview-password change reversible: the plaintext
 * lives on the Coolify application and nowhere else, so overwriting `PREVIEW_PASSWORD`
 * without first holding the previous value means a failed re-publish can never put the
 * application back — the row said one password and the container's next build would have
 * accepted another (F-231).
 *
 * The value is a secret. It is returned to one caller and never logged; `lib/coolify/errors.ts`
 * already keeps env payloads out of error text (F-229).
 */
export async function getApplicationEnvVar(
  server: CoolifyServerAuth,
  appUuid: string,
  key: string,
): Promise<string | null> {
  const { data } = await coolifyFetch(
    server,
    `/api/v1/applications/${appUuid}/envs`,
    {},
    { retryOnServerError: true },
  );
  const list = Array.isArray(data) ? data : [];
  for (const entry of list) {
    const row = asRecord(entry);
    if (row.key !== key) continue;
    return typeof row.value === 'string' ? row.value : '';
  }
  return null;
}

export async function listApplications(server: CoolifyServerAuth) {
  const { data } = await coolifyFetch(
    server,
    '/api/v1/applications',
    {},
    { retryOnServerError: true },
  );
  const list = Array.isArray(data)
    ? data
    : Array.isArray(asRecord(data).data)
      ? (asRecord(data).data as unknown[])
      : [];
  return list
    .map((item) => {
      const row = asRecord(item);
      const uuid = pickUuid(row) || '';
      const name = typeof row.name === 'string' ? row.name : '';
      const created = row.created_at ?? row.createdAt;
      return {
        uuid,
        name,
        createdAt: typeof created === 'string' ? new Date(created) : new Date(0),
        raw: row,
      };
    })
    .filter((row) => row.uuid);
}

export async function findApplicationByName(server: CoolifyServerAuth, name: string) {
  const apps = await listApplications(server);
  return apps.find((app) => app.name === name) ?? null;
}

/**
 * Every application on every active server, plus the servers that did not answer.
 *
 * The per-server failure used to be swallowed by a bare `catch` carrying a "skip unreachable
 * server" note, and the only caller is the orphan cron: an unreachable server contributed no
 * applications, so the run enumerated nothing, deleted nothing and reported a healthy "no
 * orphans" — while the operator kept paying for whatever is still up on that box. "Nothing
 * there" and "could not look" have to be different answers.
 *
 * `unreachable` names the server row and an HTTP status where there was one. Never the token:
 * the caller persists this in an `AppSetting` row and returns it in a cron response body.
 */
export async function listManagedApplications() {
  const { prisma } = await import('@/lib/db');
  const { serverAuth } = await import('./servers');
  const servers = await prisma.coolifyServer.findMany({ where: { isActive: true } });
  const apps: Array<{ uuid: string; name: string; createdAt: Date }> = [];
  const unreachable: string[] = [];
  for (const server of servers) {
    try {
      const listed = await listApplications(serverAuth(server));
      for (const app of listed)
        apps.push({ uuid: app.uuid, name: app.name, createdAt: app.createdAt });
    } catch (error) {
      const status = error instanceof CoolifyApiError ? error.status : 0;
      unreachable.push(
        status > 0 ? `${server.name}: HTTP ${status}` : `${server.name}: unreachable`,
      );
    }
  }
  return { apps, unreachable };
}

export async function createApplication(server: CoolifyServerAuth, input: CreateApplicationInput) {
  const existing = input.name ? await findApplicationByName(server, input.name) : null;
  if (existing) {
    if (input.envVars && Object.keys(input.envVars).length > 0) {
      await setApplicationEnvVars(server, existing.uuid, input.envVars);
    }
    return { uuid: existing.uuid, raw: existing.raw, reused: true as const };
  }
  const serverUuid = await resolveServerUuid(server, input.serverIp);
  const buildPack = input.dockerfile
    ? 'dockerfile'
    : input.deployType === 'static' && !input.buildCommand
      ? 'static'
      : 'nixpacks';
  const body: Record<string, unknown> = {
    project_uuid: input.projectUuid,
    server_uuid: serverUuid,
    environment_name: 'production',
    git_repository: input.repoUrl,
    git_branch: input.branch,
    build_pack: buildPack,
    name: input.name || input.domain,
    domains: `https://${input.domain}`,
    fqdn: `https://${input.domain}`,
    is_static: input.deployType === 'static',
    instant_deploy: false,
    is_auto_deploy_enabled: false,
  };
  if (input.buildCommand) body.build_command = input.buildCommand;
  if (input.outputDir) body.publish_directory = input.outputDir;
  if (input.startCommand) body.start_command = input.startCommand;
  if (input.port) body.ports_exposes = String(input.port);
  if (input.dockerfile) body.dockerfile = input.dockerfile;
  if (input.basicAuth) {
    body.is_http_basic_auth_enabled = true;
    body.http_basic_auth_username = input.basicAuth.username;
    body.http_basic_auth_password = input.basicAuth.password;
  }

  const created = await coolifyFetch(server, '/api/v1/applications/public', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const uuid = pickUuid(created.data);
  if (!uuid) {
    throw new CoolifyApiError(
      'Coolify application UUID was not found',
      created.status,
      created.data,
      '/api/v1/applications/public',
    );
  }
  if (input.envVars && Object.keys(input.envVars).length > 0) {
    await setApplicationEnvVars(server, uuid, input.envVars);
  }
  return { uuid, raw: created.data };
}

export async function triggerDeploy(server: CoolifyServerAuth, appUuid: string) {
  const { data } = await coolifyFetch(
    server,
    `/api/v1/deploy?uuid=${encodeURIComponent(appUuid)}&force=true`,
  );
  const row = asRecord(Array.isArray(data) ? data[0] : data);
  const deployments = Array.isArray(row.deployments) ? row.deployments : [];
  const first = asRecord(deployments[0] ?? row);
  const deploymentUuid =
    typeof first.deployment_uuid === 'string'
      ? first.deployment_uuid
      : typeof first.uuid === 'string'
        ? first.uuid
        : null;
  return { raw: data, deploymentUuid };
}

/**
 * Map a Coolify deployment-queue status to the three states the publish loop acts on.
 *
 * Coolify's own vocabulary (`queued`, `in_progress`, `finished`, `failed`,
 * `cancelled-by-user`) is matched exactly rather than by substring: `finished` is the
 * only success, and anything unrecognised stays `building` so the poll keeps waiting
 * instead of calling an unknown word healthy.
 */
export function deploymentHealthFromStatus(status: string): DeploymentHealth {
  const value = status.trim().toLowerCase();
  if (value === 'finished') return 'healthy';
  if (value === 'failed' || value === 'cancelled-by-user' || value === 'error') return 'failed';
  return 'building';
}

/**
 * Coolify answered but named no status. Distinct from `''`, which the poll read as a
 * queue state and waited out; the publish poll treats this sentinel as "Coolify did not
 * report a status" and fails fast after a bounded retry (F-218). Health stays `building`
 * — an exact-match, non-Coolify word — so it is never mistaken for success.
 */
export const COOLIFY_STATUS_UNREPORTED = 'unreported';

/**
 * The state of one deployment — the build this publish job actually triggered.
 *
 * The poll used to read `GET /api/v1/applications/{uuid}` and derive health from the
 * *application's* status. On a re-publish the application is already `running:healthy`
 * from the previous build, so the first poll returned healthy and the loop broke
 * immediately: the job wrote LIVE and a fresh `publishedAt` while the new build was still
 * running, or after it had already failed. `GET /api/v1/deployments/{uuid}` is the only
 * endpoint that answers for one build.
 *
 * A 404 reads as `building`, not failed: Coolify has been observed not to expose a
 * just-queued deployment yet. Never becoming `finished` therefore times out the poll,
 * which is a failure to verify — the correct answer — rather than a silent success.
 */
export async function getCoolifyDeployment(
  server: CoolifyServerAuth,
  deploymentUuid: string,
): Promise<{ health: DeploymentHealth; status: string; raw: unknown }> {
  let data: unknown;
  try {
    ({ data } = await coolifyFetch(
      server,
      `/api/v1/deployments/${encodeURIComponent(deploymentUuid)}`,
      {},
      { retryOnServerError: true },
    ));
  } catch (error) {
    if (error instanceof CoolifyApiError && error.status === 404) {
      return { health: 'building', status: 'not_found', raw: null };
    }
    throw error;
  }
  const row = asRecord(data);
  const nested = asRecord(row.data);
  const reported = row.status ?? nested.status;
  // Coolify answered but named no status. Reading that as `''` mapped to `building`, so
  // the poll waited the full ten minutes and then reported a queue state Coolify never
  // reported (F-218). The sentinel keeps health `building` — never `healthy` — and lets
  // the publish poll fail fast on "Coolify did not report a status" after a bounded retry.
  if (typeof reported !== 'string' || !reported.trim()) {
    return { health: 'building', status: COOLIFY_STATUS_UNREPORTED, raw: data };
  }
  const status = reported;
  return { health: deploymentHealthFromStatus(status), status, raw: data };
}

export async function getApplication(server: CoolifyServerAuth, appUuid: string) {
  const { data } = await coolifyFetch(
    server,
    `/api/v1/applications/${appUuid}`,
    {},
    { retryOnServerError: true },
  );
  return asRecord(data);
}

function parseFqdnList(value: unknown): string[] {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function hostFromFqdn(entry: string) {
  return entry
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:redirect.*$/i, '')
    .replace(/:\d+$/, '')
    .toLowerCase();
}

export async function listApplicationHosts(server: CoolifyServerAuth, appUuid: string) {
  const app = await getApplication(server, appUuid);
  return parseFqdnList(app.fqdn ?? app.domains).map(hostFromFqdn);
}

export async function addApplicationDomain(
  server: CoolifyServerAuth,
  appUuid: string,
  hostname: string,
) {
  const app = await getApplication(server, appUuid);
  const current = parseFqdnList(app.fqdn ?? app.domains);
  const host = hostname.replace(/^https?:\/\//i, '').toLowerCase();
  if (!current.some((entry) => hostFromFqdn(entry) === host)) {
    current.push(`https://${host}`);
  }
  const fqdn = current.join(',');
  await coolifyFetch(server, `/api/v1/applications/${appUuid}`, {
    method: 'PATCH',
    body: JSON.stringify({ domains: fqdn, fqdn }),
  });
}

export async function removeApplicationDomain(
  server: CoolifyServerAuth,
  appUuid: string,
  hostname: string,
) {
  const app = await getApplication(server, appUuid);
  const host = hostname.replace(/^https?:\/\//i, '').toLowerCase();
  const next = parseFqdnList(app.fqdn ?? app.domains).filter(
    (entry) => hostFromFqdn(entry) !== host,
  );
  const fqdn = next.join(',');
  await coolifyFetch(server, `/api/v1/applications/${appUuid}`, {
    method: 'PATCH',
    body: JSON.stringify({ domains: fqdn, fqdn }),
  });
}

/** Primary is canonical; aliases (including {slug}.{zone}) are listed so Coolify can 301 to primary. */
export async function setApplicationPrimaryRedirects(
  server: CoolifyServerAuth,
  appUuid: string,
  primary: string,
  aliases: string[],
) {
  const seen = new Set<string>();
  const parts: string[] = [];
  const add = (host: string, redirect: boolean) => {
    const clean = host.replace(/^https?:\/\//i, '').toLowerCase();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    parts.push(redirect ? `https://${clean}:redirect` : `https://${clean}`);
  };
  add(primary, false);
  for (const alias of aliases) add(alias, true);
  const fqdn = parts.join(',');
  await coolifyFetch(server, `/api/v1/applications/${appUuid}`, {
    method: 'PATCH',
    body: JSON.stringify({ domains: fqdn, fqdn }),
  });
}

export function applicationListsHostname(app: Record<string, unknown>, hostname: string) {
  const host = hostname.toLowerCase();
  return parseFqdnList(app.fqdn ?? app.domains).some((entry) => hostFromFqdn(entry) === host);
}

export async function setBasicAuth(
  server: CoolifyServerAuth,
  appUuid: string,
  auth: { username: string; password: string } | null,
) {
  await coolifyFetch(server, `/api/v1/applications/${appUuid}`, {
    method: 'PATCH',
    body: JSON.stringify(
      auth
        ? {
            is_http_basic_auth_enabled: true,
            http_basic_auth_username: auth.username,
            http_basic_auth_password: auth.password,
          }
        : { is_http_basic_auth_enabled: false },
    ),
  });
}

export async function stopApplication(server: CoolifyServerAuth, appUuid: string) {
  await coolifyFetch(server, `/api/v1/applications/${appUuid}/stop`);
}

/**
 * Select which commit the application's next deploy builds, and prove the write
 * landed before anyone acts on it.
 *
 * `/api/v1/deploy` has no parameter naming a release, so this is the only way to
 * deploy anything other than the branch head. Because it is a *configuration*
 * write with a deploy behind it, the read-back is not optional: a PATCH that
 * Coolify accepted but did not apply would otherwise be followed by a deploy of
 * the release the caller was trying to replace, reported as a success. That
 * exact bug is why the instance-level rollback was rewritten (F-264), so the
 * mismatch is a typed refusal rather than a `void` return the caller can ignore.
 *
 * Callers: the F-264 project rollback, and the `pin` step of every publish —
 * which re-pins to the commit it just pushed, so an application left pinned by a
 * rollback does not silently rebuild the rolled-back release.
 */
export async function pinApplicationCommit(
  server: CoolifyServerAuth,
  appUuid: string,
  sha: string,
): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  try {
    await coolifyFetch(server, `/api/v1/applications/${appUuid}`, {
      method: 'PATCH',
      body: JSON.stringify({ git_commit_sha: sha }),
    });
  } catch (error) {
    const detail = error instanceof CoolifyApiError ? `${error.status}` : 'unreachable';
    return {
      ok: false,
      error: `Coolify refused to select commit ${sha.slice(0, 7)} for this application (${detail}).`,
    };
  }
  const app = await getApplication(server, appUuid);
  const actual = typeof app.git_commit_sha === 'string' ? app.git_commit_sha : null;
  if (actual !== sha) {
    return {
      ok: false,
      error: `Coolify still reports commit ${actual ?? 'unknown'} for this application, so the release was not selected.`,
    };
  }
  return { ok: true, sha };
}

export async function deleteApplication(server: CoolifyServerAuth, appUuid: string) {
  try {
    await coolifyFetch(server, `/api/v1/applications/${appUuid}`, { method: 'DELETE' });
  } catch (error) {
    if (error instanceof CoolifyApiError && error.status === 404) return;
    throw error;
  }
}

export async function testServerConnection(server: CoolifyServerAuth) {
  try {
    const { status, data } = await coolifyFetch(
      server,
      '/api/v1/version',
      {},
      { retryOnServerError: true },
    );
    const row = asRecord(data);
    const version =
      typeof data === 'string' ? data : typeof row.version === 'string' ? row.version : 'ok';
    return { ok: true as const, status, version };
  } catch (error) {
    if (error instanceof CoolifyApiError) {
      // The admin UI shows this body. `scrubSensitive` is the one redactor the logger,
      // the audit log and Sentry also use (F-684), so an echoed payload never carries a
      // token or basic-auth password out of the client (F-229).
      return {
        ok: false as const,
        status: error.status,
        error: error.message,
        body: scrubSensitive(error.body),
      };
    }
    return {
      ok: false as const,
      status: 0,
      error: error instanceof Error ? error.message : 'Connection failed',
    };
  }
}
