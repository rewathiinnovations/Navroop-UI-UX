import { describe, expect, it } from 'vitest';
import { monthsRemainingAt30DayBurn } from '../../lib/sandbox/credits';
import { toPublicProvider } from '../../lib/sandbox/public';
import type { StoredProviderConfig } from '../../lib/sandbox/store';

function stored(
  partial: Partial<StoredProviderConfig> & Pick<StoredProviderConfig, 'id' | 'name' | 'driver' | 'creditType'>,
): StoredProviderConfig {
  return {
    isActive: true,
    priority: 100,
    weight: 1,
    secrets: 'not-ciphertext',
    config: { cpu: 1 },
    creditTotalUsd: 98,
    creditRemainingUsd: 98,
    creditResetsAt: null,
    monthlyBudgetUsd: null,
    monthlyMinutesLimit: null,
    minutesUsed: 0,
    spendUsd: 0,
    periodStart: new Date('2026-08-01T00:00:00.000Z'),
    healthStatus: 'unknown',
    lastCheckedAt: null,
    lastError: null,
    consecutiveFails: 0,
    createdAt: new Date('2026-08-17T00:00:00.000Z'),
    updatedAt: new Date('2026-08-17T00:00:00.000Z'),
    ...partial,
  };
}

describe('monthsRemainingAt30DayBurn', () => {
  it('returns null when there is remaining credit but no 30-day burn — never Infinity', () => {
    expect(monthsRemainingAt30DayBurn(98, 0, 0)).toBeNull();
    expect(monthsRemainingAt30DayBurn(98, 0, 0)).not.toBe(Number.POSITIVE_INFINITY);
  });

  it('returns remaining / burn when spend is positive', () => {
    expect(monthsRemainingAt30DayBurn(0.9, 30, 0.3)).toBe(3);
  });
});

describe('toPublicProvider monthsRemaining', () => {
  it('emits null for an unused one-time pool so JSON and RSC never see Infinity', () => {
    const row = toPublicProvider(
      stored({ id: 'e2b-1', name: 'E2B', driver: 'e2b', creditType: 'one_time', creditRemainingUsd: 98, spendUsd: 0 }),
    );
    expect(row.monthsRemaining).toBeNull();
    expect(Number.isFinite(row.monthsRemaining as number)).toBe(false);
    const wired = JSON.parse(JSON.stringify(row)) as { monthsRemaining: number | null };
    expect(wired.monthsRemaining).toBeNull();
  });

  it('keeps a finite projection when the pool has a 30-day burn', () => {
    const row = toPublicProvider(
      stored({
        id: 'e2b-1',
        name: 'E2B',
        driver: 'e2b',
        creditType: 'one_time',
        creditRemainingUsd: 9,
        spendUsd: 3,
      }),
    );
    expect(row.monthsRemaining).toBe(3);
  });
});
