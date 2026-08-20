import { log } from '@/lib/logger';
import { shouldCheckDomain } from './backoff';
import { listCheckableCustomDomains } from './store';
import { checkDomain } from './verify';

/**
 * Cron ticks are short and already persist CustomDomain.status. A Job per 2-min check would
 * flood the table. User-triggered verify uses a DOMAIN_VERIFY job.
 *
 * `errors` and `failed` are deliberately separate, and only `errors` fails the run. A domain
 * whose verification came back FAILED is a customer whose DNS is not pointed at us yet — that
 * is the normal state for days, it is shown on their own domain card, and marking the cron red
 * for it would leave /admin/health permanently red for something no operator can fix. A check
 * that *threw* is ours: DNS resolution, the Cloudflare API or the database refused, so that
 * domain's status was not refreshed at all and nothing else records it.
 */
export async function checkDueCustomDomains(now = new Date()) {
  const rows = await listCheckableCustomDomains();
  let checked = 0;
  let failed = 0;
  let skipped = 0;
  const errors: string[] = [];
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
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${row.id}: ${message}`);
      // Structured, not `console.warn`: this domain's status was not refreshed at all and
      // nothing else records that, so it has to be findable in the log search an operator
      // uses when /admin/health goes red (F-245).
      log.warn('domains.cron_check_failed', { domainId: row.id, error: message });
    }
  }
  return {
    ok: errors.length === 0,
    detail:
      errors.length > 0
        ? `${errors.length} of ${rows.length - skipped} domain checks could not run: ${errors.join('; ')}`
        : null,
    checked,
    failed,
    skipped,
    errors,
    total: rows.length,
  };
}
