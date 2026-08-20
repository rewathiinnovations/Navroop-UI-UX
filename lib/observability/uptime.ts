import { appPublicUrl } from '../settings/app-url';

/**
 * Node's fetch has no default request timeout, so an origin that accepts the connection
 * and never answers used to hang this probe — and `withCronRun` writes its row only when
 * the body settles, so the one monitor whose entire output is the verdict went silent
 * exactly when the site was in trouble (F-724).
 */
export const UPTIME_TIMEOUT_MS = 10_000;

export async function checkSiteUptime(
  deps: { url?: string; fetchFn?: typeof fetch; timeoutMs?: number } = {},
) {
  // Resolved from the `app.url` admin setting, so an operator who corrects Application URL
  // moves this probe too. It used to read `process.env.APP_URL` and fall back to
  // 127.0.0.1:3000, which quietly turned an external uptime check into a loopback one.
  const base = deps.url ?? (await appPublicUrl());
  const target = `${base}/api/health`;
  const fetchFn = deps.fetchFn ?? fetch;
  const timeoutMs = deps.timeoutMs ?? UPTIME_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetchFn(target, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    if (!timedOut) throw error;
    // A timeout is an answer about the site, not a broken cron: it fails the run through
    // `ok` so the CronRun detail and the digest line name the URL and the budget.
    return {
      ok: false,
      detail: `timeout after ${timeoutMs}ms ${target}`,
      status: 0,
      url: target,
    };
  }
  if (!response.ok && response.status !== 503) {
    throw new Error(`uptime check HTTP ${response.status}`);
  }
  // 503 is /api/health reporting a degraded dependency, which is an answer rather than an
  // outage: it still fails the run, but through `ok` instead of a throw, so the detail on the
  // CronRun row and in the digest line names the code and the URL that produced it.
  return {
    ok: response.ok,
    detail: `HTTP ${response.status} ${target}`,
    status: response.status,
    url: target,
  };
}
