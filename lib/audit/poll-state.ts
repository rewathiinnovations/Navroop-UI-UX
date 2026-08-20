/**
 * F-819: a background audit that fails must reach the panel that started it.
 *
 * The detached runner records its failure on the AUDIT job row (`failJob`
 * writes `errorMessage`; a mid-scan server restart leaves the job for the
 * reaper to ABANDON). The poll turns the newest such terminal job into a
 * user-visible message — unless a newer scan row superseded the failure, in
 * which case the last run actually worked and there is nothing to report.
 *
 * Pure and shared by `lib/audit/actions.ts` and `lib/seo/actions.ts`; the two
 * flavours are told apart by the job's `currentStep` marker below.
 */

export const CODE_AUDIT_STEP = 'code-audit';
export const SEO_AUDIT_STEP = 'seo-audit';

export const AUDIT_RUN_FALLBACK_ERROR = 'The scan failed. Run it again.';

export type TerminalAuditJob = {
  errorMessage: string | null;
  finishedAt: Date | null;
  createdAt: Date;
};

export function auditRunFailureMessage(
  latestScanAt: Date | null,
  failedJob: TerminalAuditJob | null,
): string | null {
  if (!failedJob) return null;
  const failedAt = failedJob.finishedAt ?? failedJob.createdAt;
  if (latestScanAt && latestScanAt.getTime() >= failedAt.getTime()) return null;
  return failedJob.errorMessage?.trim() || AUDIT_RUN_FALLBACK_ERROR;
}
