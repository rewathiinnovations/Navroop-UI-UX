import { promises as dns } from 'node:dns';
import ipaddr from 'ipaddr.js';
import { logRejectedUrl } from './reject-log.ts';
import { URL_GUARD_MESSAGES, type UnsafeUrlCode } from './url-guard-messages.ts';

export type { UnsafeUrlCode };
export { URL_GUARD_MESSAGES };

export class UnsafeUrlError extends Error {
  code: UnsafeUrlCode;

  constructor(code: UnsafeUrlCode, message = URL_GUARD_MESSAGES[code]) {
    super(message);
    this.name = 'UnsafeUrlError';
    this.code = code;
  }
}

export type DnsLookupFn = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>;

export type AssertSafeUrlOptions = {
  lookup?: DnsLookupFn;
  userId?: string;
};

const BLOCKED_PROTOCOLS = new Set(['file:', 'ftp:', 'gopher:', 'data:', 'blob:', 'javascript:']);

const IPV4_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
] as const;

const IPV6_CIDRS = ['::/128', '::1/128', 'fc00::/7', 'fe80::/10'] as const;

/**
 * Throws only. Logging moved to `assertSafeUrl`, which can await it: the private-range
 * counter is a database write, and discarding it made an active probe look like no activity
 * on `/admin/usage`. This stays synchronous so its `never` return keeps narrowing the checks
 * below.
 */
function fail(code: UnsafeUrlCode): never {
  throw new UnsafeUrlError(code);
}

export function isBlockedIp(raw: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(raw);
  } catch {
    return false;
  }

  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      return ipv4Blocked(v6.toIPv4Address());
    }
    return IPV6_CIDRS.some((cidr) => v6.match(ipaddr.parseCIDR(cidr)));
  }

  return ipv4Blocked(addr as ipaddr.IPv4);
}

function ipv4Blocked(addr: ipaddr.IPv4): boolean {
  return IPV4_CIDRS.some((cidr) => addr.match(ipaddr.parseCIDR(cidr)));
}

function hostnameLooksPrivate(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === 'internal' || host.endsWith('.internal')) return true;
  if (host === 'local' || host.endsWith('.local')) return true;
  return isBlockedIp(host);
}

function allowedPort(url: URL): boolean {
  if (!url.port) return true;
  return url.port === '80' || url.port === '443';
}

export async function assertSafeUrl(raw: string, opts: AssertSafeUrlOptions = {}): Promise<URL> {
  try {
    return await checkUrl(raw, opts);
  } catch (error) {
    if (error instanceof UnsafeUrlError) {
      // Awaited so the counter write actually lands before the caller sees the rejection.
      // `logRejectedUrl` never throws, so this cannot turn a refusal into a 500.
      await logRejectedUrl({ code: error.code, userId: opts.userId, raw });
    }
    throw error;
  }
}

async function checkUrl(raw: string, opts: AssertSafeUrlOptions): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    fail('protocol');
  }

  if (BLOCKED_PROTOCOLS.has(parsed.protocol) || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    fail('protocol');
  }

  if (parsed.username || parsed.password) {
    fail('credentials');
  }

  if (!allowedPort(parsed)) {
    fail('port');
  }

  if (hostnameLooksPrivate(parsed.hostname)) {
    fail('private');
  }

  const lookup = opts.lookup ?? ((hostname: string) => dns.lookup(hostname, { all: true }));
  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(parsed.hostname, { all: true });
  } catch {
    fail('unresolved');
  }

  if (!records?.length) {
    fail('unresolved');
  }

  for (const record of records) {
    if (isBlockedIp(record.address)) {
      fail('private');
    }
  }

  return parsed;
}
