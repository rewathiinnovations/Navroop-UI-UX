import { promises as dns } from 'node:dns';
import type { DnsLookup, DomainDns } from './types';

/**
 * A resolver failure is not evidence about the customer's records (F-219). An empty array and a
 * SERVFAIL used to read identically as "the record is missing"; the caller then blamed the
 * customer and, after seven days, marked the domain FAILED for DNS that may be perfectly correct.
 *
 * NXDOMAIN / ENODATA / ENOTFOUND are real answers — the name (or the record type on it) does not
 * exist — so they map to `no-records`. Everything else (SERVFAIL, a timeout, EAI_AGAIN, or no
 * resolver at all) is `failed`: we could not look, and the caller must not treat that as a verdict.
 */
const NO_RECORD_CODES: Record<string, true> = { ENODATA: true, ENOTFOUND: true, NXDOMAIN: true };

function classifyDnsError(
  error: unknown,
): Extract<DnsLookup<never>, { status: 'no-records' | 'failed' }> {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code && NO_RECORD_CODES[code]) return { status: 'no-records' };
  const reason = code || (error instanceof Error ? error.message : String(error));
  return { status: 'failed', reason };
}

export const defaultDomainDns: DomainDns = {
  async resolveTxt(name) {
    try {
      const records = await dns.resolveTxt(name);
      return records.length ? { status: 'records', records } : { status: 'no-records' };
    } catch (error) {
      return classifyDnsError(error);
    }
  },
  async resolve4(name) {
    try {
      const records = await dns.resolve4(name);
      return records.length ? { status: 'records', records } : { status: 'no-records' };
    } catch (error) {
      return classifyDnsError(error);
    }
  },
  async resolveCname(name) {
    try {
      const records = await dns.resolveCname(name);
      return records.length ? { status: 'records', records } : { status: 'no-records' };
    } catch (error) {
      return classifyDnsError(error);
    }
  },
};
