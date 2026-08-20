import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-245: the teardown and domain failure paths logged through `console.warn`.
 *
 * These same files already used `log.warn` for some failures and `console.warn` for others —
 * including every provider-delete failure in `destroyDeployment`. A `console` line carries no
 * request id, is not scrubbed by the `lib/sentry/scrub` pass that `log` shares with Sentry
 * and the audit log, and does not appear in the structured search an operator uses during an
 * incident. That is the wrong medium precisely for the failures that leave a billing resource
 * behind: a Coolify application still running, a DNS record still resolving, a deploy repo
 * still there.
 *
 * The cron case is driven behaviourally. The teardown paths need a live Coolify, Cloudflare
 * and GitHub to reach their catch blocks, so they are pinned by asserting that no `console.`
 * call survives in them and that the events they log are named.
 *
 * Goes red if `console` comes back to any of these files, or if the cron stops naming the
 * domain whose check threw.
 */

const store = vi.hoisted(() => ({ listCheckableCustomDomains: vi.fn() }));
const verify = vi.hoisted(() => ({ checkDomain: vi.fn() }));

vi.mock('@/lib/domains/store', () => ({
  listCheckableCustomDomains: store.listCheckableCustomDomains,
}));
vi.mock('@/lib/domains/verify', () => ({ checkDomain: verify.checkDomain }));

const { log } = await import('@/lib/logger');
const { checkDueCustomDomains } = await import('@/lib/domains/cron.ts');

const NOW = new Date('2026-08-20T12:00:00.000Z');
const OLD = new Date('2026-08-10T12:00:00.000Z');

/**
 * Every file the finding names as a teardown or domain failure path. `lib/domains/cleanup.ts`
 * was converted with F-222 and is listed so a regression there is caught here too.
 */
const SERVER_PATHS = [
  'lib/publish/cleanup.ts',
  'lib/domains/cleanup.ts',
  'lib/domains/actions.ts',
  'lib/domains/cron.ts',
];

function source(path: string) {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

const warnings: Array<{ event: string; fields: unknown }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  warnings.length = 0;
  vi.spyOn(log, 'warn').mockImplementation((event, fields) => {
    warnings.push({ event, fields });
  });
  store.listCheckableCustomDomains.mockResolvedValue([
    { id: 'dom_1', createdAt: OLD, lastCheckedAt: null },
  ]);
});

describe('the domain cron logs a thrown check through the structured logger', () => {
  it('names the domain and the reason in a structured event', async () => {
    verify.checkDomain.mockRejectedValue(new Error('Cloudflare 502'));

    const result = await checkDueCustomDomains(NOW);

    expect(result.ok).toBe(false);
    const entry = warnings.find((row) => row.event.startsWith('domains.'));
    expect(entry).toBeDefined();
    expect(entry?.fields).toMatchObject({ domainId: 'dom_1' });
    expect(JSON.stringify(entry?.fields)).toContain('Cloudflare 502');
  });

  it('logs nothing when every check comes back', async () => {
    verify.checkDomain.mockResolvedValue({ status: 'ACTIVE' });

    const result = await checkDueCustomDomains(NOW);

    expect(result.ok).toBe(true);
    expect(warnings).toEqual([]);
  });
});

describe('no teardown or domain failure path writes to console', () => {
  for (const path of SERVER_PATHS) {
    it(`${path} logs through lib/logger only`, () => {
      const text = source(path);
      expect(text).not.toMatch(/\bconsole\s*\.\s*(log|info|warn|error|debug)\s*\(/);
      expect(text).toContain("from '@/lib/logger'");
    });
  }

  it('names every provider whose delete failed during a deployment teardown', () => {
    const text = source('lib/publish/cleanup.ts');
    // One event per provider, so an incident search can tell a stuck Coolify app from a
    // stuck DNS record from a stuck repo without reading stdout.
    for (const event of [
      'publish.custom_domain_cleanup_failed',
      'publish.coolify_delete_failed',
      'publish.dns_delete_failed',
      'publish.repo_delete_failed',
    ]) {
      expect(text).toContain(event);
    }
  });
});
