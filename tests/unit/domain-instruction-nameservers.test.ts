import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { normalizeHostname } from '@/lib/domains/hostname.ts';
import { buildDnsInstructions } from '@/lib/domains/instructions.ts';

/**
 * Two reader traps in the Path B copy path.
 *
 * F-246: `buildDnsInstructions` mapped the first two nameservers into NS rows and then
 * concatenated `nameservers.length === 1 ? [nameservers[0]] : []`. A zone that had reported
 * exactly one nameserver produced the *same* row twice, so the customer was told to add one
 * nameserver two times; the placeholder path printed "Pending nameservers" twice for the same
 * reason. Cloudflare assigns two, and until both are known the honest answer is to say the
 * second one is not known yet — not to repeat the first.
 *
 * F-247: `normalizeHostname` carried `if (value.startsWith('www.') === false &&
 * value.includes(' ')) return null;` immediately above the `HOST_RE` test that rejects spaces
 * on its own. The condition could never change the outcome, and it implied `www.` hostnames
 * were special here. It is deleted; these cases pin that deleting it changed nothing.
 *
 * Goes red if a duplicate NS row comes back, if a single known nameserver stops being
 * distinguishable from a pair, or if the dead `www.` guard is reintroduced.
 */

const PATH_B = {
  hostname: 'example.com',
  verifyToken: 'tok',
  expectedTarget: '203.0.113.10',
  path: 'B' as const,
};

describe('Path B nameserver instructions', () => {
  it('emits one row per nameserver', () => {
    const rows = buildDnsInstructions({
      ...PATH_B,
      nameservers: ['amy.ns.cloudflare.com', 'bob.ns.cloudflare.com'],
    });
    expect(rows.map((row) => row.value)).toEqual([
      'amy.ns.cloudflare.com',
      'bob.ns.cloudflare.com',
    ]);
    expect(rows.every((row) => row.type === 'NS' && row.name === '@')).toBe(true);
  });

  it('never repeats a nameserver when only one is known yet', () => {
    const rows = buildDnsInstructions({ ...PATH_B, nameservers: ['amy.ns.cloudflare.com'] });
    const values = rows.map((row) => row.value);
    expect(new Set(values).size).toBe(values.length);
    expect(values.filter((value) => value === 'amy.ns.cloudflare.com')).toHaveLength(1);
  });

  it('says the second nameserver is not known yet instead of duplicating the first', () => {
    const rows = buildDnsInstructions({ ...PATH_B, nameservers: ['amy.ns.cloudflare.com'] });
    expect(rows).toHaveLength(2);
    expect(rows[1]?.value).toMatch(/pending/i);
  });

  it('drops a nameserver Cloudflare listed twice', () => {
    const rows = buildDnsInstructions({
      ...PATH_B,
      nameservers: ['amy.ns.cloudflare.com', 'amy.ns.cloudflare.com'],
    });
    expect(rows.filter((row) => row.value === 'amy.ns.cloudflare.com')).toHaveLength(1);
  });

  it('shows one pending placeholder when no nameserver is known', () => {
    const rows = buildDnsInstructions({ ...PATH_B, nameservers: null });
    const pending = rows.filter((row) => /pending/i.test(row.value));
    expect(pending).toHaveLength(rows.length);
    expect(new Set(rows.map((row) => row.value)).size).toBe(rows.length);
  });

  it('caps the list at the two nameservers a zone delegates to', () => {
    const rows = buildDnsInstructions({
      ...PATH_B,
      nameservers: ['a.ns.cloudflare.com', 'b.ns.cloudflare.com', 'c.ns.cloudflare.com'],
    });
    expect(rows.map((row) => row.value)).toEqual(['a.ns.cloudflare.com', 'b.ns.cloudflare.com']);
  });
});

describe('normalizeHostname rejects spaces from one rule', () => {
  it('refuses a hostname containing a space whatever it starts with', () => {
    expect(normalizeHostname('exa mple.com')).toBeNull();
    expect(normalizeHostname('www.exa mple.com')).toBeNull();
    expect(normalizeHostname(' www.example.com ')).toBe('www.example.com');
  });

  it('carries no www-specific branch', () => {
    const source = readFileSync('lib/domains/hostname.ts', 'utf8').replace(/\r\n/g, '\n');
    const normalize = source.slice(
      source.indexOf('export function normalizeHostname'),
      source.indexOf('\n}', source.indexOf('export function normalizeHostname')),
    );
    expect(normalize).not.toContain("startsWith('www.')");
    expect(normalize).toContain('HOST_RE.test');
  });
});
