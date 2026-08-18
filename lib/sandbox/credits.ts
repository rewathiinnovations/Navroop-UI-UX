import { currentPeriodStart, shouldRollCreditPeriod } from '@/lib/plans/limits';
import type { CreditType } from './provider';

export type CreditState = {
  creditType: CreditType;
  creditTotalUsd: number | null;
  creditRemainingUsd: number | null;
  periodStart: Date;
  creditResetsAt: Date | null;
};

export function estimateRunCostUsd(
  costModel: { cpuPerSecUsd: number; memPerGibSecUsd: number },
  cpu: number,
  memoryGiB: number,
  seconds: number,
) {
  const safeSeconds = Math.max(0, seconds);
  return cpu * costModel.cpuPerSecUsd * safeSeconds + memoryGiB * costModel.memPerGibSecUsd * safeSeconds;
}

export function remainingCreditUsd(remaining: number | null | undefined) {
  if (remaining == null) return Number.POSITIVE_INFINITY;
  return Number(remaining);
}

export function hasUsableCredit(creditType: CreditType, remaining: number | null | undefined) {
  if (creditType === 'paid') return true;
  if (remaining == null) return creditType === 'recurring_monthly' || creditType === 'one_time';
  return Number(remaining) > 0;
}

export function rollProviderPeriod(state: CreditState, now = new Date()) {
  if (state.creditType !== 'recurring_monthly') {
    return { ...state, didRoll: false };
  }
  if (!shouldRollCreditPeriod(state.periodStart, now)) {
    return { ...state, didRoll: false };
  }
  const periodStart = currentPeriodStart(state.periodStart, now);
  const total = state.creditTotalUsd ?? state.creditRemainingUsd ?? 0;
  return {
    ...state,
    didRoll: true,
    periodStart,
    creditRemainingUsd: total,
    creditResetsAt: new Date(periodStart.getTime() + 30 * 24 * 60 * 60 * 1000),
  };
}

export type CreditAccount = {
  id: string;
  name: string;
  creditType: CreditType;
  creditRemainingUsd: number | null;
  creditTotalUsd: number | null;
  isActive: boolean;
  spendUsd: number;
  minutesUsed: number;
};

export type CreditAlert = 'recurring_80' | 'one_time_low' | 'one_time_exhausted' | 'budget_crossed';

export function monthsRemainingAt30DayBurn(remainingUsd: number, _minutesUsed: number, spendLast30Days: number) {
  const burn = Math.max(spendLast30Days, 0);
  if (burn <= 0) return null;
  const months = remainingUsd / burn;
  return Number.isFinite(months) ? months : null;
}

export function applyCreditConsumption(account: CreditAccount, spendUsd: number) {
  const spend = Math.max(0, spendUsd);
  const previousRemaining = account.creditRemainingUsd;
  const total = account.creditTotalUsd;
  let remaining =
    previousRemaining == null ? null : Math.max(0, Number(previousRemaining) - spend);
  const nextSpend = Number(account.spendUsd) + spend;
  const alerts: CreditAlert[] = [];
  let isActive = account.isActive;
  let stopProbes = false;

  if (account.creditType === 'recurring_monthly' && total && total > 0 && remaining != null) {
    const usedRatio = (total - remaining) / total;
    const previousUsed =
      previousRemaining == null ? 0 : (total - Number(previousRemaining)) / total;
    if (usedRatio >= 0.8 && previousUsed < 0.8) alerts.push('recurring_80');
  }

  if (account.creditType === 'one_time' && total && total > 0 && remaining != null) {
    const ratio = remaining / total;
    const previousRatio =
      previousRemaining == null ? 1 : Number(previousRemaining) / total;
    if (ratio <= 0.1 && previousRatio > 0.1) alerts.push('one_time_low');
    if (remaining <= 0) {
      remaining = 0;
      isActive = false;
      stopProbes = true;
      alerts.push('one_time_exhausted');
    }
  }

  if (account.creditType === 'one_time' && remaining != null && remaining <= 0 && !alerts.includes('one_time_exhausted')) {
    remaining = 0;
    isActive = false;
    stopProbes = true;
    alerts.push('one_time_exhausted');
  }

  return {
    ...account,
    creditRemainingUsd: remaining,
    spendUsd: nextSpend,
    isActive,
    stopProbes,
    alerts,
    monthsRemaining:
      remaining != null ? monthsRemainingAt30DayBurn(remaining, account.minutesUsed, spend || nextSpend) : null,
  };
}

export function budgetExhausted(spendUsd: number, monthlyBudgetUsd: number | null | undefined) {
  if (monthlyBudgetUsd == null) return false;
  return Number(spendUsd) >= Number(monthlyBudgetUsd);
}
