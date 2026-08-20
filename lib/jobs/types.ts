export type JobKind =
  | 'PLAN'
  | 'BUILD'
  | 'FOLLOWUP'
  | 'IMPORT'
  | 'AUDIT'
  | 'PUBLISH'
  | 'DOMAIN_VERIFY'
  | 'EXPORT'
  | 'TEMPLATE_THUMBNAIL';
export type JobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'ABANDONED' | 'CANCELLED';
export type JobStepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export type JobStep = {
  key: string;
  label: string;
  status: JobStepStatus;
  startedAt?: string | null;
  finishedAt?: string | null;
  error?: string | null;
};

export type SandboxAttemptRecord = {
  configId: string;
  driver: string;
  ok: boolean;
  error?: string;
  at: string;
  selectionReason?: string;
};

export type SandboxSkippedRecord = {
  configId: string;
  name: string;
  reason: string;
};

export type JobResourceIds = {
  githubRepo?: string | null;
  coolifyAppUuid?: string | null;
  /**
   * The deployment Coolify created for this job's `deploy` step — the only handle that
   * distinguishes *this* build from the one already running on the application. The
   * `poll` step verifies against it, so it has to survive a resume.
   */
  coolifyDeploymentUuid?: string | null;
  dnsRecordId?: string | null;
  cloudflareZoneId?: string | null;
  /**
   * How the abandon sweep left this job's resources. `partial` means at least one is still
   * up: the marker is not terminal, so the next sweep retries it (F-046).
   */
  compensation?: 'rolled_back' | 'kept_live' | 'partial' | null;
  sandboxAttempts?: SandboxAttemptRecord[] | null;
  sandboxSkipped?: SandboxSkippedRecord[] | null;
  sandboxProviderConfigId?: string | null;
  providerAttempts?: Array<{
    provider: string;
    model: string;
    ok: boolean;
    error?: string;
    at: string;
  }> | null;
};

export type JobRow = GenerationJobRow;

/**
 * Every code that may be written to `GenerationJob.errorCode`.
 *
 * `CAUSE_LINES` in `./copy` is a `Record<JobErrorCode, string>`, so adding a member
 * here without user-facing copy is a compile error rather than a recovery panel that
 * renders its heading with no explanation.
 */
export type JobErrorCode =
  | 'server_restarted'
  | 'timeout'
  | 'provider_error'
  | 'deploying'
  | 'cancelled'
  | 'admin_abandoned'
  | 'job_cap_exceeded'
  | 'loop_detected'
  | 'queue_timeout'
  | 'client_disconnected'
  | 'no_files_generated'
  | 'tool_call_validation_failed'
  | 'credits_exhausted'
  // Distinct from `credits_exhausted` on purpose: the workspace may still have thousands
  // of credits left and the remedy is an admin raising the member's cap, not buying
  // credits or waiting for the monthly reset. A shared code sent that user to the wrong
  // remedy and suppressed Try-again.
  | 'member_cap_reached'
  // Neither refusal: the debit itself failed to run (Prisma P2028 transaction timeout,
  // connection reset). Both were reported as `credits_exhausted` until this code existed,
  // so a database blip told the user their credits were gone and offered no retry.
  | 'credit_charge_failed'
  | 'plan_failed'
  | 'settle_write_failed'
  | 'sandbox_unavailable'
  | 'snapshot_unreadable'
  | 'provider_not_configured'
  | 'provider_quota_exhausted'
  // The breaker we opened ourselves after repeated failures — the app declined to call the
  // provider, which is neither a vendor outage nor a misconfiguration, and clears on its
  // own. It used to arrive as `provider_error` behind "The AI service did not respond".
  | 'provider_resting'
  | 'request_rejected'
  | 'import_failed'
  // Publish refused to force-push over an existing deploy-org repository whose recorded
  // id does not prove this project created it (F-202). The recorded message names the
  // repo and the way forward, so this code is in `RECORDED_CAUSE_CODES`.
  | 'repo_conflict'
  // The run held the project lock, then a renewal proved it no longer did — expired, or
  // taken by another writer. Distinct from `cancelled`: nobody asked for this stop, and the
  // run refused to write rather than persist under a lock that no longer protected the
  // write (F-730).
  | 'project_lock_lost'
  // Nothing to do with the AI: a bookkeeping job (`withRecordedJob` — EXPORT,
  // DOMAIN_VERIFY, TEMPLATE_THUMBNAIL) whose work threw. Every one of them used to be
  // filed as `provider_error`, so /admin/jobs grouped a storage or DNS outage under the
  // AI provider and pointed the operator at DeepSeek (F-047).
  | 'internal_error'
  // The project row was gone by the time the detached work ran — deleted while its audit
  // sat queued. Both audit twins filed this as `provider_error`, so /admin/jobs blamed the
  // AI provider for a row that no longer exists and sent the operator to DeepSeek (F-821).
  | 'project_deleted'
  | 'stack_mismatch';

export type PartialFile = { path: string; content: string };

export type GenerationJobRow = {
  id: string;
  projectId: string;
  workspaceId: string;
  userId: string;
  kind: JobKind;
  status: JobStatus;
  ownerInstance: string | null;
  heartbeatAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  attempt: number;
  maxAttempts: number;
  inputPrompt: string | null;
  planVersion: number | null;
  partialFiles: PartialFile[] | null;
  filesWritten: number;
  lastStep: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  estimatedCostUsd: number | null;
  provider: string | null;
  model: string | null;
  queuePosition: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  requestId: string | null;
  idempotencyKey: string | null;
  creditsChargedAt: Date | null;
  steps: JobStep[] | null;
  currentStep: string | null;
  resourceIds: JobResourceIds | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicGenerationJob = {
  id: string;
  projectId: string;
  kind: JobKind;
  status: JobStatus;
  ownerInstance: string | null;
  heartbeatAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  attempt: number;
  maxAttempts: number;
  inputPrompt: string | null;
  filesWritten: number;
  lastStep: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  queuePosition: number | null;
  provider: string | null;
  model: string | null;
  requestId: string | null;
  steps: JobStep[] | null;
  currentStep: string | null;
  resourceIds: JobResourceIds | null;
  createdAt: string;
};

export const TERMINAL_JOB_STATUSES: JobStatus[] = ['SUCCEEDED', 'FAILED', 'ABANDONED', 'CANCELLED'];
export const ACTIVE_JOB_STATUSES: JobStatus[] = ['QUEUED', 'RUNNING'];

export function isActiveJobStatus(status: JobStatus) {
  return status === 'QUEUED' || status === 'RUNNING';
}

export function isRecoveryJobStatus(status: JobStatus) {
  return status === 'ABANDONED' || status === 'FAILED';
}

export function toPublicJob(row: GenerationJobRow): PublicGenerationJob {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    status: row.status,
    ownerInstance: row.ownerInstance,
    heartbeatAt: row.heartbeatAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    inputPrompt: row.inputPrompt,
    filesWritten: row.filesWritten,
    lastStep: row.lastStep,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    queuePosition: row.queuePosition,
    provider: row.provider,
    model: row.model,
    requestId: row.requestId,
    steps: row.steps,
    currentStep: row.currentStep,
    resourceIds: row.resourceIds,
    createdAt: row.createdAt.toISOString(),
  };
}

export function isPublishRunning(job: { kind: string; status: string } | null | undefined) {
  return job?.kind === 'PUBLISH' && (job.status === 'QUEUED' || job.status === 'RUNNING');
}

export function isGenerationKind(kind: JobKind) {
  return kind === 'PLAN' || kind === 'BUILD' || kind === 'FOLLOWUP' || kind === 'IMPORT';
}

export function parseJobSteps(value: unknown): JobStep[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is JobStep => {
      return Boolean(
        entry &&
        typeof entry === 'object' &&
        typeof (entry as JobStep).key === 'string' &&
        typeof (entry as JobStep).label === 'string' &&
        typeof (entry as JobStep).status === 'string',
      );
    })
    .map((entry) => ({
      key: entry.key,
      label: entry.label,
      status: entry.status,
      startedAt: entry.startedAt ?? null,
      finishedAt: entry.finishedAt ?? null,
      error: entry.error ?? null,
    }));
}

function parseSandboxAttempts(value: unknown): SandboxAttemptRecord[] | null {
  if (!Array.isArray(value)) return null;
  const rows = value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as SandboxAttemptRecord;
    if (
      typeof row.configId !== 'string' ||
      typeof row.driver !== 'string' ||
      typeof row.at !== 'string'
    ) {
      return [];
    }
    const next: SandboxAttemptRecord = {
      configId: row.configId,
      driver: row.driver,
      ok: Boolean(row.ok),
      at: row.at,
    };
    if (typeof row.error === 'string') next.error = row.error;
    if (typeof row.selectionReason === 'string') next.selectionReason = row.selectionReason;
    return [next];
  });
  return rows.length > 0 ? rows : null;
}

function parseSandboxSkipped(value: unknown): SandboxSkippedRecord[] | null {
  if (!Array.isArray(value)) return null;
  const rows = value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as SandboxSkippedRecord;
    if (
      typeof row.configId !== 'string' ||
      typeof row.name !== 'string' ||
      typeof row.reason !== 'string'
    ) {
      return [];
    }
    return [{ configId: row.configId, name: row.name, reason: row.reason }];
  });
  return rows.length > 0 ? rows : null;
}

export function parseResourceIds(value: unknown): JobResourceIds | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as JobResourceIds;
  return {
    githubRepo: row.githubRepo ?? null,
    coolifyAppUuid: row.coolifyAppUuid ?? null,
    coolifyDeploymentUuid: row.coolifyDeploymentUuid ?? null,
    dnsRecordId: row.dnsRecordId ?? null,
    cloudflareZoneId: row.cloudflareZoneId ?? null,
    compensation: row.compensation ?? null,
    sandboxAttempts: parseSandboxAttempts(row.sandboxAttempts),
    sandboxSkipped: parseSandboxSkipped(row.sandboxSkipped),
    sandboxProviderConfigId: row.sandboxProviderConfigId ?? null,
    providerAttempts: row.providerAttempts ?? null,
  };
}

export function parsePartialFiles(value: unknown): PartialFile[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is PartialFile => {
      return Boolean(
        entry &&
        typeof entry === 'object' &&
        typeof (entry as PartialFile).path === 'string' &&
        typeof (entry as PartialFile).content === 'string',
      );
    })
    .map((entry) => ({ path: entry.path, content: entry.content }));
}
