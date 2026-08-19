import { getObservabilityStore } from '../observability/store';
import type { ObservabilityStore } from '../observability/types';

/**
 * The receipt a cron body owes the operator.
 *
 * `ok` is mandatory. `withCronRun` used to sniff the returned value for an `ok` field and
 * treat its absence as success, which meant every body that aggregated per-item failures into
 * a counter reported a healthy run: `check-integrations` answered 200 and wrote
 * `CronRun{ok: true}` with all four providers returning 401, and `purge-projects` did the same
 * with every project blocked and its containers still billing. /admin/health and the daily
 * digest are read straight off `CronRun`, so a green receipt on a failed run is worse than a
 * red one — it is what teaches an operator to stop reading the mail before the next real
 * `backup-db` failure arrives. The type is the fix: a body that does not state its outcome no
 * longer compiles.
 *
 * `ok: false` means work this run set out to do was left undone and only the operator can
 * clear it. It does *not* mean "something I observed is unhealthy" when that observation has
 * its own record and its own actor — a customer domain still waiting on their DNS, or Sentry
 * at 80% of quota, belongs in `detail`, not in a red run, because a permanently red row is
 * the same alert-fatigue bug in a different costume. The monitors whose entire output *is*
 * the verdict (`check-uptime`, `check-certs`, `observability-heartbeat`) are the exception:
 * for them the observation is the work.
 */
export type CronOutcome = {
  ok: boolean;
  /** Why the run ended as it did — the digest line and the /admin/health row are this string. */
  detail?: string | null;
};

export type CronRecordDeps = {
  store?: Pick<ObservabilityStore, 'createCronRun'>;
  now?: () => Date;
};

export async function withCronRun<T extends CronOutcome>(
  name: string,
  fn: () => Promise<T>,
  deps: CronRecordDeps = {},
): Promise<T> {
  const store = deps.store ?? getObservabilityStore();
  const startedMs = Date.now();
  const createdAt = deps.now ? deps.now() : new Date();
  try {
    const result = await fn();
    const ok = outcomeOk(name, result);
    await store.createCronRun({
      name,
      ok,
      durationMs: Date.now() - startedMs,
      // A healthy run may explain itself too — /admin/health shows this beside the timestamp.
      detail: ok
        ? typeof result.detail === 'string'
          ? result.detail
          : null
        : failureDetail(name, result),
      createdAt,
    });
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await store.createCronRun({
      name,
      ok: false,
      durationMs: Date.now() - startedMs,
      detail,
      createdAt,
    });
    throw error;
  }
}

/**
 * `CronOutcome` is the real guard; this is the runtime backstop for a value that reached here
 * through an `any` — a `vi.mock`, a JSON round trip, a route that casts. It fails the run and
 * says so loudly rather than assuming success, because assuming success is precisely what hid
 * the failures this contract exists to surface.
 */
function outcomeOk(name: string, result: CronOutcome) {
  const ok = (result as { ok?: unknown } | null | undefined)?.ok;
  if (typeof ok === 'boolean') return ok;
  console.error('[cron] work function reported no outcome; recording the run as failed', { name });
  return false;
}

function failureDetail(name: string, result: CronOutcome) {
  const record = result as
    { error?: unknown; detail?: unknown; message?: unknown; errors?: unknown } | null | undefined;
  if (typeof record?.detail === 'string') return record.detail;
  if (typeof record?.error === 'string') return record.error;
  if (typeof record?.message === 'string') return record.message;
  // Several crons aggregate per-item failures into `errors` instead of one message — that is
  // what the operator needs to see, not a JSON dump of the whole report.
  if (Array.isArray(record?.errors) && record.errors.length > 0) {
    return record.errors
      .map((entry) => String(entry))
      .join('; ')
      .slice(0, 500);
  }
  // A failed run with nothing to say is a bug in the body: the digest line would read
  // "<job> failed" with no reason, so the shape is dumped and the gap is logged.
  console.warn('[cron] failed run carried no detail; the digest will name no reason', { name });
  try {
    return JSON.stringify(result).slice(0, 500);
  } catch {
    return 'failed';
  }
}
