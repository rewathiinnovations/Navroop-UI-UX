import { appPublicUrl } from '../settings/app-url';

export async function checkSiteUptime(deps: { url?: string; fetchFn?: typeof fetch } = {}) {
  // Resolved from the `app.url` admin setting, so an operator who corrects Application URL
  // moves this probe too. It used to read `process.env.APP_URL` and fall back to
  // 127.0.0.1:3000, which quietly turned an external uptime check into a loopback one.
  const base = deps.url ?? (await appPublicUrl());
  const target = `${base}/api/health`;
  const fetchFn = deps.fetchFn ?? fetch;
  const response = await fetchFn(target, { redirect: 'manual' });
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
