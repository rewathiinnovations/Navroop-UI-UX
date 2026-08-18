import { shouldCheckDomain } from './backoff';
import { listCheckableCustomDomains } from './store';
import { checkDomain } from './verify';

/** Cron ticks are short and already persist CustomDomain.status. A Job per 2-min check would flood the table. User-triggered verify uses a DOMAIN_VERIFY job. */
export async function checkDueCustomDomains(now = new Date()) {
  const rows = await listCheckableCustomDomains();
  let checked = 0;
  let failed = 0;
  let skipped = 0;
  for (const row of rows) {
    if (!shouldCheckDomain(row.createdAt, row.lastCheckedAt, now)) {
      skipped += 1;
      continue;
    }
    try {
      const next = await checkDomain(row.id, { now });
      checked += 1;
      if (next.status === 'FAILED') failed += 1;
    } catch (error) {
      failed += 1;
      console.warn('[domains] cron check failed', row.id, error);
    }
  }
  return { checked, failed, skipped, total: rows.length };
}
