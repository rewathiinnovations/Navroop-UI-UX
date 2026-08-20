import { describe, expect, it } from 'vitest';

import {
  isApexHostname,
  registrableDomain,
  subdomainLabelFor,
  zoneNameForHostname,
} from '@/lib/domains/hostname.ts';
import { buildDnsInstructions, expectedTargetFor } from '@/lib/domains/instructions.ts';

/**
 * Apex detection must come from the registrable domain, not from the label count (F-220).
 *
 * `isApexHostname` was `labels.length === 2` and `zoneNameForHostname` returned the last two
 * labels, so `example.co.in` was treated as a subdomain (we asked for a CNAME at a zone apex,
 * which is invalid DNS and can never verify) and Path B asked Cloudflare to create the zone
 * `co.in`. No public-suffix package is installed and no dependency may be added this wave, so
 * the list in `lib/domains/hostname.ts` is explicit and deliberately incomplete: a hostname
 * whose registrable domain cannot be determined confidently is refused for Path B rather than
 * guessed.
 *
 * Goes red if: the label count comes back, the list loses an entry, or the A-vs-CNAME
 * instruction and the record `checkDomain` verifies stop agreeing.
 */

const TARGET = {
  serverIp: '203.0.113.10',
  slug: 'acme',
  kind: 'LIVE' as const,
  zone: 'navroop.test',
};

describe('registrable domain', () => {
  it('treats a hostname on a known multi-label suffix as apex', () => {
    expect(registrableDomain('example.co.in')).toBe('example.co.in');
    expect(isApexHostname('example.co.in')).toBe(true);
    expect(isApexHostname('example.co.uk')).toBe(true);
    expect(isApexHostname('example.com.au')).toBe(true);
    expect(isApexHostname('example.co.za')).toBe(true);
  });

  it('treats a label under that registrable domain as a subdomain', () => {
    expect(registrableDomain('www.example.co.in')).toBe('example.co.in');
    expect(isApexHostname('www.example.co.in')).toBe(false);
    expect(subdomainLabelFor('www.example.co.in')).toBe('www');
    expect(subdomainLabelFor('api.v2.example.co.uk')).toBe('api.v2');
  });

  it('keeps single-label suffixes working', () => {
    expect(isApexHostname('example.com')).toBe(true);
    expect(isApexHostname('www.example.com')).toBe(false);
    expect(registrableDomain('www.example.com')).toBe('example.com');
    expect(subdomainLabelFor('shop.example.com')).toBe('shop');
  });

  it('refuses Path B when the registrable domain cannot be determined', () => {
    // `co.zz` is suffix-shaped under a two-letter ccTLD we do not have on the list.
    expect(registrableDomain('example.co.zz')).toBeNull();
    expect(zoneNameForHostname('example.co.zz')).toBeNull();
    // The hostname *is* a public suffix: there is no registrable domain to own.
    expect(zoneNameForHostname('co.in')).toBeNull();
  });

  it('never hands a public suffix to Cloudflare as a zone name', () => {
    expect(zoneNameForHostname('example.co.in')).toBe('example.co.in');
    expect(zoneNameForHostname('www.example.co.in')).toBe('example.co.in');
    expect(zoneNameForHostname('shop.example.com')).toBe('example.com');
  });
});

describe('DNS instructions follow the same source', () => {
  it('asks for an A record at @ for a multi-label-suffix apex', () => {
    const hostname = 'example.co.in';
    const expectedTarget = expectedTargetFor({ hostname, ...TARGET });
    expect(expectedTarget).toBe(TARGET.serverIp);

    const rows = buildDnsInstructions({
      hostname,
      verifyToken: 'token',
      expectedTarget,
      path: 'A',
      nameservers: null,
    });
    const apexRow = rows.find((entry) => entry.type === 'A' || entry.type === 'CNAME');
    expect(apexRow?.type).toBe('A');
    expect(apexRow?.name).toBe('@');
  });

  it('asks for a CNAME at the sub-label for a subdomain of one', () => {
    const hostname = 'www.example.co.in';
    const expectedTarget = expectedTargetFor({ hostname, ...TARGET });
    expect(expectedTarget).toBe('acme.navroop.test');

    const rows = buildDnsInstructions({
      hostname,
      verifyToken: 'token',
      expectedTarget,
      path: 'A',
      nameservers: null,
    });
    const apexRow = rows.find((entry) => entry.type === 'A' || entry.type === 'CNAME');
    expect(apexRow?.type).toBe('CNAME');
    expect(apexRow?.name).toBe('www');
  });

  it('uses the full sub-label, not the first one', () => {
    const rows = buildDnsInstructions({
      hostname: 'api.v2.example.com',
      verifyToken: 'token',
      expectedTarget: 'acme.navroop.test',
      path: 'A',
      nameservers: null,
    });
    expect(rows.find((entry) => entry.type === 'CNAME')?.name).toBe('api.v2');
  });
});
