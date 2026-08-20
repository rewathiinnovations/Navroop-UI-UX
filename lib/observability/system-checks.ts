import { systemChecksDigestEmail } from '../email/templates/observability';
import { resolveSendAdminEmail } from './alerts';
import { pingDeadManSwitch } from './dead-man-switch';
import { getObservabilityStore } from './store';
import type { CronRunRow, SendAdminEmail, SystemCheckRow } from './types';

/**
 * Every name here must be a cron that `app/api/cron/` actually implements with
 * `handleCron`, because a name with no `CronRun` row is reported `stale:
 * 'never-run'` forever. `reap-sandboxes` outlived its route and kept
 * `/admin/health` permanently red while mailing admins on every digest run —
 * which trains operators to ignore the mail the next real `backup-db` failure
 * arrives in. `tests/unit/cron-monitor-coverage.test.ts` holds both directions of that
 * mapping: no monitored name without a route, and no scheduled route left unmonitored.
 *
 * `system-checks-digest` is the one scheduled route deliberately absent: it is the sender, so
 * it cannot report its own silence. That is covered from outside instead — every digest run
 * pings the monitor at `observability.deadManUrl`, and the monitor alerting on a missing ping
 * is what detects the digest going dark. See `lib/observability/dead-man-switch.ts` and the
 * cron table in `docs/coolify.md`.
 */
export const CRON_STALE_MS: Record<string, number> = {
  'backup-db': 48 * 60 * 60 * 1000,
  'check-uptime': 30 * 60 * 1000,
  'check-certs': 48 * 60 * 60 * 1000,
  'check-domains': 30 * 60 * 1000,
  'check-integrations': 48 * 60 * 60 * 1000,
  'reap-jobs': 10 * 60 * 1000,
  'verify-storage': 8 * 24 * 60 * 60 * 1000,
  'cleanup-orphans': 48 * 60 * 60 * 1000,
  'sweep-tmp': 3 * 60 * 60 * 1000,
  // The two storage and cost reclamation crons. Neither was monitored, which is why a single
  // poisoned snapshot key could abort the whole daily maintenance run indefinitely and the
  // operator only found out when the volume filled.
  'thin-checkpoints': 48 * 60 * 60 * 1000,
  'purge-projects': 48 * 60 * 60 * 1000,
  'observability-heartbeat': 3 * 60 * 60 * 1000,
  'observability-quota': 48 * 60 * 60 * 1000,
};

export const SYSTEM_CHECK_JOBS = Object.keys(CRON_STALE_MS);

const JOB_LABEL: Record<string, string> = {
  'backup-db': 'database backup',
  'check-uptime': 'site uptime',
  'check-certs': 'certificate checks',
  'check-domains': 'custom domain checks',
  'check-integrations': 'integration health',
  'reap-jobs': 'job watchdog',
  'verify-storage': 'storage verification',
  'cleanup-orphans': 'orphan cleanup',
  'sweep-tmp': 'temporary file sweep',
  'thin-checkpoints': 'daily maintenance',
  'purge-projects': 'deleted project purge',
  'observability-heartbeat': 'error reporting heartbeat',
  'observability-quota': 'error reporting quota',
};

export function evaluateSystemChecks(runs: CronRunRow[], now: Date = new Date()): SystemCheckRow[] {
  return SYSTEM_CHECK_JOBS.map((name) => {
    const latest = runs
      .filter((row) => row.name === name)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    const staleMs = CRON_STALE_MS[name];
    const stale = !latest || now.getTime() - latest.createdAt.getTime() > staleMs;
    return {
      name,
      lastRunAt: latest ? latest.createdAt.toISOString() : null,
      ok: latest ? latest.ok : null,
      stale,
      detail: latest?.detail ?? (latest ? null : 'never-run'),
    };
  });
}

export async function sendSystemChecksDigest(
  deps: {
    now?: Date;
    runs?: CronRunRow[];
    sendAdminEmail?: SendAdminEmail;
    fetchImpl?: typeof fetch;
    deadManUrl?: string | null;
  } = {},
) {
  const now = deps.now ?? new Date();
  const runs = deps.runs ?? (await getObservabilityStore().listLatestCronRunPerName());
  const rows = evaluateSystemChecks(runs, now);
  const problems = rows.filter((row) => row.stale || row.ok === false);
  const lines = problems.map((row) => {
    const label = JOB_LABEL[row.name] || row.name;
    if (!row.lastRunAt) return `${label} (${row.name}) has never run`;
    if (row.ok === false)
      return `${label} (${row.name}) failed${row.detail ? `: ${row.detail}` : ''}`;
    return `${label} (${row.name}) is stale (last run ${row.lastRunAt})`;
  });
  if (lines.length > 0) {
    await resolveSendAdminEmail(deps.sendAdminEmail)(systemChecksDigestEmail({ lines }));
  }

  // After the reporting work, and on every run including the quiet one — the quiet run is the
  // common case, so a ping only on the noisy path would leave the monitor expecting nothing
  // and detecting nothing. This call is the only evidence outside this process that the digest
  // still runs at all; see lib/observability/dead-man-switch.ts.
  const deadMan = await pingDeadManSwitch({ url: deps.deadManUrl, fetchImpl: deps.fetchImpl });

  // A failed ping is this cron's own work left undone, the same way a failed Sentry flush is
  // the heartbeat cron's. It is deliberately not the "blame the messenger" case below: the
  // problems the digest *found* are already red in their own `CronRun` rows and do not fail
  // this run, but a heartbeat that never left the building means the operator's last line of
  // defence is silently disarmed, and nothing else in the product can notice that.
  const deadManDetail =
    deadMan.state === 'failed' ? `monitoring heartbeat failed: ${deadMan.detail}` : null;
  const problemDetail = problems.length > 0 ? `${problems.length} check(s) need attention` : null;

  return {
    ok: deadMan.state !== 'failed',
    detail: [problemDetail, deadManDetail].filter(Boolean).join('; ') || null,
    sent: lines.length > 0,
    problems,
    lines,
    deadMan,
  };
}
