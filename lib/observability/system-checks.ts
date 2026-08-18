import { systemChecksDigestEmail } from '../email/templates/observability';
import { resolveSendAdminEmail } from './alerts';
import { getObservabilityStore } from './store';
import type { CronRunRow, SendAdminEmail, SystemCheckRow } from './types';

export const CRON_STALE_MS: Record<string, number> = {
  'backup-db': 48 * 60 * 60 * 1000,
  'check-uptime': 30 * 60 * 1000,
  'check-certs': 48 * 60 * 60 * 1000,
  'reap-jobs': 10 * 60 * 1000,
  'reap-sandboxes': 30 * 60 * 1000,
  'check-sandbox-providers': 30 * 60 * 1000,
  'verify-storage': 8 * 24 * 60 * 60 * 1000,
  'cleanup-orphans': 48 * 60 * 60 * 1000,
  'sweep-tmp': 3 * 60 * 60 * 1000,
};

export const SYSTEM_CHECK_JOBS = Object.keys(CRON_STALE_MS);

const JOB_LABEL: Record<string, string> = {
  'backup-db': 'database backup',
  'check-uptime': 'site uptime',
  'check-certs': 'certificate checks',
  'reap-jobs': 'job watchdog',
  'reap-sandboxes': 'sandbox idle reaper',
  'check-sandbox-providers': 'provider health probes',
  'verify-storage': 'storage verification',
  'cleanup-orphans': 'orphan cleanup',
  'sweep-tmp': 'temporary file sweep',
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

export async function sendSystemChecksDigest(deps: {
  now?: Date;
  runs?: CronRunRow[];
  sendAdminEmail?: SendAdminEmail;
} = {}) {
  const now = deps.now ?? new Date();
  const runs = deps.runs ?? (await getObservabilityStore().listCronRuns());
  const rows = evaluateSystemChecks(runs, now);
  const problems = rows.filter((row) => row.stale || row.ok === false);
  if (problems.length === 0) {
    return { sent: false, problems };
  }
  const lines = problems.map((row) => {
    const label = JOB_LABEL[row.name] || row.name;
    if (!row.lastRunAt) return `${label} (${row.name}) has never run`;
    if (row.ok === false) return `${label} (${row.name}) failed${row.detail ? `: ${row.detail}` : ''}`;
    return `${label} (${row.name}) is stale (last run ${row.lastRunAt})`;
  });
  await resolveSendAdminEmail(deps.sendAdminEmail)(systemChecksDigestEmail({ lines }));
  return { sent: true, problems, lines };
}
