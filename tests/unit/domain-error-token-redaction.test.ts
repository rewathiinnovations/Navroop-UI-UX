import { describe, expect, it } from 'vitest';
import { formatRecordMismatch } from '@/lib/domains/errors';

/**
 * F-208: `formatRecordMismatch` output is persisted into `CustomDomain.lastError`,
 * which `getProjectDomainState` serialises to every workspace member — including
 * read-only viewers whose payload has the verify token stripped. The verify token
 * is a capability (whoever holds it can pass `checkDomain`), so the TXT mismatch
 * message must never contain it. The legitimate owner-facing surface for the token
 * is the TXT row of `buildDnsInstructions`, which is access-controlled.
 */

const TOKEN = 'vtok-12345';

describe('formatRecordMismatch', () => {
  it('never embeds the verify token when the TXT record is missing', () => {
    const msg = formatRecordMismatch({
      recordType: 'TXT',
      hostname: '_navroop-verify.client.com',
      found: [],
      expected: TOKEN,
    });
    expect(msg).not.toContain(TOKEN);
    expect(msg).toContain('_navroop-verify.client.com');
    expect(msg).toMatch(/missing/i);
  });

  it('never embeds the verify token when a wrong TXT value is published', () => {
    const msg = formatRecordMismatch({
      recordType: 'TXT',
      hostname: '_navroop-verify.client.com',
      found: ['stale-value'],
      expected: TOKEN,
    });
    expect(msg).not.toContain(TOKEN);
    expect(msg).toMatch(/does not match/i);
  });

  it('points the user at the DNS instructions, which carry the token behind access control', () => {
    const msg = formatRecordMismatch({
      recordType: 'TXT',
      hostname: '_navroop-verify.client.com',
      found: [],
      expected: TOKEN,
    });
    expect(msg).toMatch(/dns instructions/i);
  });

  it('still names found vs expected for A records — the target IP is not a secret', () => {
    const msg = formatRecordMismatch({
      recordType: 'A',
      hostname: 'client.com',
      found: ['1.2.3.4'],
      expected: '5.6.7.8',
    });
    expect(msg).toContain('1.2.3.4');
    expect(msg).toContain('5.6.7.8');
  });

  it('still names found vs expected for CNAME records', () => {
    const msg = formatRecordMismatch({
      recordType: 'CNAME',
      hostname: 'www.client.com',
      found: ['old.example.com'],
      expected: 'site.navroop.app',
    });
    expect(msg).toContain('old.example.com');
    expect(msg).toContain('site.navroop.app');
  });
});
