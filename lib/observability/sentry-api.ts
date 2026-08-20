import type { SentryApi, SentryIssueHit, SentryProjectStats } from './types';

const SENTRY_GLOBAL_API_BASE = 'https://sentry.io/api/0';

/**
 * Sentry serves each organisation from one region. A DE-region org answers only on
 * `de.sentry.io`, so the hardcoded global base 404'd every call and the quota check read
 * that as a healthy, quiet project (F-723). `region` is a Sentry region slug ('us', 'de');
 * an unrecognised shape falls back to the global base, which is where a US org lives.
 */
export function sentryApiBase(region?: string) {
  const slug = region?.trim().toLowerCase() ?? '';
  if (!slug || slug === 'us' || !/^[a-z0-9-]{2,20}$/.test(slug)) return SENTRY_GLOBAL_API_BASE;
  return `https://${slug}.sentry.io/api/0`;
}

/**
 * The region as it appears in a DSN host — `o123.ingest.de.sentry.io` → `de`. The
 * connect flow persists the DSN host but no region, so this is how an existing
 * installation gets its region without reconnecting.
 */
export function sentryRegionFromHost(host?: string) {
  const match = /\.ingest\.([a-z0-9-]+)\.sentry\.io$/i.exec(host?.trim() ?? '');
  return match ? match[1].toLowerCase() : undefined;
}

/** How long any single Sentry API call may take. Node's fetch has no default (F-724). */
export const SENTRY_API_TIMEOUT_MS = 10_000;

export type SentryApiCredentials = {
  authToken?: string;
  orgSlug?: string;
  projectSlug?: string;
  /** Sentry region slug; see `sentryApiBase`. */
  region?: string;
};

export function sentryApiConfigured(creds: SentryApiCredentials = {}) {
  return Boolean(creds.authToken?.trim() && creds.orgSlug?.trim() && creds.projectSlug?.trim());
}

/**
 * F-631: a failed call to the Sentry API must be distinguishable from a
 * healthy, quiet project. Every request failure — network or non-2xx —
 * rejects with this error; callers decide whether that means "skip the
 * check" (quota cron) or "degrade the panel" (admin health).
 */
export class SentryApiError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SentryApiError';
  }
}

export function createSentryApi(
  creds: SentryApiCredentials = {},
  fetchFn: typeof fetch = fetch,
  // Injectable so the timeout path can be exercised without a ten-second test, the way
  // `checkSiteUptime` takes `timeoutMs`.
  options: { timeoutMs?: number } = {},
): SentryApi {
  const timeoutMs = options.timeoutMs ?? SENTRY_API_TIMEOUT_MS;
  const token = creds.authToken?.trim() || '';
  const org = creds.orgSlug?.trim() || '';
  const project = creds.projectSlug?.trim() || '';

  const base = sentryApiBase(creds.region);

  async function sentryGet(path: string) {
    let response: Response;
    try {
      response = await fetchFn(`${base}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        // An endpoint that accepts the connection and never answers used to hang the
        // cron for as long as the process lived, and `withCronRun` writes its row only
        // when the body settles — so the probe went quiet instead of failing (F-724).
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      const message = error instanceof Error ? error.message : String(error);
      throw new SentryApiError(
        timedOut
          ? `Sentry API timed out after ${timeoutMs}ms`
          : `Sentry API unreachable: ${message}`,
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new SentryApiError(`Sentry API HTTP ${response.status}`);
    }
    return response.json();
  }

  return {
    async getProjectStats(): Promise<SentryProjectStats> {
      const end = Math.floor(Date.now() / 1000);
      const start = end - 24 * 60 * 60;
      const [stats, issues, projectInfo] = await Promise.all([
        sentryGet(
          `/organizations/${encodeURIComponent(org)}/stats_v2/?field=sum(quantity)&category=error&outcome=accepted&outcome=rate_limited&outcome=filtered&interval=1d&start=${start}&end=${end}`,
        ),
        sentryGet(
          `/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/issues/?query=is:unresolved&sort=freq&limit=5`,
        ),
        sentryGet(`/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/`),
      ]);

      const dropped: SentryProjectStats['dropped'] = [];
      let accepted = 0;
      const groups =
        (
          stats as {
            groups?: Array<{ by?: { outcome?: string }; totals?: { 'sum(quantity)'?: number } }>;
          } | null
        )?.groups ?? [];
      for (const group of groups) {
        const outcome = group.by?.outcome || 'unknown';
        const count = Number(group.totals?.['sum(quantity)'] ?? 0);
        if (outcome === 'accepted') accepted += count;
        else if (count > 0) dropped.push({ reason: outcome, count });
      }

      const quotaLimit = Number(
        (projectInfo as { quota?: { maxRate?: number } } | null)?.quota?.maxRate ?? 0,
      );
      const used = accepted;
      const resetsAt =
        typeof (projectInfo as { quota?: { windowEnd?: string } } | null)?.quota?.windowEnd ===
        'string'
          ? (projectInfo as { quota: { windowEnd: string } }).quota.windowEnd
          : null;

      const topIssues = (Array.isArray(issues) ? issues : [])
        .slice(0, 5)
        .map((issue: { id?: string; title?: string; count?: string | number }) => ({
          id: String(issue.id || ''),
          title: String(issue.title || 'Untitled'),
          count: Number(issue.count || 0),
        }));

      return {
        accepted,
        dropped,
        quota: {
          used,
          // No per-project rate limit configured — which is the default for most Sentry
          // projects — is "we do not know the quota", not "the quota equals what you
          // used". The old `Math.max(used, 1)` made every project with any traffic read
          // as 100% consumed and mailed every admin daily about it (F-723).
          limit: Number.isFinite(quotaLimit) && quotaLimit > 0 ? quotaLimit : null,
          resetsAt,
        },
        topIssues,
      };
    },

    async findIssueByFingerprint(fingerprint: string): Promise<SentryIssueHit | null> {
      const query = encodeURIComponent(`fingerprint:${fingerprint}`);
      const issues = (await sentryGet(
        `/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/issues/?query=${query}&limit=1`,
      )) as Array<{ id?: string; lastSeen?: string; title?: string; count?: string | number }>;
      const first = Array.isArray(issues) ? issues[0] : null;
      if (!first?.id || !first.lastSeen) return null;
      return {
        id: String(first.id),
        lastSeen: first.lastSeen,
        title: first.title,
        count: Number(first.count || 0),
      };
    },
  };
}
