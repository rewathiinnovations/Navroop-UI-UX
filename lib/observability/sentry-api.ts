import type { SentryApi, SentryIssueHit, SentryProjectStats } from './types';

const SENTRY_API_BASE = 'https://sentry.io/api/0';

export type SentryApiCredentials = {
  authToken?: string;
  orgSlug?: string;
  projectSlug?: string;
};

export function sentryApiConfigured(creds: SentryApiCredentials = {}) {
  return Boolean(creds.authToken?.trim() && creds.orgSlug?.trim() && creds.projectSlug?.trim());
}

export function createSentryApi(
  creds: SentryApiCredentials = {},
  fetchFn: typeof fetch = fetch,
): SentryApi {
  const token = creds.authToken?.trim() || '';
  const org = creds.orgSlug?.trim() || '';
  const project = creds.projectSlug?.trim() || '';

  async function sentryGet(path: string) {
    const response = await fetchFn(`${SENTRY_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`Sentry API HTTP ${response.status}`);
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
        ).catch(() => null),
        sentryGet(`/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/issues/?query=is:unresolved&sort=freq&limit=5`).catch(
          () => [],
        ),
        sentryGet(`/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/`).catch(() => null),
      ]);

      const dropped: SentryProjectStats['dropped'] = [];
      let accepted = 0;
      const groups = (stats as { groups?: Array<{ by?: { outcome?: string }; totals?: { 'sum(quantity)'?: number } }> } | null)?.groups ?? [];
      for (const group of groups) {
        const outcome = group.by?.outcome || 'unknown';
        const count = Number(group.totals?.['sum(quantity)'] ?? 0);
        if (outcome === 'accepted') accepted += count;
        else if (count > 0) dropped.push({ reason: outcome, count });
      }

      const quotaLimit = Number((projectInfo as { quota?: { maxRate?: number } } | null)?.quota?.maxRate ?? 0);
      const used = accepted;
      const resetsAt =
        typeof (projectInfo as { quota?: { windowEnd?: string } } | null)?.quota?.windowEnd === 'string'
          ? (projectInfo as { quota: { windowEnd: string } }).quota.windowEnd
          : null;

      const topIssues = (Array.isArray(issues) ? issues : []).slice(0, 5).map((issue: { id?: string; title?: string; count?: string | number }) => ({
        id: String(issue.id || ''),
        title: String(issue.title || 'Untitled'),
        count: Number(issue.count || 0),
      }));

      return {
        accepted,
        dropped,
        quota: { used, limit: Number.isFinite(quotaLimit) && quotaLimit > 0 ? quotaLimit : Math.max(used, 1), resetsAt },
        topIssues,
      };
    },

    async findIssueByFingerprint(fingerprint: string): Promise<SentryIssueHit | null> {
      const query = encodeURIComponent(`fingerprint:${fingerprint}`);
      const issues = (await sentryGet(
        `/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/issues/?query=${query}&limit=1`,
      ).catch(() => [])) as Array<{ id?: string; lastSeen?: string; title?: string; count?: string | number }>;
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
