import { describe, expect, it } from 'vitest';
import { rankAndSelect, type ProviderCandidate } from '../../lib/sandbox/router';

function candidate(
  partial: Partial<ProviderCandidate> & Pick<ProviderCandidate, 'id' | 'creditType'>,
): ProviderCandidate {
  return {
    name: partial.name ?? partial.id,
    driver: partial.driver ?? 'e2b',
    isActive: partial.isActive ?? true,
    priority: partial.priority ?? 100,
    weight: partial.weight ?? 1,
    creditRemainingUsd: partial.creditRemainingUsd ?? 10,
    creditTotalUsd: partial.creditTotalUsd ?? 10,
    monthlyBudgetUsd: partial.monthlyBudgetUsd ?? null,
    monthlyMinutesLimit: partial.monthlyMinutesLimit ?? null,
    minutesUsed: partial.minutesUsed ?? 0,
    spendUsd: partial.spendUsd ?? 0,
    healthStatus: partial.healthStatus ?? 'unknown',
    lastCheckedAt: partial.lastCheckedAt ?? null,
    consecutiveFails: partial.consecutiveFails ?? 0,
    downUntil: partial.downUntil ?? null,
    periodStart: partial.periodStart ?? new Date('2026-08-01T00:00:00.000Z'),
    creditResetsAt: partial.creditResetsAt ?? null,
    config: partial.config ?? { cpu: 1, memoryGiB: 1 },
    ...partial,
  };
}

const COST = { cpuPerSecUsd: 0.0001, memPerGibSecUsd: 0.00005 };

describe('selectProvider health ranking under free_first', () => {
  it('still boots when every row is unknown — fresh install is not a hard refuse', () => {
    const modal = candidate({
      id: 'modal-1',
      name: 'Model',
      driver: 'modal',
      creditType: 'recurring_monthly',
      priority: 10,
      healthStatus: 'unknown',
    });
    const e2b = candidate({
      id: 'e2b-1',
      name: 'E2B one-time',
      driver: 'e2b',
      creditType: 'one_time',
      creditRemainingUsd: 2,
      priority: 20,
      healthStatus: 'unknown',
    });
    const pick = rankAndSelect({
      candidates: [e2b, modal],
      strategy: 'free_first',
      costModelFor: () => COST,
      estimateSeconds: 60,
    });
    expect(pick.id).toBe('modal-1');
    expect(pick.selectionReason).toMatch(/Model/);
    expect(pick.selectionReason).toMatch(/monthly free credit/i);
    expect(pick.selectionReason).toMatch(/not checked yet/i);
  });

  it('does not let a known-healthy one-time row jump ahead of unused monthly credit', () => {
    const unknownMonthly = candidate({
      id: 'modal-1',
      name: 'Model',
      driver: 'modal',
      creditType: 'recurring_monthly',
      priority: 10,
      healthStatus: 'unknown',
    });
    const healthyOneTime = candidate({
      id: 'e2b-1',
      name: 'E2B',
      driver: 'e2b',
      creditType: 'one_time',
      creditRemainingUsd: 8,
      priority: 20,
      healthStatus: 'healthy',
    });
    const pick = rankAndSelect({
      candidates: [healthyOneTime, unknownMonthly],
      strategy: 'free_first',
      costModelFor: () => COST,
      estimateSeconds: 60,
    });
    expect(pick.id).toBe('modal-1');
  });

  it('prefers a known-healthy one-time row over an unchecked cheaper one-time row', () => {
    const unknownCheap = candidate({
      id: 'e2b-cheap',
      creditType: 'one_time',
      creditRemainingUsd: 2,
      priority: 10,
      healthStatus: 'unknown',
    });
    const healthyDearer = candidate({
      id: 'e2b-healthy',
      name: 'E2B healthy',
      creditType: 'one_time',
      creditRemainingUsd: 40,
      priority: 90,
      healthStatus: 'healthy',
    });
    const pick = rankAndSelect({
      candidates: [unknownCheap, healthyDearer],
      strategy: 'free_first',
      costModelFor: () => COST,
      estimateSeconds: 60,
    });
    expect(pick.id).toBe('e2b-healthy');
    expect(pick.selectionReason).toMatch(/known healthy/i);
  });

  it('does not prefer a degraded row over an unknown one just because it is cheaper', () => {
    const degradedCheap = candidate({
      id: 'e2b-degraded',
      creditType: 'one_time',
      creditRemainingUsd: 2,
      priority: 10,
      healthStatus: 'degraded',
    });
    const unknownDearer = candidate({
      id: 'e2b-unknown',
      name: 'E2B unknown',
      creditType: 'one_time',
      creditRemainingUsd: 50,
      priority: 90,
      healthStatus: 'unknown',
    });
    const pick = rankAndSelect({
      candidates: [degradedCheap, unknownDearer],
      strategy: 'free_first',
      costModelFor: () => COST,
      estimateSeconds: 60,
    });
    expect(pick.id).toBe('e2b-unknown');
    expect(pick.selectionReason).toMatch(/not checked yet/i);
  });

  it('still excludes a circuit-open down row', () => {
    const down = candidate({
      id: 'modal-down',
      creditType: 'recurring_monthly',
      healthStatus: 'down',
      downUntil: new Date('2026-08-18T04:00:00.000Z'),
    });
    const unknown = candidate({
      id: 'e2b-1',
      creditType: 'one_time',
      healthStatus: 'unknown',
    });
    const pick = rankAndSelect({
      candidates: [down, unknown],
      strategy: 'free_first',
      now: new Date('2026-08-18T03:50:00.000Z'),
      costModelFor: () => COST,
      estimateSeconds: 60,
    });
    expect(pick.id).toBe('e2b-1');
  });

  it('honours sticky even when the stored row is still unknown', () => {
    const modal = candidate({
      id: 'modal-1',
      creditType: 'recurring_monthly',
      healthStatus: 'healthy',
      priority: 10,
    });
    const stored = candidate({
      id: 'e2b-sticky',
      name: 'Stored E2B',
      creditType: 'one_time',
      healthStatus: 'unknown',
      priority: 90,
    });
    const pick = rankAndSelect({
      candidates: [modal, stored],
      strategy: 'free_first',
      stickyConfigId: 'e2b-sticky',
      costModelFor: () => COST,
      estimateSeconds: 60,
    });
    expect(pick.id).toBe('e2b-sticky');
    expect(pick.selectionReason).toMatch(/sticky/i);
    expect(pick.selectionReason).toMatch(/Stored E2B/);
  });
});

describe('health preference on other strategies', () => {
  it('does not let cheapest pick a degraded row over an unknown one', () => {
    const degraded = candidate({
      id: 'modal-degraded',
      driver: 'modal',
      creditType: 'paid',
      healthStatus: 'degraded',
      config: { cpu: 1, memoryGiB: 1 },
    });
    const unknown = candidate({
      id: 'e2b-unknown',
      driver: 'e2b',
      creditType: 'paid',
      healthStatus: 'unknown',
      config: { cpu: 8, memoryGiB: 8 },
    });
    const pick = rankAndSelect({
      candidates: [degraded, unknown],
      strategy: 'cheapest',
      costModelFor: () => COST,
      estimateSeconds: 60,
    });
    expect(pick.id).toBe('e2b-unknown');
  });

  it('prefers a known-healthy row over an unchecked higher-priority row', () => {
    const unknownFirst = candidate({
      id: 'unknown-first',
      creditType: 'paid',
      healthStatus: 'unknown',
      priority: 1,
    });
    const healthyLater = candidate({
      id: 'healthy-later',
      name: 'Healthy',
      creditType: 'paid',
      healthStatus: 'healthy',
      priority: 50,
    });
    const pick = rankAndSelect({
      candidates: [unknownFirst, healthyLater],
      strategy: 'priority',
      costModelFor: () => COST,
      estimateSeconds: 60,
    });
    expect(pick.id).toBe('healthy-later');
    expect(pick.selectionReason).toMatch(/Healthy/);
  });
});
