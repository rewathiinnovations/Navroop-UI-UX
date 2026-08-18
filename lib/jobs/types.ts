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
  dnsRecordId?: string | null;
  cloudflareZoneId?: string | null;
  compensation?: 'rolled_back' | 'kept_live' | null;
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
  | 'plan_failed'
  | 'settle_write_failed'
  | 'sandbox_unavailable'
  | 'snapshot_unreadable'
  | 'provider_not_configured'
  | 'provider_quota_exhausted'
  | 'request_rejected'
  | 'import_failed'
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
    dnsRecordId: row.dnsRecordId ?? null,
    cloudflareZoneId: row.cloudflareZoneId ?? null,
    compensation: row.compensation ?? null,
    sandboxAttempts: parseSandboxAttempts(row.sandboxAttempts),
    sandboxSkipped: parseSandboxSkipped(row.sandboxSkipped),
    sandboxProviderConfigId: row.sandboxProviderConfigId ?? null,
    providerAttempts: row.providerAttempts ?? null,
  };
}

export function filesToLastCode(files: PartialFile[]) {
  return files.map((file) => `<file path="${file.path}">\n${file.content}\n</file>`).join('\n');
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
