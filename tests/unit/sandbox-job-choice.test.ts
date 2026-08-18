import { describe, expect, it } from 'vitest';
import { createWithFailover } from '../../lib/sandbox/failover';
import { markSandboxAttemptBootFailed, toStoredSandboxChoice } from '../../lib/sandbox/job-attempts';
import { rankAndSelect, type ProviderCandidate } from '../../lib/sandbox/router';
import { sandboxChoiceLines } from '../../lib/jobs/sandbox-choice';
import { parseResourceIds } from '../../lib/jobs/types';

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

describe('Job sandbox choice — why the first provider went first', () => {
  it('copies the pick selectionReason onto the first create attempt', async () => {
    const pick = candidate({
      id: 'modal-1',
      name: 'Model',
      driver: 'modal',
      creditType: 'recurring_monthly',
      healthStatus: 'unknown',
      selectionReason: 'Model — monthly free credit; not checked yet — still eligible so a first boot can run.',
    });
    const result = await createWithFailover({
      candidates: [pick],
      create: async () => ({ sandboxId: 'box-1' }),
    });
    expect(result.attempts[0]?.selectionReason).toBe(pick.selectionReason);
  });

  it('records a cheaper degraded eligible row that lost on health, using the same English as Next pick', () => {
    const cheaperDegraded = candidate({
      id: 'e2b-cheap',
      name: 'E2B cheap',
      creditType: 'one_time',
      creditRemainingUsd: 2,
      priority: 10,
      healthStatus: 'degraded',
    });
    const healthierDearer = candidate({
      id: 'e2b-healthy',
      name: 'E2B healthy',
      creditType: 'one_time',
      creditRemainingUsd: 40,
      priority: 90,
      healthStatus: 'healthy',
    });
    const pick = rankAndSelect({
      candidates: [cheaperDegraded, healthierDearer],
      strategy: 'free_first',
      costModelFor: () => COST,
      estimateSeconds: 60,
    });
    expect(pick.id).toBe('e2b-healthy');
    expect(pick.selectionReason).toMatch(/known healthy/i);
    const skipped = pick.outrankedEligible ?? [];
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.configId).toBe('e2b-cheap');
    expect(skipped[0]?.reason).toMatch(/E2B cheap/);
    expect(skipped[0]?.reason).toMatch(/last create\/echo\/shutdown failed/);
    expect(skipped[0]?.reason).not.toMatch(/no healthier eligible row/);
  });

  it('does not list a down row or a same-health lower-priority row', () => {
    const down = candidate({
      id: 'modal-down',
      name: 'Down monthly',
      creditType: 'recurring_monthly',
      healthStatus: 'down',
      downUntil: new Date('2026-08-18T04:00:00.000Z'),
    });
    const healthyFirst = candidate({
      id: 'e2b-first',
      name: 'E2B first',
      creditType: 'one_time',
      healthStatus: 'healthy',
      priority: 10,
    });
    const healthyLater = candidate({
      id: 'e2b-later',
      name: 'E2B later',
      creditType: 'one_time',
      healthStatus: 'healthy',
      priority: 90,
    });
    const pick = rankAndSelect({
      candidates: [down, healthyFirst, healthyLater],
      strategy: 'free_first',
      now: new Date('2026-08-18T03:50:00.000Z'),
      costModelFor: () => COST,
      estimateSeconds: 60,
    });
    expect(pick.id).toBe('e2b-first');
    expect(pick.outrankedEligible ?? []).toEqual([]);
  });

  it('does not list skipped rows on a sticky pick', () => {
    const healthyMonthly = candidate({
      id: 'modal-1',
      name: 'Model',
      creditType: 'recurring_monthly',
      healthStatus: 'healthy',
    });
    const stored = candidate({
      id: 'e2b-sticky',
      name: 'Stored E2B',
      creditType: 'one_time',
      healthStatus: 'degraded',
    });
    const pick = rankAndSelect({
      candidates: [healthyMonthly, stored],
      strategy: 'free_first',
      stickyConfigId: 'e2b-sticky',
      costModelFor: () => COST,
      estimateSeconds: 60,
    });
    expect(pick.id).toBe('e2b-sticky');
    expect(pick.outrankedEligible ?? []).toEqual([]);
  });
});

describe('stored sandbox choice never carries secrets', () => {
  it('keeps only public attempt fields and lifts skipped English from the first pick', () => {
    const stored = toStoredSandboxChoice([
      {
        configId: 'modal-1',
        driver: 'modal',
        ok: false,
        error: 'Modal could not create a sandbox (401 unauthorized). Check the credentials for this provider on /admin/sandbox-providers.',
        at: '2026-08-18T03:00:00.000Z',
        selectionReason: 'Model — monthly free credit; not checked yet — still eligible so a first boot can run.',
        skipped: [
          {
            configId: 'e2b-cheap',
            name: 'E2B cheap',
            reason: 'E2B cheap — last create/echo/shutdown failed.',
          },
        ],
        secrets: { apiKey: 'sk-live-should-never-land' },
        config: { token: 'tok-secret' },
      } as never,
    ]);
    expect(JSON.stringify(stored)).not.toMatch(/sk-live|tok-secret|apiKey|"token"/);
    expect(stored.sandboxAttempts).toEqual([
      {
        configId: 'modal-1',
        driver: 'modal',
        ok: false,
        error:
          'Modal could not create a sandbox (401 unauthorized). Check the credentials for this provider on /admin/sandbox-providers.',
        at: '2026-08-18T03:00:00.000Z',
        selectionReason: 'Model — monthly free credit; not checked yet — still eligible so a first boot can run.',
      },
    ]);
    expect(stored.sandboxSkipped).toEqual([
      {
        configId: 'e2b-cheap',
        name: 'E2B cheap',
        reason: 'E2B cheap — last create/echo/shutdown failed.',
      },
    ]);
  });

  it('parseResourceIds keeps selectionReason and sandboxSkipped for the admin and recovery UIs', () => {
    const parsed = parseResourceIds({
      sandboxAttempts: [
        {
          configId: 'modal-1',
          driver: 'modal',
          ok: false,
          error: 'create failed',
          at: '2026-08-18T03:00:00.000Z',
          selectionReason: 'Model — monthly free credit; not checked yet — still eligible so a first boot can run.',
        },
      ],
      sandboxSkipped: [
        {
          configId: 'e2b-cheap',
          name: 'E2B cheap',
          reason: 'E2B cheap — last create/echo/shutdown failed.',
        },
      ],
    });
    expect(parsed?.sandboxAttempts?.[0]?.selectionReason).toMatch(/monthly free credit/);
    expect(parsed?.sandboxSkipped?.[0]?.reason).toMatch(/last create\/echo\/shutdown failed/);
    const lines = sandboxChoiceLines(parsed);
    expect(lines.some((line) => line.includes('monthly free credit'))).toBe(true);
    expect(lines.some((line) => line.includes('E2B cheap'))).toBe(true);
    expect(lines.some((line) => line.includes('modal'))).toBe(true);
  });
});

describe('sandboxAttempts.ok is boot outcome, not provider selection', () => {
  it('flips a create-ok attempt to ok:false when ready/teardown later fails', () => {
    const afterCreate = toStoredSandboxChoice([
      {
        configId: 'modal-1',
        driver: 'modal',
        ok: true,
        at: '2026-08-18T03:00:00.000Z',
        selectionReason: 'Model — monthly free credit; not checked yet — still eligible so a first boot can run.',
      },
    ]).sandboxAttempts;
    expect(afterCreate[0]?.ok).toBe(true);

    const afterReadyFail = markSandboxAttemptBootFailed(
      afterCreate,
      'Modal created a sandbox but the preview never became ready (The operation was aborted due to timeout). The unused sandbox was asked to stop.',
    );
    expect(afterReadyFail[0]?.ok).toBe(false);
    expect(afterReadyFail[0]?.error).toMatch(/preview never became ready/);
    expect(afterReadyFail[0]?.error).toMatch(/asked to stop/);
    expect(afterReadyFail[0]?.error).not.toMatch(/stopped so it is not billed/);
    expect(afterReadyFail[0]?.selectionReason).toMatch(/monthly free credit/);
  });
});
