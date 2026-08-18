import { monthsRemainingAt30DayBurn } from './credits';
import {
  DRIVER_CAPABILITIES,
  DRIVER_COST_MODELS,
  STRATEGY_HELP,
  credentialFields,
  type CreditType,
  type RoutingStrategy,
  type SandboxDriverId,
} from './provider';
import { decryptProviderSecrets, maskSecrets, type StoredProviderConfig } from './store';

function finiteMonthsRemaining(
  creditType: CreditType,
  remaining: number | null,
  minutesUsed: number,
  spend30: number,
) {
  if (creditType !== 'one_time' || remaining == null) return null;
  const months = monthsRemainingAt30DayBurn(remaining, minutesUsed, spend30);
  return typeof months === 'number' && Number.isFinite(months) ? months : null;
}

export function toPublicProvider(row: StoredProviderConfig) {
  const secrets = decryptProviderSecrets(row.secrets);
  const remaining = row.creditRemainingUsd;
  const spend30 = row.spendUsd;
  return {
    id: row.id,
    name: row.name,
    driver: row.driver,
    isActive: row.isActive,
    priority: row.priority,
    weight: row.weight,
    creditType: row.creditType,
    creditTotalUsd: row.creditTotalUsd,
    creditRemainingUsd: remaining,
    creditResetsAt: row.creditResetsAt?.toISOString() ?? null,
    monthlyBudgetUsd: row.monthlyBudgetUsd,
    monthlyMinutesLimit: row.monthlyMinutesLimit,
    minutesUsed: row.minutesUsed,
    spendUsd: row.spendUsd,
    periodStart: row.periodStart.toISOString(),
    healthStatus: row.healthStatus,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastError: row.lastError,
    consecutiveFails: row.consecutiveFails,
    config: row.config,
    secretsMasked: maskSecrets(row.driver, secrets),
    capabilities: DRIVER_CAPABILITIES[row.driver],
    costModel: DRIVER_COST_MODELS[row.driver],
    monthsRemaining: finiteMonthsRemaining(row.creditType, remaining, row.minutesUsed, spend30),
  };
}

export function capabilityMatrix() {
  return (['e2b', 'modal', 'daytona'] as SandboxDriverId[]).map((driver) => ({
    driver,
    ...DRIVER_CAPABILITIES[driver],
    costModel: DRIVER_COST_MODELS[driver],
    credentials: credentialFields(driver),
  }));
}

export function strategyOptions(current: RoutingStrategy) {
  return (Object.keys(STRATEGY_HELP) as RoutingStrategy[]).map((id) => ({
    id,
    help: STRATEGY_HELP[id],
    selected: id === current,
  }));
}
