import { getSetting } from '@/lib/settings/resolve';
import { log, logError } from '../logger';

/**
 * The one signal this product cannot generate for itself.
 *
 * `sendSystemChecksDigest` reports every other cron's staleness, which makes it the single
 * point of failure for all background-work monitoring: if its scheduled task is deleted or its
 * endpoint starts failing, every stale cron becomes invisible at the same moment and
 * /admin/health stays green. No check that runs inside this process can tell that apart from
 * everything being healthy, because both look like "no digest arrived".
 *
 * So the digest calls outwards on every run instead, and the *absence* of that call is what
 * alerts — which only works if something outside this process is watching for it. That
 * something is the operator's: any monitor with an expected-ping schedule (Healthchecks.io,
 * Better Stack, Uptime Kuma "push"). Its URL is the `observability.deadManUrl` setting, and
 * `docs/coolify.md` states what must be configured on the monitor side.
 *
 * Nothing here retries. A monitor that misses one ping and alerts is behaving correctly for a
 * schedule this coarse, and a retry loop inside the cron would only turn a dead monitor into a
 * slow cron.
 */
export const DEAD_MAN_SETTING_KEY = 'observability.deadManUrl';

export const DEAD_MAN_TIMEOUT_MS = 10_000;

export type DeadManPingResult =
  | { state: 'not-configured' }
  | { state: 'ok'; status: number }
  | { state: 'failed'; detail: string };

export type DeadManDeps = {
  url?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export async function pingDeadManSwitch(deps: DeadManDeps = {}): Promise<DeadManPingResult> {
  const configured = (deps.url ?? (await getSetting(DEAD_MAN_SETTING_KEY)) ?? '').trim();
  if (!configured) return { state: 'not-configured' };

  let url: URL | null = null;
  try {
    const parsed = new URL(configured);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') url = parsed;
  } catch {
    url = null;
  }
  if (!url) {
    // Reported, not thrown, and never called: a typo in one setting must not take the digest
    // down, but it must not read as a delivered ping either — that would be exactly the false
    // "healthy" this whole mechanism exists to remove.
    const detail = `Monitoring heartbeat URL is not an http(s) address (${DEAD_MAN_SETTING_KEY})`;
    log.warn('observability.dead_man_url_invalid', { setting: DEAD_MAN_SETTING_KEY });
    return { state: 'failed', detail };
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEAD_MAN_TIMEOUT_MS;
  const abort = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchImpl(url.toString(), {
      method: 'POST',
      // Push endpoints want a bare hit; a body would be ignored, and some reject it.
      signal: abort,
      redirect: 'follow',
      cache: 'no-store',
    });
    if (!response.ok) {
      return {
        state: 'failed',
        detail: `Monitoring heartbeat answered HTTP ${response.status}`,
      };
    }
    return { state: 'ok', status: response.status };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logError('observability.dead_man_ping_failed', error, { setting: DEAD_MAN_SETTING_KEY });
    return { state: 'failed', detail: `Monitoring heartbeat could not be reached: ${detail}` };
  }
}
