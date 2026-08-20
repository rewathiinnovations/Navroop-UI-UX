import { prisma } from '@/lib/db';
import { peekRootDomain } from '@/lib/integrations/store';
import { serverAuth } from '@/lib/coolify/servers';
import { listApplicationHosts, setApplicationPrimaryRedirects } from '@/lib/coolify/client';
import { hostForSlug } from '@/lib/publish/slug';
import { log } from '@/lib/logger';
import { listCustomDomainsForDeployment, updateCustomDomain } from './store';

/**
 * F-207: `setApplicationPrimaryRedirects` **replaces** the Coolify application's whole
 * `domains`/`fqdn` list. This function built that list, and it built it from `peekRootDomain`,
 * which returns null unless the Cloudflare integration is CONNECTED. With `zone === null` the
 * publish hostname `{slug}.{zone}` was never added — so the PATCH removed it and a live
 * customer site lost its canonical address as a side effect of an unrelated Cloudflare state,
 * from a cron with nobody watching.
 *
 * Two rules now hold, and the second is the mirror of the read-modify-write discipline
 * `addApplicationDomain` already had:
 *
 *  - the zone must be resolvable. Without it this code cannot name the site's own hostname,
 *    so it cannot enumerate what must stay attached, so it does not write. The refusal is
 *    recorded on the primary domain's `lastError` — the field the Domains tab renders — and
 *    logged. Silently shipping a list missing the site's own address is the one option that
 *    was never acceptable.
 *  - whatever the application already answers with survives. A host attached outside this path
 *    is preserved as an alias; a host this system *knows* is a custom domain that is no longer
 *    live is still dropped, because that is the detach path doing its job.
 */

const ZONE_UNKNOWN_MESSAGE =
  'Redirects were not changed: Cloudflare is not connected, so this site’s own address could not be confirmed. Reconnect Cloudflare and set the primary domain again.';

export type RedirectOutcome = { ok: true } | { ok: false; reason: string };

function pairHost(hostname: string) {
  if (hostname.startsWith('www.')) return hostname.slice(4);
  if (hostname.split('.').length === 2) return `www.${hostname}`;
  return null;
}

export async function applyPrimaryRedirects(deploymentId: string): Promise<RedirectOutcome> {
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    include: { server: true },
  });
  if (!deployment?.coolifyAppUuid) {
    return { ok: false, reason: 'This site is not on a Coolify application yet' };
  }
  const domains = await listCustomDomainsForDeployment(deploymentId);
  const primary =
    domains.find((row) => row.isPrimary && row.status === 'ACTIVE') ??
    domains.find((row) => row.status === 'ACTIVE');
  if (!primary) return { ok: false, reason: 'No live custom domain to redirect to' };

  const zone = await peekRootDomain(deployment.workspaceId);
  if (!zone) {
    // Recorded where the person who triggered this is looking, then abandoned. No PATCH: the
    // list this function could build is provably incomplete.
    log.warn('domains.primary_redirect_refused', {
      deploymentId,
      hostname: primary.hostname,
      reason: 'cloudflare_zone_unknown',
    });
    await updateCustomDomain(primary.id, { lastError: ZONE_UNKNOWN_MESSAGE }).catch((error) => {
      log.warn('domains.primary_redirect_note_failed', {
        deploymentId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return { ok: false, reason: ZONE_UNKNOWN_MESSAGE };
  }

  const auth = serverAuth(deployment.server);
  // Read before write. Anything already attached that this code cannot account for is a host
  // somebody or something else put there, and replacing the list would silently unroute it.
  const attached = await listApplicationHosts(auth, deployment.coolifyAppUuid);
  const known = new Set(domains.map((row) => row.hostname.toLowerCase()));

  const aliases = new Set<string>();
  aliases.add(hostForSlug(deployment.slug, deployment.kind, zone));
  for (const row of domains) {
    if (row.id === primary.id) continue;
    if (row.status === 'ACTIVE' || row.status === 'SSL_PENDING') aliases.add(row.hostname);
  }
  const pair = pairHost(primary.hostname);
  if (pair) aliases.add(pair);
  for (const host of attached) {
    // A known custom domain that is not live is deliberately left off — `removeApplicationDomain`
    // and a FAILED verification both rely on that. Everything else stays.
    if (known.has(host)) continue;
    if (host === primary.hostname.toLowerCase()) continue;
    aliases.add(host);
  }

  await setApplicationPrimaryRedirects(auth, deployment.coolifyAppUuid, primary.hostname, [
    ...aliases,
  ]);
  return { ok: true };
}
