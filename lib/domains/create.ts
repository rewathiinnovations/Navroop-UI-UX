import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/db';
import { peekRootDomain } from '@/lib/integrations/store';
import { checkCustomDomainAllowed } from '@/lib/plans/limits';
import { createOrGetClientZone, upsertClientZoneRecord } from '@/lib/cloudflare/zones';
import type { CustomDomainPath, CustomDomainRow, PublicCustomDomain } from './types';
import { isOurZone, normalizeHostname, zoneNameForHostname } from './hostname';
import { expectedTargetFor, publishedHostFor, toPublicCustomDomain } from './instructions';
import {
  DuplicateHostnameError,
  findCustomDomainByHostname,
  insertCustomDomain,
  updateCustomDomain,
} from './store';

export type DomainActionErr = { ok: false; error: string; status: number };
export type DomainActionOk<T> = { ok: true; data: T };
export type DomainActionResult<T> = DomainActionOk<T> | DomainActionErr;

async function loadPublishedDeployment(projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true },
  });
  if (!project) return { ok: false as const, error: 'Project not found', status: 404 as const };
  const deployment = await prisma.deployment.findFirst({
    where: { projectId, kind: 'LIVE', status: { not: 'STOPPED' } },
    include: { server: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!deployment) {
    return {
      ok: false as const,
      error: 'Publish the site first, then add a custom domain',
      status: 400 as const,
    };
  }
  return { ok: true as const, deployment };
}

export async function createCustomDomain(input: {
  projectId: string;
  hostname: string;
  path: CustomDomainPath;
}): Promise<DomainActionResult<PublicCustomDomain>> {
  const hostname = normalizeHostname(input.hostname);
  if (!hostname) {
    return {
      ok: false,
      error: 'Enter a valid hostname such as example.com or www.example.com',
      status: 400,
    };
  }

  const loaded = await loadPublishedDeployment(input.projectId);
  if (!loaded.ok) return { ok: false, error: loaded.error, status: loaded.status };
  const { deployment } = loaded;

  const allowed = await checkCustomDomainAllowed(deployment.workspaceId);
  if (!allowed.ok) {
    return { ok: false, error: allowed.message, status: allowed.status };
  }

  const zone = await peekRootDomain(deployment.workspaceId);
  if (!zone) {
    return { ok: false, error: 'Cloudflare is not connected', status: 409 };
  }
  if (isOurZone(hostname, zone)) {
    return { ok: false, error: `This hostname is already on our zone (${zone})`, status: 400 };
  }

  const path = input.path === 'B' ? 'B' : 'A';

  // Path B refuses a hostname whose registrable domain we cannot determine confidently (F-220),
  // rather than handing a public suffix like `co.in` to Cloudflare as a zone name.
  const zoneName = path === 'B' ? zoneNameForHostname(hostname) : null;
  if (path === 'B' && !zoneName) {
    return {
      ok: false,
      error: `We cannot manage ${hostname} for you automatically — add it with your own DNS (path A) instead.`,
      status: 400,
    };
  }

  // A row left behind by a provisioning failure is resumable: same deployment, Path B, no zone
  // recorded yet. `createOrGetClientZone` is idempotent, so a retry reuses the zone (F-221). Any
  // other collision is a genuine duplicate and is refused before any Cloudflare call.
  const existing = await findCustomDomainByHostname(hostname);
  const resumable =
    existing &&
    path === 'B' &&
    existing.path === 'B' &&
    existing.deploymentId === deployment.id &&
    !existing.cloudflareZoneId;
  if (existing && !resumable) {
    return { ok: false, error: `This hostname is already in use: ${hostname}`, status: 409 };
  }

  const expectedTarget =
    existing?.expectedTarget ??
    expectedTargetFor({
      hostname,
      serverIp: deployment.server.serverIp,
      slug: deployment.slug,
      kind: deployment.kind,
      zone,
    });
  const verifyToken = existing?.verifyToken ?? randomBytes(16).toString('hex');

  // Reserve the row before touching Cloudflare (F-221): the database is always the record of what
  // exists externally. `DuplicateHostnameError` from the unique index surfaces here — before any
  // zone is created — so a concurrent add can never leave an orphaned zone.
  let row: CustomDomainRow;
  if (existing) {
    row = existing;
  } else {
    try {
      row = await insertCustomDomain({
        deploymentId: deployment.id,
        workspaceId: deployment.workspaceId,
        hostname,
        verifyToken,
        expectedTarget,
        path,
        cloudflareZoneId: null,
        nameservers: null,
      });
    } catch (error) {
      if (error instanceof DuplicateHostnameError) {
        return { ok: false, error: error.message, status: 409 };
      }
      throw error;
    }
  }

  if (path === 'B' && zoneName) {
    try {
      const created = await createOrGetClientZone(zoneName, deployment.workspaceId);
      // Persist the zone id the moment the zone exists, before the record upserts, so a failure
      // mid-provisioning still leaves the receipt teardown and the audit trail rely on.
      row = await updateCustomDomain(row.id, { cloudflareZoneId: created.zoneId });
      await upsertClientZoneRecord({
        workspaceId: deployment.workspaceId,
        zoneId: created.zoneId,
        type: expectedTarget.includes('.') && /[a-z]/i.test(expectedTarget) ? 'CNAME' : 'A',
        name: hostname,
        content: expectedTarget,
      });
      await upsertClientZoneRecord({
        workspaceId: deployment.workspaceId,
        zoneId: created.zoneId,
        type: 'TXT',
        name: `_navroop-verify.${hostname}`,
        content: verifyToken,
      });
      row = await updateCustomDomain(row.id, { nameservers: created.nameservers.slice(0, 2) });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Could not add this hostname as a Cloudflare zone';
      // Keep the row as the receipt (with the zone id if the zone was reached) and name the failure.
      row = await updateCustomDomain(row.id, { lastError: message });
      return { ok: false, error: message, status: 502 };
    }
  }

  return {
    ok: true,
    data: toPublicCustomDomain(
      row,
      publishedHostFor({ slug: deployment.slug, kind: deployment.kind, zone }),
    ),
  };
}
