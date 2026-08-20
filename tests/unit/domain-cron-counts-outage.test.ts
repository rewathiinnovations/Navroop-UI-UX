import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A DNS outage must turn the domain cron run red, not report a healthy check (F-219).
 *
 * `checkDueCustomDomains` deliberately separates `failed` (a customer whose DNS is not pointed at
 * us yet — normal for days, shown on their card) from `errors` (a check that *threw* — ours). A
 * resolver failure now throws `DomainCheckUnavailableError`, so it lands in `errors` and fails the
 * run instead of silently passing as a swallowed `[]`.
 *
 * Goes red if: a thrown check stops being counted as an error, or the run reports ok on an outage.
 */

const store = vi.hoisted(() => ({ listCheckableCustomDomains: vi.fn() }));
const verify = vi.hoisted(() => ({ checkDomain: vi.fn() }));

vi.mock('@/lib/domains/store', () => ({
  listCheckableCustomDomains: store.listCheckableCustomDomains,
}));
vi.mock('@/lib/domains/verify', () => ({ checkDomain: verify.checkDomain }));

const { checkDueCustomDomains } = await import('@/lib/domains/cron.ts');
const { DomainCheckUnavailableError } = await import('@/lib/domains/errors.ts');

const NOW = new Date('2026-08-20T12:00:00.000Z');
const OLD = new Date('2026-08-10T12:00:00.000Z'); // due for a check

beforeEach(() => {
  vi.clearAllMocks();
  store.listCheckableCustomDomains.mockResolvedValue([
    { id: 'dom_1', createdAt: OLD, lastCheckedAt: null },
  ]);
});

describe('checkDueCustomDomains', () => {
  it('counts a resolver outage as an error and turns the run red', async () => {
    verify.checkDomain.mockRejectedValue(
      new DomainCheckUnavailableError('DNS check could not run: TXT (SERVFAIL)'),
    );

    const result = await checkDueCustomDomains(NOW);

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('SERVFAIL');
    expect(result.checked).toBe(0);
    expect(result.failed).toBe(0);
  });
});
