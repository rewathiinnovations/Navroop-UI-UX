import { prisma } from '@/lib/db';
import { serverAuth } from '@/lib/coolify/servers';
import {
  addApplicationDomain,
  applicationListsHostname,
  getApplication,
} from '@/lib/coolify/client';
import { nextCheckDelayMs } from './backoff';
import { defaultDomainDns } from './dns';
import { DomainCheckUnavailableError, formatRecordMismatch } from './errors';
import { isApexHostname, stripDnsDot, verifyTxtName } from './hostname';
import { notifyDomainFailed } from './notify';
import { applyPrimaryRedirects } from './redirects';
import { probeHostnameCertificate, type CertificateProbe } from './ssl';
import {
  clearPrimaryForDeployment,
  findCustomDomain,
  listCustomDomainsForDeployment,
  updateCustomDomain,
} from './store';
import type { CustomDomainRow, DomainDns } from './types';

export type CheckDomainDeps = {
  dns?: DomainDns;
  addToCoolify?: (row: CustomDomainRow) => Promise<void>;
  sslReady?: (row: CustomDomainRow) => Promise<CertificateProbe>;
  now?: Date;
};

function flattenTxt(records: string[][]) {
  return records.map((chunks) => chunks.join(''));
}

async function defaultAddToCoolify(row: CustomDomainRow) {
  const deployment = await prisma.deployment.findUnique({
    where: { id: row.deploymentId },
    include: { server: true },
  });
  if (!deployment?.coolifyAppUuid) {
    throw new Error('Published app is missing on Coolify');
  }
  await addApplicationDomain(
    serverAuth(deployment.server),
    deployment.coolifyAppUuid,
    row.hostname,
  );
}

async function defaultSslReady(row: CustomDomainRow): Promise<CertificateProbe> {
  const deployment = await prisma.deployment.findUnique({
    where: { id: row.deploymentId },
    include: { server: true },
  });
  if (!deployment?.coolifyAppUuid) {
    return { status: 'unavailable', reason: 'Published app is missing on Coolify' };
  }
  const app = await getApplication(serverAuth(deployment.server), deployment.coolifyAppUuid);
  if (!applicationListsHostname(app, row.hostname)) {
    return { status: 'pending', reason: 'The domain is not attached to the Coolify app yet' };
  }
  // The certificate on the wire is the only ground truth for SSL (F-217) — Coolify's row does
  // not say. `probeHostnameCertificate` returns 'ready' only when a live cert covers the host.
  return probeHostnameCertificate(row.hostname);
}

/** Terminal FAILED transition. A FAILED write always emails the admins, so the two must stay
 *  together and must only ever run on real evidence (a resolver answer or an SSL probe). */
async function failDomain(id: string, now: Date, reason: string): Promise<CustomDomainRow> {
  const failed = await updateCustomDomain(id, {
    status: 'FAILED',
    lastCheckedAt: now,
    lastError: reason,
  });
  await notifyDomainFailed(failed);
  return failed;
}

export async function checkDomain(
  id: string,
  deps: CheckDomainDeps = {},
): Promise<CustomDomainRow> {
  const now = deps.now ?? new Date();
  const dns = deps.dns ?? defaultDomainDns;
  const found = await findCustomDomain(id);
  if (!found) throw new Error('Custom domain not found');
  let row: CustomDomainRow = found;
  const previousStatus = row.status;

  // Mark the check in-flight. The 7-day expiry is evaluated *after* the lookups (F-219): a check
  // that could not reach the resolver must never advance the clock to FAILED.
  row = await updateCustomDomain(id, {
    status: row.status === 'SSL_PENDING' ? 'SSL_PENDING' : 'VERIFYING',
    lastCheckedAt: now,
  });

  const errors: string[] = [];
  const lookupFailures: string[] = [];

  const txtName = verifyTxtName(row.hostname);
  const txt = await dns.resolveTxt(txtName);
  if (txt.status === 'failed') {
    lookupFailures.push(`TXT ${txtName} (${txt.reason})`);
  } else {
    const txtFound = txt.status === 'records' ? flattenTxt(txt.records) : [];
    if (!txtFound.some((value) => value === row.verifyToken)) {
      errors.push(
        formatRecordMismatch({
          recordType: 'TXT',
          hostname: txtName,
          found: txtFound,
          expected: row.verifyToken,
        }),
      );
    }
  }

  if (isApexHostname(row.hostname)) {
    const a = await dns.resolve4(row.hostname);
    if (a.status === 'failed') {
      lookupFailures.push(`A ${row.hostname} (${a.reason})`);
    } else {
      const found = a.status === 'records' ? a.records : [];
      if (!found.some((ip) => ip === row.expectedTarget)) {
        errors.push(
          formatRecordMismatch({
            recordType: 'A',
            hostname: row.hostname,
            found,
            expected: row.expectedTarget,
          }),
        );
      }
    }
  } else {
    const cname = await dns.resolveCname(row.hostname);
    if (cname.status === 'failed') {
      lookupFailures.push(`CNAME ${row.hostname} (${cname.reason})`);
    } else {
      const found = (cname.status === 'records' ? cname.records : []).map(stripDnsDot);
      const expected = stripDnsDot(row.expectedTarget);
      if (!found.includes(expected)) {
        // Only fall back to an A lookup — and only report a mismatch — when the fallback itself
        // reached the resolver. A failed fallback is an outage, not a wrong record.
        const a = await dns.resolve4(row.hostname);
        if (a.status === 'failed') {
          lookupFailures.push(`A ${row.hostname} (${a.reason})`);
        } else {
          const aFound = a.status === 'records' ? a.records : [];
          errors.push(
            formatRecordMismatch({
              recordType: 'CNAME',
              hostname: row.hostname,
              found: found.length ? found : aFound,
              expected: row.expectedTarget,
            }),
          );
        }
      }
    }
  }

  // A lookup we could not run is not a verdict (F-219). Do not blame the customer, do not let the
  // expiry fire, and throw so `checkDueCustomDomains` counts it as our error and turns the run red.
  if (lookupFailures.length) {
    const message = `DNS check could not run: ${lookupFailures.join('; ')}`;
    await updateCustomDomain(id, {
      status: previousStatus,
      lastCheckedAt: now,
      lastError: message,
    });
    throw new DomainCheckUnavailableError(message);
  }

  const expired = nextCheckDelayMs(row.createdAt, now) === 'failed' && previousStatus !== 'ACTIVE';

  if (errors.length) {
    // The resolver answered and it disagreed — a real answer, so the expiry may now apply.
    if (expired) {
      return failDomain(
        id,
        now,
        `DNS did not match the expected records within 7 days. ${errors.join(' ')}`,
      );
    }
    return updateCustomDomain(id, {
      status: 'PENDING_DNS',
      lastCheckedAt: now,
      lastError: errors.join(' '),
    });
  }

  row = await updateCustomDomain(id, {
    status: 'SSL_PENDING',
    lastCheckedAt: now,
    lastError: null,
  });

  try {
    await (deps.addToCoolify ?? defaultAddToCoolify)(row);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not add the domain to Coolify';
    return updateCustomDomain(id, {
      status: 'SSL_PENDING',
      lastCheckedAt: now,
      lastError: message,
    });
  }

  let probe: CertificateProbe;
  try {
    probe = await (deps.sslReady ?? defaultSslReady)(row);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'SSL check failed';
    return updateCustomDomain(id, {
      status: 'SSL_PENDING',
      lastCheckedAt: now,
      lastError: message,
    });
  }

  if (probe.status !== 'ready') {
    // 'pending' is real evidence the cert has not issued; past the 7-day mark that is terminal.
    // 'unavailable' means we could not look, so it must never reach a FAILED verdict.
    if (probe.status === 'pending' && expired) {
      return failDomain(id, now, `SSL did not issue within 7 days. ${probe.reason}`);
    }
    return updateCustomDomain(id, {
      status: 'SSL_PENDING',
      lastCheckedAt: now,
      lastError: probe.reason,
    });
  }

  const siblings = await listCustomDomainsForDeployment(row.deploymentId);
  const hasPrimary = siblings.some((item) => item.isPrimary && item.status === 'ACTIVE');
  if (!hasPrimary) {
    await clearPrimaryForDeployment(row.deploymentId, row.id);
  }
  row = await updateCustomDomain(id, {
    status: 'ACTIVE',
    lastCheckedAt: now,
    lastError: null,
    sslIssuedAt: now,
    isPrimary: !hasPrimary || row.isPrimary,
  });
  try {
    await applyPrimaryRedirects(row.deploymentId);
  } catch {
    /* Coolify redirect update is best-effort; domain is already live */
  }
  return row;
}
