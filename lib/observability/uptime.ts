export async function checkSiteUptime(deps: { url?: string; fetchFn?: typeof fetch } = {}) {
  const base = (deps.url ?? process.env.APP_URL ?? process.env.NEXTAUTH_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
  const target = `${base}/api/health`;
  const fetchFn = deps.fetchFn ?? fetch;
  const response = await fetchFn(target, { redirect: 'manual' });
  if (!response.ok && response.status !== 503) {
    throw new Error(`uptime check HTTP ${response.status}`);
  }
  return { ok: response.ok, status: response.status, url: target };
}
