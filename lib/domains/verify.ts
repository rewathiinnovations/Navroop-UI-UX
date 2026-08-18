import { prisma } from '@/lib/db';
import { serverAuth } from '@/lib/coolify/servers';
import {
  addApplicationDomain,
  applicationSslReady,
  getApplication,
} from '@/lib/coolify/client';
import { nextCheckDelayMs } from './backoff';
import { defaultDomainDns } from './dns';
import { formatRecordMismatch } from './errors';
import { isApexHostname, stripDnsDot, verifyTxtName } from './hostname';
import { notifyDomainFailed } from './notify';
import { applyPrimaryRedirects } from './redirects';
import { clearPrimaryForDeployment, findCustomDomain, listCustomDomainsForDeployment, updateCustomDomain } from './store';
import type { CustomDomainRow, DomainDns } from './types';

export type CheckDomainDeps = {
  dns?: DomainDns;
  addToCoolify?: (row: CustomDomainRow) => Promise<void>;
  sslReady?: (row: CustomDomainRow) => Promise<boolean>;
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
  await addApplicationDomain(serverAuth(deployment.server), deployment.coolifyAppUuid, row.hostname);
}

async function defaultSslReady(row: CustomDomainRow) {
  const deployment = await prisma.deployment.findUnique({
    where: { id: row.deploymentId },
    include: { server: true },
  });
  if (!deployment?.coolifyAppUuid) return false;
  const app = await getApplication(serverAuth(deployment.server), deployment.coolifyAppUuid);
  return applicationSslReady(app, row.hostname);
}

export async function checkDomain(id: string, deps: CheckDomainDeps = {}): Promise<CustomDomainRow> {
  const now = deps.now ?? new Date();
  const dns = deps.dns ?? defaultDomainDns;
  const found = await findCustomDomain(id);
  if (!found) throw new Error('Custom domain not found');
  let row: CustomDomainRow = found;

  if (nextCheckDelayMs(row.createdAt, now) === 'failed' && row.status !== 'ACTIVE') {
    row = await updateCustomDomain(id, {
      status: 'FAILED',
      lastCheckedAt: now,
      lastError: row.lastError || 'DNS did not match the expected records within 7 days.',
    });
    await notifyDomainFailed(row);
    return row;
  }

  row = await updateCustomDomain(id, { status: row.status === 'SSL_PENDING' ? 'SSL_PENDING' : 'VERIFYING', lastCheckedAt: now });

  const errors: string[] = [];
  const txtName = verifyTxtName(row.hostname);
  const txtFound = flattenTxt(await dns.resolveTxt(txtName));
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

  if (isApexHostname(row.hostname)) {
    const found = await dns.resolve4(row.hostname);
    const matches = found.some((ip) => ip === row.expectedTarget);
    if (!matches) {
      errors.push(
        formatRecordMismatch({
          recordType: 'A',
          hostname: row.hostname,
          found,
          expected: row.expectedTarget,
        }),
      );
    }
  } else {
    const found = (await dns.resolveCname(row.hostname)).map(stripDnsDot);
    const expected = stripDnsDot(row.expectedTarget);
    if (!found.includes(expected)) {
      const aFound = await dns.resolve4(row.hostname);
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

  if (errors.length) {
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

  let ready = false;
  try {
    ready = await (deps.sslReady ?? defaultSslReady)(row);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'SSL check failed';
    return updateCustomDomain(id, {
      status: 'SSL_PENDING',
      lastCheckedAt: now,
      lastError: message,
    });
  }

  if (!ready) {
    return updateCustomDomain(id, {
      status: 'SSL_PENDING',
      lastCheckedAt: now,
      lastError: null,
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
