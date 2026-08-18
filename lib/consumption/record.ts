import { updateJobFields } from '@/lib/jobs/store';
import { log } from '@/lib/logger';
import { accrueSpend } from '@/lib/plans/spend';
import { estimateTokenCostUsd } from './cost';

export async function recordJobUsage(input: {
  jobId: string;
  workspaceId: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
  provider?: string | null;
  model?: string | null;
}) {
  const estimatedCostUsd = estimateTokenCostUsd({
    tokensIn: input.tokensIn,
    tokensOut: input.tokensOut,
    provider: input.provider,
    model: input.model,
  });
  await updateJobFields(input.jobId, {
    tokensIn: input.tokensIn ?? null,
    tokensOut: input.tokensOut ?? null,
    estimatedCostUsd,
    provider: input.provider ?? null,
    model: input.model ?? null,
  });
  if (estimatedCostUsd > 0) {
    // Spend accrual drives the auto-pause ceiling — a silent miss means the
    // workspace keeps spending past its limit, so this has to be visible.
    await accrueSpend(input.workspaceId, estimatedCostUsd).catch((error) => {
      log.error('consumption.spend_accrual_failed', {
        jobId: input.jobId,
        workspaceId: input.workspaceId,
        estimatedCostUsd,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return estimatedCostUsd;
}
