/**
 * Client address for the unauthenticated rate limiters (F-302).
 *
 * `x-forwarded-for` is a request header, so every hop an attacker controls can
 * write to it. The only entry a fronting proxy vouches for is the one *it*
 * appended — the last — because that is the address of the socket that
 * connected to it. The first entry (what the old per-route helpers read) is
 * whatever the client claimed.
 *
 * The documented deployment always fronts the app with a reverse proxy
 * (Coolify/Traefik), so the last hop is trusted by default. Set
 * `TRUST_PROXY_HEADERS=0` (runtime env — restart to apply) when the Node
 * process is exposed directly: with no proxy appending entries the header is
 * wholly attacker-chosen, and the limiters then key on email alone rather
 * than on a value the attacker rotates at will.
 *
 * Returns `null` when no trustworthy address exists; callers skip their
 * per-IP bucket instead of collapsing all traffic into one shared key.
 */
export function clientIpFrom(
  headers: Headers,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = (env.TRUST_PROXY_HEADERS ?? '').trim().toLowerCase();
  const trustProxy = raw !== '0' && raw !== 'false';
  if (!trustProxy) return null;

  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const hops = forwarded.split(',');
    const last = hops[hops.length - 1]?.trim();
    if (last) return last;
  }
  const realIp = headers.get('x-real-ip')?.trim();
  return realIp || null;
}
