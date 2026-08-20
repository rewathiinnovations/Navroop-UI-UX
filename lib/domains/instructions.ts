import { hostForSlug } from '@/lib/publish/slug';
import { isApexHostname, subdomainLabelFor, verifyTxtName } from './hostname';
import {
  TIMELINE_STEPS,
  type CustomDomainRow,
  type DnsInstruction,
  type PublicCustomDomain,
} from './types';

/** Cloudflare delegates a zone to exactly two nameservers, so Path B always shows two rows. */
const NAMESERVERS_PER_ZONE = 2;

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

export function buildDnsInstructions(
  row: Pick<
    CustomDomainRow,
    'hostname' | 'verifyToken' | 'expectedTarget' | 'path' | 'nameservers'
  >,
): DnsInstruction[] {
  if (row.path === 'B') {
    // One row per *distinct* nameserver. The old shape mapped the first two and then
    // concatenated the first one again when only one was known, so a zone mid-assignment
    // told the customer to add the same nameserver twice (and printed the placeholder
    // twice) — F-246. Cloudflare delegates a zone to two, so when fewer than two are
    // known the missing rows say so instead of repeating what is known.
    const known: string[] = [];
    for (const value of row.nameservers ?? []) {
      const trimmed = value.trim();
      if (!trimmed || known.includes(trimmed)) continue;
      known.push(trimmed);
      if (known.length === NAMESERVERS_PER_ZONE) break;
    }
    const rows: DnsInstruction[] = known.map((value) => ({
      type: 'NS' as const,
      name: '@',
      value,
      ttl: 'Auto',
    }));
    while (rows.length < NAMESERVERS_PER_ZONE) {
      rows.push({
        type: 'NS',
        name: '@',
        value: `Pending nameserver ${rows.length + 1} of ${NAMESERVERS_PER_ZONE}`,
        ttl: 'Auto',
      });
    }
    return rows;
  }

  const apex = isApexHostname(row.hostname);
  const label = subdomainLabelFor(row.hostname);
  const records: DnsInstruction[] = apex
    ? [{ type: 'A', name: label, value: row.expectedTarget, ttl: '300' }]
    : [{ type: 'CNAME', name: label, value: row.expectedTarget, ttl: '300' }];
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
    status === 'ACTIVE'
      ? 4
      : status === 'SSL_PENDING'
        ? 3
        : status === 'VERIFYING' || status === 'FAILED'
          ? 2
          : 1;
  return TIMELINE_STEPS.map((step, index) => ({
    id: step.id,
    label: step.label,
    done: index < reached,
    current:
      status === 'FAILED'
        ? step.id === 'dns'
        : index === reached - 1 && status !== 'ACTIVE'
          ? true
          : status === 'ACTIVE' && step.id === 'live',
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

/**
 * Strip the verify token from a domain about to be sent to a read-only viewer.
 *
 * Project reads are workspace-wide by design (`lib/auth/route-policy.ts`), but the verify
 * token is a capability, not project data: whoever holds it can publish the `_navroop-verify`
 * TXT record and pass `checkDomain` for that hostname. A member who cannot mutate the domain
 * therefore gets the A/CNAME rows only — the TXT row would hand over the token verbatim.
 */
export function withoutVerifyToken(domain: PublicCustomDomain): PublicCustomDomain {
  return {
    ...domain,
    verifyToken: '',
    instructions: domain.instructions.filter((row) => row.value !== domain.verifyToken),
  };
}

export function instructionsPlainText(rows: DnsInstruction[]) {
  return rows.map((row) => `${row.type}\t${row.name}\t${row.value}\tTTL ${row.ttl}`).join('\n');
}
