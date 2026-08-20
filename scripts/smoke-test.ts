/**
 * Live smoke against a deployed Navroop URL.
 * Client site deploys must keep responding — this script asserts a known live URL.
 *
 *   SMOKE_URL=https://app.example node ./node_modules/tsx/dist/cli.mjs scripts/smoke-test.ts
 *   SMOKE_CLIENT_URL=https://known-client.example
 *
 * Checks are independent: a failing check records the failure and the run
 * continues, so one broken subsystem cannot hide the state of the others. Only a
 * missing SMOKE_URL, or an origin that refuses the connection outright, stops the
 * run early — nothing can be probed in either case. The process still exits 1 if
 * anything failed.
 *
 * A non-zero exit means something is broken in the deployment. Conditions that
 * are expected for the target being probed — a dev box with no `/data` mount,
 * for instance — are reported as warnings and leave the exit code at 0.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { matchPublicRoute } from '../lib/auth/public-routes.ts';
import { collectRouteEndpoints, samplePath } from '../lib/auth/route-inventory.ts';

const base = (process.env.SMOKE_URL || process.env.APP_URL || '').replace(/\/+$/, '');
const clientUrl = (process.env.SMOKE_CLIENT_URL || '').replace(/\/+$/, '');
const email = process.env.SMOKE_EMAIL || '';
const password = process.env.SMOKE_PASSWORD || '';

const failures: string[] = [];
const warnings: string[] = [];
const skipped: string[] = [];

function fatal(message: string): never {
  console.error(`[smoke] ${message}`);
  process.exit(1);
}

function fail(message: string) {
  console.error(`[smoke] ${message}`);
  failures.push(message);
}

/** Reported, but not a deployment failure: does not affect the exit code. */
function warn(message: string) {
  console.log(`warn ${message}`);
  warnings.push(message);
}

/**
 * Not run, so it proved nothing. Counted, because a green run whose most
 * valuable checks were skipped is not the same as a green run.
 */
function skip(message: string) {
  console.log(`skip ${message}`);
  skipped.push(message);
}

if (!base) fatal('SMOKE_URL (or APP_URL) is required');

const LOCAL_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
  'host.docker.internal',
]);
const TRUTHY = new Set(['on', 'true', '1', 'yes']);
const FALSY = new Set(['off', 'false', '0', 'no']);

function isLocalTarget(url: string) {
  try {
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost');
  } catch {
    return false;
  }
}

/**
 * `/data` is a Coolify production mount. A local dev server has no such volume,
 * so an unwritable data dir and a missing volume id are the expected state
 * there and must not fail the run — otherwise every local smoke exits 1 and the
 * real failures get lost in the noise. The check still runs and still prints its
 * reason; it is only its severity that depends on the target.
 *
 * SMOKE_EXPECT_DATA_VOLUME=on requires the volume even on localhost (useful
 * when probing a container through a port forward); =off never requires it.
 */
function expectsDataVolume() {
  const override = (process.env.SMOKE_EXPECT_DATA_VOLUME || '').trim().toLowerCase();
  if (TRUTHY.has(override)) return true;
  if (FALSY.has(override)) return false;
  return !isLocalTarget(base);
}

/**
 * `fetch` rejects on a refused connection or DNS failure, and an unhandled
 * rejection kills the run with a Node stack trace instead of a `[smoke]` line.
 * "The deployment is unreachable" is the most likely smoke failure there is, so it
 * gets a readable message.
 */
async function fetchOrNull(url: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(url, init);
  } catch {
    return null;
  }
}

async function get(path: string) {
  return fetchOrNull(`${base}${path}`, { redirect: 'manual' });
}

const HEALTH_DEPENDENCIES = ['db', 'storage'] as const;

/**
 * `/api/health` reports three distinct answers about the data directory, and they
 * are not interchangeable. `unwritable` is a fault. `not_checked` only means the
 * boot probe has not run in the process that served the request — writability is
 * unknown, which is not the same as a missing volume and must not be reported as
 * one. `describeDataDir()` in `lib/health/check.ts` is the source of truth.
 */
const DATA_DIR_STATES = ['ok', 'not_checked', 'unwritable'] as const;
type DataDirState = (typeof DATA_DIR_STATES)[number];

/** Narrow the JSON string, or null when the deployment predates `dataDir.state`. */
function dataDirState(raw: string | undefined): DataDirState | null {
  return DATA_DIR_STATES.find((known) => known === raw) ?? null;
}

type HealthBody = {
  ok?: boolean;
  checks?: Partial<Record<(typeof HEALTH_DEPENDENCIES)[number], string>>;
  dataDir?: {
    state?: string;
    message?: string;
    path?: string;
    error?: string | null;
    writable?: boolean;
    volumeId?: string | null;
    volumeChanged?: boolean;
    previousVolumeId?: string | null;
    warnLowSpace?: boolean;
    freeRatio?: number | null;
  };
  observabilityFile?: {
    present?: boolean;
    state?: 'ok' | 'absent' | 'unreadable';
    error?: string | null;
    projectId?: string | null;
    matchesIntegration?: boolean | null;
  };
  sentry?: {
    dsnConfigured?: boolean;
    initState?:
      'initialised' | 'skipped_absent' | 'skipped_unreadable' | 'skipped_disabled' | 'not_captured';
  };
};

async function readJson(response: Response): Promise<HealthBody | null> {
  try {
    return (await response.json()) as HealthBody;
  } catch {
    return null;
  }
}

/**
 * `/api/health` answers 503 when Postgres or object storage is unreachable, and
 * its body names which one. Reading that on the failure path is the difference
 * between "the app returned 503" and "Postgres is down" — different incidents
 * with different first moves.
 */
function describeDownDependencies(body: HealthBody | null) {
  if (!body?.checks) return '';
  const down = HEALTH_DEPENDENCIES.filter((name) => body.checks?.[name] !== 'ok');
  if (down.length === 0) return '';
  return ` — down: ${down.join(', ')}`;
}

async function checkHealth() {
  const failuresBefore = failures.length;
  const health = await get('/api/health');
  if (!health) {
    // Nothing else can be probed if the origin does not answer at all, which is
    // the same reason a missing SMOKE_URL stops the run.
    fatal(`${base} did not answer GET /api/health — the connection failed`);
  }
  const healthBody = await readJson(health);

  if (!health.ok) {
    fail(`GET /api/health returned ${health.status}${describeDownDependencies(healthBody)}`);
    return;
  }
  if (!healthBody) {
    fail('GET /api/health returned 200 with a body that is not JSON');
    return;
  }
  if (healthBody.ok !== true) {
    fail(`GET /api/health body.ok is not true${describeDownDependencies(healthBody)}`);
  }

  const dataDir = healthBody.dataDir;
  const volumeRequired = expectsDataVolume();
  // Warnings when the target has no volume to mount; failures when it should.
  // Severity is unchanged from the boolean logic this replaced — only the wording
  // is more precise — so no run changes outcome.
  const reportVolume = volumeRequired ? fail : warn;
  const where = dataDir?.path || 'unknown path';
  const suffix = volumeRequired
    ? ''
    : ' (warning only: the target looks local — set SMOKE_EXPECT_DATA_VOLUME=on to require a volume)';

  switch (dataDirState(dataDir?.state)) {
    case 'ok':
      // `ensureDataDir` stamps a volume id on every success path, so state ok with
      // no id means the health shape changed, not that the volume vanished.
      if (dataDir?.volumeId) console.log(`ok  persistent volume ${where}`);
      else fail(`persistent volume ${where} reports state ok but carries no volume id`);
      break;
    case 'not_checked':
      // Unknown, not broken. Do not say "missing" — nothing has been attempted.
      // The health body's message for this state ends "This is not a failure",
      // which is right for a dashboard and contradictory inside a release gate, so
      // state the reason here instead of quoting it.
      reportVolume(
        `persistent volume ${where} — unverified: the boot probe has not run in the process that served this request, so writability is unknown. This is not evidence of a missing volume, but a deployment that should have probed at boot has not.${suffix}`,
      );
      break;
    case 'unwritable':
      reportVolume(
        `persistent volume ${where} — unwritable: ${dataDir?.message || dataDir?.error || 'no reason reported'}${suffix}`,
      );
      break;
    default: {
      // A deployment older than `dataDir.state`. `writable` is still a plain
      // boolean, so the original logic keeps working against it.
      const problems: string[] = [];
      if (dataDir?.writable !== true) problems.push('not writable');
      if (!dataDir?.volumeId) problems.push('no volume id');
      if (problems.length === 0) {
        console.log(`ok  persistent volume ${where}`);
      } else {
        const because = dataDir?.error ? `: ${dataDir.error}` : '';
        reportVolume(`persistent volume ${where} — ${problems.join(', ')}${because}${suffix}`);
      }
      break;
    }
  }

  if (
    dataDir?.previousVolumeId &&
    dataDir.volumeId &&
    dataDir.previousVolumeId !== dataDir.volumeId &&
    dataDir.volumeChanged !== true
  ) {
    fail('silent lost volume — volume id changed but the change was not reported');
  }
  if (dataDir?.volumeChanged) {
    warn(
      `volume id changed (previous ${dataDir.previousVolumeId || 'none'} → ${dataDir.volumeId})`,
    );
  }
  if (dataDir?.warnLowSpace) reportVolume('free space is below the 20% warning threshold');

  // `Sentry.init` runs once, at boot. A DSN that reads as configured now says nothing
  // about whether this process reports anything, and that is the state F-738 was about.
  if (healthBody.sentry?.initState === 'skipped_unreadable') {
    fail('this process never initialised Sentry: the observability config was unreadable at boot');
  }
  if (healthBody.sentry?.dsnConfigured) {
    if (healthBody.observabilityFile?.state === 'unreadable') {
      fail(
        `observability.json could not be read while Sentry is connected: ${healthBody.observabilityFile.error ?? 'unknown error'}`,
      );
    } else if (!healthBody.observabilityFile?.present) {
      fail('observability.json is missing while Sentry is connected');
    }
    if (healthBody.observabilityFile?.matchesIntegration === false) {
      fail('observability.json project id does not match the Sentry Integration');
    } else if (healthBody.observabilityFile?.matchesIntegration == null) {
      // The route reports null when there is no Integration row or the read threw.
      // Passing silently here would let `ok health` imply a comparison that never
      // happened, so say so instead.
      skip('observability.json vs Integration (the route could not compare them)');
    }
  } else {
    skip('observability.json vs Integration (no Sentry DSN configured)');
  }
  // Only claim the check passed when it did. The old unconditional `ok health`
  // printed a green line underneath its own recorded failures.
  if (failures.length === failuresBefore) {
    console.log(`ok  health (${HEALTH_DEPENDENCIES.join(', ')} reachable)`);
  }
}

/**
 * Enough of a gap that ~170 probes do not look like an attack to the app's own limiters,
 * and small enough that the whole sweep stays inside a few seconds (F-798).
 */
const AUTH_PROBE_PACING_MS = 25;

/**
 * Unauthenticated probe of the whole API surface.
 *
 * The filesystem test in tests/unit/api-route-auth.test.ts proves the proxy
 * denies these paths at build time. This proves it against the deployment that
 * is actually running, which additionally catches a route that is gated but
 * whose gate does not work.
 *
 * Requests use non-existent sample ids and carry no cookies, so a route can
 * only act on them if both the proxy gate and its own check are broken. Set
 * SMOKE_AUTH_PROBE=off to skip.
 *
 * This only makes HTTP requests, so it runs against any reachable deployment —
 * including a local dev server with no /data volume.
 */
async function checkUnauthenticatedRoutes() {
  if (process.env.SMOKE_AUTH_PROBE === 'off') {
    skip('unauthenticated route probe (SMOKE_AUTH_PROBE=off)');
    return;
  }

  const endpoints = collectRouteEndpoints();
  if (endpoints.length === 0) {
    fail('route walker found no routes; the probe would pass vacuously');
    return;
  }

  const unexpected: string[] = [];
  let allowlisted = 0;
  let probed = 0;

  const unreachable: string[] = [];
  for (const endpoint of endpoints) {
    const path = samplePath(endpoint.pattern);
    if (matchPublicRoute(path, endpoint.method)) {
      allowlisted += 1;
      continue;
    }
    probed += 1;
    // `fetchOrNull`, not bare `fetch`: this loop fires ~170 requests, and one connection
    // reset used to throw out of the whole run and lose every result already gathered,
    // contradicting the "checks are independent" promise at the top of this file (F-798).
    const response = await fetchOrNull(`${base}${path}`, {
      method: endpoint.method,
      redirect: 'manual',
      headers: { accept: 'application/json' },
    });
    if (!response) {
      // A probe that could not be made proves nothing, so it is a failure, not a pass.
      unreachable.push(`${endpoint.method} ${path} was unreachable (${endpoint.file})`);
      continue;
    }
    if (response.status !== 401) {
      unexpected.push(`${endpoint.method} ${path} returned ${response.status} (${endpoint.file})`);
    }
    // The probe walks every discovered method, including POST and DELETE, against a live
    // deployment. Unpaced it tripped the app's own login rate limiter before `checkSignIn`
    // ran a few lines later, so an unrelated check failed and blamed the credentials.
    await sleep(AUTH_PROBE_PACING_MS);
  }

  // Every endpoint the walker found is either allowlisted or gated, so the three
  // counts reconcile. Printing all three is what makes "170 returned 401"
  // meaningful: without the total, a walker that silently stopped finding routes
  // would still look like a pass.
  const census =
    `${endpoints.length} endpoints discovered = ` +
    `${allowlisted} allowlisted in PUBLIC_API_ROUTES + ${probed} gated`;

  if (probed === 0) {
    // Nothing was actually requested, so "all returned 401" would be true of the
    // empty set. Reachable if the allowlist is ever widened to cover everything.
    fail(`${census}; no gated route was probed, so the probe proved nothing`);
  } else if (unexpected.length > 0 || unreachable.length > 0) {
    for (const row of [...unexpected, ...unreachable]) console.error(`[smoke] ${row}`);
    const parts = [
      unexpected.length > 0 ? `${unexpected.length} did not return 401` : null,
      unreachable.length > 0 ? `${unreachable.length} were unreachable` : null,
    ].filter(Boolean);
    fail(`${census}; of ${probed} gated routes, ${parts.join(' and ')}`);
  } else {
    console.log(`ok  unauthenticated route probe (${census}, all ${probed} returned 401)`);
  }

  // A cron endpoint is allowlisted past the proxy on purpose, so its bearer
  // check is the only thing standing in front of it.
  const cronNoBearer = await fetchOrNull(`${base}/api/cron/reap-jobs`, {
    method: 'POST',
    redirect: 'manual',
  });
  const cronBadBearer = await fetchOrNull(`${base}/api/cron/reap-jobs`, {
    method: 'POST',
    redirect: 'manual',
    headers: { authorization: 'Bearer not-the-cron-secret' },
  });
  if (!cronNoBearer || !cronBadBearer) {
    fail('cron bearer check could not be probed: the deployment was unreachable');
    return;
  }
  if (cronNoBearer.status !== 401)
    fail(`cron without a bearer token returned ${cronNoBearer.status}`);
  if (cronBadBearer.status !== 401)
    fail(`cron with a wrong bearer token returned ${cronBadBearer.status}`);
  if (cronNoBearer.status === 401 && cronBadBearer.status === 401) {
    console.log('ok  cron rejects a missing and a wrong bearer token');
  }
}

async function checkSignIn() {
  if (!email || !password) {
    skip('sign-in and dashboard (set SMOKE_EMAIL / SMOKE_PASSWORD)');
    return;
  }
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) {
    fail(`sign-in returned ${login.status}`);
    return;
  }
  // A 200 is not a session. Without a Set-Cookie header nothing was issued, and
  // saying "ok sign-in" before checking would claim more than was verified.
  const cookie = login.headers.get('set-cookie') || '';
  if (!cookie) {
    fail('sign-in returned 200 without a Set-Cookie header, so no session was issued');
    return;
  }
  console.log('ok  sign-in');

  // `redirect: 'manual'`, because an unauthenticated request to /dashboard is
  // redirected to the login page and following that redirect yields a 200 — so a
  // followed redirect prints "ok dashboard" for a caller who was bounced out.
  const dashboard = await fetch(`${base}/dashboard`, { headers: { cookie }, redirect: 'manual' });
  if (dashboard.status >= 300 && dashboard.status < 400) {
    const location = dashboard.headers.get('location') || 'an unknown location';
    fail(`dashboard redirected to ${location} — the session cookie was not accepted`);
  } else if (!dashboard.ok) {
    fail(`dashboard returned ${dashboard.status}`);
  } else {
    console.log('ok  dashboard');
  }
}

async function checkClientSite() {
  if (!clientUrl) {
    skip('client site (set SMOKE_CLIENT_URL)');
    return;
  }
  const client = await fetchOrNull(clientUrl, { redirect: 'follow' });
  if (!client) fail(`known live client site ${clientUrl} did not respond — the connection failed`);
  else if (!client.ok) fail(`known live client site ${clientUrl} returned ${client.status}`);
  else console.log(`ok  client site ${clientUrl}`);
}

await checkHealth();
await checkUnauthenticatedRoutes();
await checkSignIn();
await checkClientSite();

if (failures.length > 0) {
  console.error(`[smoke] ${failures.length} check${failures.length === 1 ? '' : 's'} failed`);
  process.exit(1);
}

// A green run that skipped sign-in and the client site is not the same as a green
// run that made those requests. Say which, so nobody reads a bare "smoke passed"
// as coverage it did not have.
const notes: string[] = [];
if (warnings.length > 0) {
  notes.push(`${warnings.length} warning${warnings.length === 1 ? '' : 's'}`);
}
if (skipped.length > 0) {
  notes.push(`${skipped.length} check${skipped.length === 1 ? '' : 's'} skipped`);
}
console.log(notes.length > 0 ? `smoke passed with ${notes.join(', ')}` : 'smoke passed');

export {};
