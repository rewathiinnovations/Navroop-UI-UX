import { DRIVER_COST_MODELS } from './provider';
import { applyCreditConsumption, estimateRunCostUsd, rollProviderPeriod } from './credits';
import { notifyProviderAlerts } from './alerts';
import { getProviderConfig, updateProviderConfig } from './store';
import { sandboxMinutesBetween } from './minutes';

export async function rollAllProviderPeriods(now = new Date()) {
  const { listProviderConfigs } = await import('./store');
  const rows = await listProviderConfigs();
  for (const row of rows) {
    const rolled = rollProviderPeriod(
      {
        creditType: row.creditType,
        creditTotalUsd: row.creditTotalUsd,
        creditRemainingUsd: row.creditRemainingUsd,
        periodStart: row.periodStart,
        creditResetsAt: row.creditResetsAt,
      },
      now,
    );
    if (!rolled.didRoll) continue;
    await updateProviderConfig(row.id, {
      creditRemainingUsd: rolled.creditRemainingUsd,
      periodStart: rolled.periodStart,
      creditResetsAt: rolled.creditResetsAt,
      minutesUsed: 0,
      spendUsd: 0,
    });
  }
}

export async function accrueProviderUsage(opts: {
  configId: string;
  startedAt: Date;
  endedAt?: Date;
  cpu?: number;
  memoryGiB?: number;
}) {
  const row = await getProviderConfig(opts.configId);
  if (!row) return { minutes: 0, spendUsd: 0 };
  const endedAt = opts.endedAt ?? new Date();
  const minutes = sandboxMinutesBetween(opts.startedAt, endedAt);
  const seconds = Math.max(0, (endedAt.getTime() - opts.startedAt.getTime()) / 1000);
  const spendUsd = estimateRunCostUsd(
    DRIVER_COST_MODELS[row.driver],
    opts.cpu ?? 1,
    opts.memoryGiB ?? 1,
    seconds,
  );
  const next = applyCreditConsumption(
    {
      id: row.id,
      name: row.name,
      creditType: row.creditType,
      creditRemainingUsd: row.creditRemainingUsd,
      creditTotalUsd: row.creditTotalUsd,
      isActive: row.isActive,
      spendUsd: row.spendUsd,
      minutesUsed: row.minutesUsed,
    },
    spendUsd,
  );
  const config = { ...row.config };
  if (next.stopProbes) config.skipProbes = true;
  await updateProviderConfig(row.id, {
    minutesUsed: row.minutesUsed + minutes,
    spendUsd: next.spendUsd,
    creditRemainingUsd: next.creditRemainingUsd,
    isActive: next.isActive,
    config,
  });
  await notifyProviderAlerts(next.alerts, {
    id: row.id,
    name: row.name,
    remainingUsd: next.creditRemainingUsd ?? 0,
    totalUsd: row.creditTotalUsd ?? 0,
    monthsRemaining: next.monthsRemaining,
  });
  return { minutes, spendUsd };
}
