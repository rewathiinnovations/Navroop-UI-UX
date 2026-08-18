import { hostForSlug } from '@/lib/publish/slug';
import { isApexHostname, verifyTxtName } from './hostname';
import { TIMELINE_STEPS, type CustomDomainRow, type DnsInstruction, type PublicCustomDomain } from './types';

export function publishedHostFor(input: { slug: string; kind: 'LIVE' | 'PREVIEW'; zone: string }) {
  return hostForSlug(input.slug, input.kind, input.zone);
}

export function expectedTargetFor(input: {
  hostname: string;
  serverIp: string;
  slug: string;
  kind: 'LIVE' | 'PREVIEW';
  zone: string;
}) {
  if (isApexHostname(input.hostname)) return input.serverIp;
  return publishedHostFor(input);
}

export function buildDnsInstructions(row: Pick<CustomDomainRow, 'hostname' | 'verifyToken' | 'expectedTarget' | 'path' | 'nameservers'>): DnsInstruction[] {
  if (row.path === 'B') {
    const nameservers = row.nameservers?.length ? row.nameservers : ['Pending nameservers'];
    return nameservers.slice(0, 2).map((value, index) => ({
      type: 'NS' as const,
      name: '@',
      value,
      ttl: 'Auto',
    })).concat(
      nameservers.length === 1
        ? [{ type: 'NS' as const, name: '@', value: nameservers[0] ?? '', ttl: 'Auto' }]
        : [],
    );
  }

  const apex = isApexHostname(row.hostname);
  const hostLabel = row.hostname.split('.')[0] ?? row.hostname;
  const records: DnsInstruction[] = apex
    ? [{ type: 'A', name: '@', value: row.expectedTarget, ttl: '300' }]
    : [{ type: 'CNAME', name: hostLabel, value: row.expectedTarget, ttl: '300' }];
  records.push({
    type: 'TXT',
    name: verifyTxtName(row.hostname),
    value: row.verifyToken,
    ttl: '300',
  });
  return records;
}

export function timelineFor(status: CustomDomainRow['status']) {
  const reached =
    status === 'ACTIVE' ? 4 : status === 'SSL_PENDING' ? 3 : status === 'VERIFYING' || status === 'FAILED' ? 2 : 1;
  return TIMELINE_STEPS.map((step, index) => ({
    id: step.id,
    label: step.label,
    done: index < reached,
    current: status === 'FAILED' ? step.id === 'dns' : index === reached - 1 && status !== 'ACTIVE' ? true : status === 'ACTIVE' && step.id === 'live',
  }));
}

export function toPublicCustomDomain(
  row: CustomDomainRow,
  publishedHost: string,
): PublicCustomDomain {
  return {
    ...row,
    instructions: buildDnsInstructions(row),
    publishedHost,
    timeline: timelineFor(row.status),
  };
}

export function instructionsPlainText(rows: DnsInstruction[]) {
  return rows.map((row) => `${row.type}\t${row.name}\t${row.value}\tTTL ${row.ttl}`).join('\n');
}
