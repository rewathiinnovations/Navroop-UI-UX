import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import { consumeCredits, CreditLimitError, type CreditAction } from '@/lib/plans/limits';
import { QUEUE_MAX_WAIT_MS } from '@/lib/ai/queue';
import { acquireLock, releaseLock } from '@/lib/projects/lock';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { getInstanceId } from '@/lib/runtime/instance';
import {
  HEARTBEAT_FAILURES_BEFORE_STALE,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
  JOB_TIMEOUT_MS,
} from './poll';
import { resumablePhaseFromEvidence } from './resumable-phase';
import {
  claimJobCreditCharge,
  findJobByIdempotency,
  getActiveJob,
  getJob,
  insertJobRaw,
  listLegacyStuckProjects,
  listReconcileCandidates,
  listTimeoutCandidates,
  releaseJobCreditCharge,
  setProjectActiveJob,
  setProjectResumablePhase,
  updateJobFields,
  updateJobIfActive,
  type JobUpdateFields,
} from './store';
import { compensateAbandonedPublish } from './compensate-publish';
import {
  isGenerationKind,
  type GenerationJobRow,
  type JobErrorCode,
  type JobKind,
  type JobStatus,
} from './types';

export type CreateJobInput = {
  projectId: string;
  workspaceId?: string;
  userId: string;
  kind: JobKind;
  inputPrompt?: string | null;
  planVersion?: number | null;
  idempotencyKey?: string | null;
  requestId?: string | null;
  attempt?: number;
  maxAttempts?: number;
  creditsChargedAt?: Date | null;
};

async function ensureWorkspace(workspaceId: string) {
  await prisma.workspace.upsert({
    where: { id: workspaceId },
    create: { id: workspaceId, storageBytes: 0 },
    update: {},
  });
}

async function applyPhaseForStart(projectId: string, kind: JobKind) {
  if (kind === 'PLAN') {
    await prisma.$executeRaw`
      UPDATE "Project"
      SET phase = 'PLANNING'::"ProjectPhase", "updatedAt" = NOW()
      WHERE id = ${projectId}
    `;
    return;
  }
  if (
    kind === 'AUDIT' ||
    kind === 'PUBLISH' ||
    kind === 'DOMAIN_VERIFY' ||
    kind === 'EXPORT' ||
    kind === 'TEMPLATE_THUMBNAIL'
  ) {
    return;
  }
  await prisma.$executeRaw`
    UPDATE "Project"
    SET phase = 'BUILDING'::"ProjectPhase", "generationStatus" = 'generating', "updatedAt" = NOW()
    WHERE id = ${projectId}
  `;
}

export async function resolveResumablePhase(projectId: string, filesWritten = 0) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { lastCode: true },
  });
  const checkpointCount = await prisma.checkpoint.count({ where: { projectId } });
  const plan = await prisma.projectPlan.findFirst({
    where: { projectId, status: { in: ['PENDING', 'APPROVED'] } },
    select: { id: true },
  });
  return resumablePhaseFromEvidence({
    filesWritten,
    hasLastCode: Boolean(project?.lastCode),
    checkpointCount,
    hasActivePlan: Boolean(plan),
  });
}

export async function createOrReuseJob(input: CreateJobInput): Promise<GenerationJobRow> {
  const workspaceId = input.workspaceId ?? WORKSPACE_ROW_ID;
  await ensureWorkspace(workspaceId);

  if (input.idempotencyKey) {
    const existing = await findJobByIdempotency(input.projectId, input.idempotencyKey);
    if (
      existing &&
      (existing.status === 'QUEUED' ||
        existing.status === 'RUNNING' ||
        existing.status === 'SUCCEEDED')
    ) {
      return existing;
    }
  }

  const active = await getActiveJob(input.projectId);
  if (active) return active;

  try {
    const created = await insertJobRaw({
      projectId: input.projectId,
      workspaceId,
      userId: input.userId,
      kind: input.kind,
      inputPrompt: input.inputPrompt,
      planVersion: input.planVersion,
      idempotencyKey: input.idempotencyKey,
      requestId: input.requestId,
      attempt: input.attempt,
      maxAttempts: input.maxAttempts,
      creditsChargedAt: input.creditsChargedAt,
    });
    await setProjectActiveJob(input.projectId, created.id);
    await applyPhaseForStart(input.projectId, input.kind);
    return created;
  } catch (error) {
    if (isActiveJobUniqueViolation(error)) {
      const existing = await getActiveJob(input.projectId);
      if (existing) return existing;
      throw new Error('A job is already running');
    }
    throw error;
  }
}

function isActiveJobUniqueViolation(error: unknown) {
  const code =
    typeof error === 'object' && error && 'code' in error
      ? String((error as { code?: string }).code)
      : '';
  if (code === 'P2002' || code === '23505') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /one_active_job_per_project|23505/i.test(message);
}

export async function chargeJobCreditsOnce(
  jobId: string,
  input: {
    workspaceId: string;
    userId: string;
    action: CreditAction;
    projectId?: string | null;
  },
) {
  const job = await getJob(jobId);
  if (!job) return { charged: false as const };
  if (job.creditsChargedAt) return { charged: false as const, alreadyCharged: true as const };
  const chargedAt = new Date();
  const claimed = await claimJobCreditCharge(jobId, chargedAt);
  if (!claimed) return { charged: false as const, alreadyCharged: true as const };
  try {
    await consumeCredits(input.workspaceId, input.userId, input.action, input.projectId);
  } catch (error) {
    await releaseJobCreditCharge(jobId, chargedAt);
    throw error;
  }
  return { charged: true as const };
}

/**
 * The job status write is the important part of settling a job. Lock release and
 * publish compensation are best effort — a failure there must not throw past the
 * status write and leave the row in QUEUED/RUNNING forever.
 */
async function releaseLockQuietly(projectId: string, userId: string) {
  try {
    await releaseLock(projectId, userId);
  } catch (error) {
    log.warn('jobs.lock_release_failed', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function compensatePublishQuietly(jobId: string) {
  try {
    await compensateAbandonedPublish(jobId);
  } catch (error) {
    log.error('jobs.publish_compensation_failed', {
      jobId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function creditActionForKind(kind: JobKind): CreditAction {
  if (kind === 'IMPORT') return 'import';
  if (kind === 'AUDIT') return 'audit';
  return 'generation';
}

/**
 * The job error code for a failed credit charge.
 *
 * Three outcomes hide behind one throw out of `consumeCredits`, and they need three
 * different sentences. `credits_exhausted` is in `NO_RETRY_CODES`, so it removes the
 * Try-again button, and its next-step line reads "Add credits, or wait for the monthly
 * reset" — correct only when the workspace really is out.
 *
 * A `member_cap` refusal is not that: the workspace may have thousands of credits left and
 * the remedy is an admin raising one person's cap. Reporting it as `credits_exhausted`
 * replaced the sentence `consumeCredits` raised ("Your personal limit is used up — ask an
 * admin to raise it") with advice to buy credits nobody needed, and suppressed the retry
 * that raising the cap makes valid.
 *
 * And a throw that is not a `CreditLimitError` is not a refusal at all — a Prisma P2028
 * transaction timeout, a dropped connection, or a throw escaping the post-commit 80% alert
 * (see the note at lib/plans/limits.ts:253). Those told the person their credits were used
 * up and offered no way forward for a build that never started.
 */
function creditFailureCode(error: unknown): JobErrorCode {
  if (!(error instanceof CreditLimitError)) return 'credit_charge_failed';
  return error.reason === 'member_cap' ? 'member_cap_reached' : 'credits_exhausted';
}

export async function markJobRunning(
  jobId: string,
  input: {
    ownerInstance?: string;
    chargeCredits?: boolean;
    acquireProjectLock?: boolean;
  } = {},
) {
  const job = await getJob(jobId);
  if (!job) throw new Error('Generation job not found');
  const now = new Date();
  const ownerInstance = input.ownerInstance ?? getInstanceId();
  // Conditional write, the same discipline every terminal transition uses. The caller
  // reads its QUEUED row before waiting for a provider slot, and the reaper is entitled
  // to abandon that row while it waits — so an unguarded UPDATE here flipped an
  // ABANDONED job back to RUNNING and /admin/jobs showed a RUNNING job carrying
  // errorCode 'server_restarted' and a finishedAt. A settled job is finished: throw
  // rather than resurrect it, so the caller stops instead of streaming into a dead row.
  const started = await updateJobIfActive(jobId, {
    status: 'RUNNING',
    ownerInstance,
    startedAt: job.startedAt ?? now,
    heartbeatAt: now,
  });
  if (!started) {
    const current = await getJob(jobId);
    log.info('jobs.start_write_lost_race', {
      jobId,
      projectId: job.projectId,
      attempted: 'RUNNING',
      currentStatus: current?.status ?? null,
    });
    throw new Error('This build was already settled and cannot be restarted');
  }
  await setProjectActiveJob(job.projectId, job.id);
  await applyPhaseForStart(job.projectId, job.kind);
  if (input.acquireProjectLock !== false) {
    await acquireLock(
      job.projectId,
      job.userId,
      job.kind === 'IMPORT'
        ? 'import'
        : job.kind === 'AUDIT'
          ? 'audit'
          : job.kind === 'PUBLISH'
            ? 'publish'
            : 'generation',
    );
  }
  if (input.chargeCredits) {
    try {
      await chargeJobCreditsOnce(jobId, {
        workspaceId: job.workspaceId,
        userId: job.userId,
        action: creditActionForKind(job.kind),
        projectId: job.projectId,
      });
    } catch (error) {
      // The job is already RUNNING and the lock is already held. Settle both here,
      // otherwise the project stays locked until the reaper notices. The recorded message
      // is the one the debit raised: `member_cap_reached` is in `RECORDED_CAUSE_CODES`, so
      // that sentence is what the person reads instead of a generic cause line.
      await failJob(jobId, {
        errorCode: creditFailureCode(error),
        errorMessage: error instanceof Error ? error.message : 'Credits could not be charged',
      });
      throw error;
    }
  }
  return getJob(jobId);
}

export type JobHeartbeatOptions = {
  intervalMs?: number;
  /**
   * Stops the heartbeat when the request that owns the work is torn down.
   *
   * A heartbeat only means "this job is alive" if something is still working. When a
   * caller is parked on a write to a disconnected client, its `finally` never runs, so
   * `stop()` is never called and the timer keeps `heartbeatAt` fresh — which makes the
   * job permanently invisible to the staleness reaper and leaves it RUNNING until the
   * 20-minute hard timeout, with the workspace chat input locked the whole time. Pass
   * `request.signal` and the timer goes quiet the moment the client is gone, so the
   * reaper abandons the job within a minute instead.
   */
  signal?: AbortSignal;
};

export function beginJobHeartbeat(jobId: string, options: number | JobHeartbeatOptions = {}) {
  const { intervalMs = HEARTBEAT_INTERVAL_MS, signal } =
    typeof options === 'number' ? { intervalMs: options } : options;

  // Catching the write keeps a heartbeat failure from becoming an unhandled rejection,
  // but a warn-per-tick is how a broken heartbeat hid for a whole session: the reaper
  // abandons a job that is still working once heartbeatAt stops advancing, and nobody
  // reads 74 identical warnings. So: warn on the first failure, escalate to error at the
  // tick where staleness actually starts, then stay quiet until a write succeeds again.
  let consecutiveFailures = 0;
  let stopped = false;
  const timer = setInterval(() => {
    updateJobFields(jobId, { heartbeatAt: new Date() })
      .then((job) => {
        consecutiveFailures = 0;
        // A settled or deleted job has no work to vouch for. Something else finished it —
        // the reaper, an admin, or a sibling path — so keep beating and the row looks
        // alive to every consumer that reads heartbeatAt.
        if (!job || (job.status !== 'QUEUED' && job.status !== 'RUNNING')) {
          stop();
        }
      })
      .catch((error) => {
        consecutiveFailures += 1;
        const detail = {
          jobId,
          consecutiveFailures,
          error: error instanceof Error ? error.message : String(error),
        };
        if (consecutiveFailures === HEARTBEAT_FAILURES_BEFORE_STALE) {
          log.error('jobs.heartbeat_stalled', detail);
        } else if (consecutiveFailures < HEARTBEAT_FAILURES_BEFORE_STALE) {
          log.warn('jobs.heartbeat_failed', detail);
        }
      });
  }, intervalMs);
  timer.unref?.();

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  function onAbort() {
    // Keep beating. The request aborting means the person navigated away, not
    // that the work stopped — the generation keeps streaming server-side and
    // its files are still being persisted. Stopping here made a job that was
    // very much alive look stale within 90 seconds: the client watchdog called
    // it failed, the reaper was entitled to abandon it, and the workspace sat
    // on "Building your project…" with a frozen heartbeat behind it. The
    // interval clears when the work actually settles.
    log.warn('jobs.heartbeat_client_gone', { jobId, reason: 'client_disconnected' });
  }

  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  return { stop };
}

export type TerminalWriteOptions = {
  /**
   * Runs after the pre-write read, before the status UPDATE.
   * Tests use this to win the other side of a settle race.
   */
  beforeWrite?: () => Promise<void>;
};

async function runBeforeTerminalWrite(options?: TerminalWriteOptions) {
  if (options?.beforeWrite) await options.beforeWrite();
}

export type JobWriteResult = {
  job: GenerationJobRow | null;
  /** True only when this call's UPDATE matched a QUEUED/RUNNING row. */
  wrote: boolean;
};

/**
 * Conditional UPDATE. Zero rows is a normal race — log it, return null, do not
 * run side effects (phase, lock, publish compensation). Returning the current
 * row here used to make a lost abandon look like a win whenever the winner
 * also left the row ABANDONED (boot reconcile racing the cron, or a parallel
 * test reaper), which re-ran publish compensation on a job that already settled.
 */
async function commitActiveJob(
  jobId: string,
  fields: JobUpdateFields,
  attempted: JobStatus,
): Promise<GenerationJobRow | null> {
  const updated = await updateJobIfActive(jobId, fields);
  if (updated) return updated;
  const current = await getJob(jobId);
  log.info('jobs.terminal_write_lost_race', {
    jobId,
    projectId: current?.projectId ?? null,
    attempted,
    currentStatus: current?.status ?? null,
  });
  return null;
}

export async function abandonActiveJob(
  jobId: string,
  input: { errorCode: string; errorMessage?: string | null },
  options?: TerminalWriteOptions,
): Promise<JobWriteResult> {
  const job = await getJob(jobId);
  if (!job) return { job: null, wrote: false };
  if (job.status !== 'QUEUED' && job.status !== 'RUNNING') return { job, wrote: false };
  await runBeforeTerminalWrite(options);
  const settled = await commitActiveJob(
    jobId,
    {
      status: 'ABANDONED',
      finishedAt: new Date(),
      errorCode: input.errorCode,
      errorMessage: input.errorMessage ?? null,
    },
    'ABANDONED',
  );
  if (!settled) return { job: await getJob(jobId), wrote: false };
  if (isGenerationKind(job.kind)) {
    const phase = await resolveResumablePhase(job.projectId, job.filesWritten);
    await setProjectResumablePhase(job.projectId, phase, 'idle');
  } else {
    await setProjectActiveJob(job.projectId, null);
  }
  await releaseLockQuietly(job.projectId, job.userId);
  if (job.kind === 'PUBLISH') {
    await compensatePublishQuietly(job.id);
  }
  log.warn('jobs.abandoned', {
    projectId: job.projectId,
    jobId: job.id,
    errorCode: input.errorCode,
    filesWritten: job.filesWritten,
    lastStep: job.lastStep,
  });
  return { job: settled, wrote: true };
}

export async function abandonJob(
  jobId: string,
  input: { errorCode: string; errorMessage?: string | null },
  options?: TerminalWriteOptions,
) {
  return (await abandonActiveJob(jobId, input, options)).job;
}

export async function failJob(
  jobId: string,
  input: {
    errorCode?: string;
    errorMessage?: string | null;
    tokensIn?: number;
    tokensOut?: number;
    estimatedCostUsd?: number | null;
    provider?: string | null;
    model?: string | null;
  },
  options?: TerminalWriteOptions,
) {
  const job = await getJob(jobId);
  if (!job) return null;
  // Only an active job settles, matching abandonJob. Without this a cleanup path could
  // flip an already-SUCCEEDED job to FAILED, which is what stopped callers from settling
  // in a `finally` — the one place that actually runs when the work is torn down.
  if (job.status !== 'QUEUED' && job.status !== 'RUNNING') return job;
  await runBeforeTerminalWrite(options);
  const settled = await commitActiveJob(
    jobId,
    {
      status: 'FAILED',
      finishedAt: new Date(),
      errorCode: input.errorCode ?? 'provider_error',
      errorMessage: input.errorMessage ?? null,
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      estimatedCostUsd: input.estimatedCostUsd,
      provider: input.provider,
      model: input.model,
    },
    'FAILED',
  );
  if (!settled) return getJob(jobId);
  if (isGenerationKind(job.kind)) {
    const phase = await resolveResumablePhase(job.projectId, job.filesWritten);
    await setProjectResumablePhase(job.projectId, phase, 'error');
  } else {
    await setProjectActiveJob(job.projectId, null);
  }
  await releaseLockQuietly(job.projectId, job.userId);
  if (job.kind === 'PUBLISH') {
    await compensatePublishQuietly(job.id);
  }
  return settled;
}

export async function succeedJob(
  jobId: string,
  input: {
    lastStep?: string | null;
    tokensIn?: number;
    tokensOut?: number;
    estimatedCostUsd?: number | null;
    provider?: string | null;
    model?: string | null;
  } = {},
  options?: TerminalWriteOptions,
) {
  const job = await getJob(jobId);
  if (!job) return null;
  if (job.status !== 'QUEUED' && job.status !== 'RUNNING') return job;
  await runBeforeTerminalWrite(options);
  const settled = await commitActiveJob(
    jobId,
    {
      status: 'SUCCEEDED',
      finishedAt: new Date(),
      lastStep: input.lastStep ?? job.lastStep,
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      estimatedCostUsd: input.estimatedCostUsd,
      provider: input.provider,
      model: input.model,
    },
    'SUCCEEDED',
  );
  if (!settled) return getJob(jobId);
  if (job.kind === 'PLAN') {
    await prisma.$executeRaw`
      UPDATE "Project"
      SET
        phase = 'PLANNING'::"ProjectPhase",
        "generationStatus" = 'idle',
        "activeJobId" = NULL,
        "updatedAt" = NOW()
      WHERE id = ${job.projectId}
    `;
  } else if (
    job.kind === 'AUDIT' ||
    job.kind === 'PUBLISH' ||
    job.kind === 'DOMAIN_VERIFY' ||
    job.kind === 'EXPORT' ||
    job.kind === 'TEMPLATE_THUMBNAIL'
  ) {
    await setProjectActiveJob(job.projectId, null);
  } else {
    const phase = await resolveResumablePhase(job.projectId);
    await setProjectResumablePhase(job.projectId, phase, phase === 'COMPLETE' ? 'ready' : 'idle');
  }
  await releaseLockQuietly(job.projectId, job.userId);
  return settled;
}

export async function cancelJob(jobId: string, message = 'Start over') {
  const job = await getJob(jobId);
  if (!job) return null;
  if (job.status !== 'QUEUED' && job.status !== 'RUNNING') return job;
  const settled = await commitActiveJob(
    jobId,
    {
      status: 'CANCELLED',
      finishedAt: new Date(),
      errorCode: 'cancelled',
      errorMessage: message,
    },
    'CANCELLED',
  );
  if (!settled) return getJob(jobId);
  if (isGenerationKind(job.kind)) {
    const phase = await resolveResumablePhase(job.projectId, job.filesWritten);
    await setProjectResumablePhase(job.projectId, phase, 'idle');
  } else {
    await setProjectActiveJob(job.projectId, null);
  }
  await releaseLockQuietly(job.projectId, job.userId);
  if (job.kind === 'PUBLISH') {
    // No caller can reach this with a PUBLISH job today: `cancelJob`'s only caller is
    // `startOverJob`, and `resolveRecoveryTarget` gates that on `showsChatRecovery`, which
    // admits PLAN/BUILD/FOLLOWUP/IMPORT only. Kept as the same branch `abandonActiveJob`
    // and `failJob` carry, so a future cancel-publish affordance cannot leak a half-created
    // Coolify app, DNS record and GitHub repo with nothing pointing at them.
    // compensateAbandonedPublish is single-shot via resourceIds.compensation.
    await compensatePublishQuietly(job.id);
  }
  return settled;
}

export type ReconcileOptions = {
  now?: Date;
  timeoutMs?: number;
  /** Reaper window for RUNNING rows, measured against heartbeatAt. */
  staleMs?: number;
  /**
   * Reaper window for QUEUED rows of the kinds that wait in the provider queue. A queued
   * build has no heartbeat until it starts, so it is measured from createdAt and has to
   * outlast the provider queue wait. Defaults to QUEUE_MAX_WAIT_MS plus the heartbeat
   * window. Only the kinds in QUEUE_WAITING_JOB_KINDS (see ./store) get it; every other
   * kind is judged by `staleMs`, because nothing parks it in the queue.
   */
  queuedStaleMs?: number;
  /** After the active-status read, before the abandon write. Tests only. */
  beforeAbandon?: () => Promise<void>;
  /**
   * Tests: only abandon these projects. Production cron omits this so the
   * whole table is scanned. A scoped reaper cannot steal another suite's
   * stale GenerationJob row.
   */
  projectIds?: readonly string[];
};

function matchesReconcileProject(projectId: string, projectIds?: readonly string[]) {
  return !projectIds || projectIds.includes(projectId);
}

export async function reconcileAbandonedJobs(options: ReconcileOptions = {}) {
  const now = options.now ?? new Date();
  const staleMs = options.staleMs ?? HEARTBEAT_STALE_MS;
  const queuedStaleMs = options.queuedStaleMs ?? QUEUE_MAX_WAIT_MS + staleMs;
  const timeoutMs = options.timeoutMs ?? JOB_TIMEOUT_MS;
  const staleBefore = new Date(now.getTime() - staleMs);
  const queuedStaleBefore = new Date(now.getTime() - queuedStaleMs);
  const timeoutBefore = new Date(now.getTime() - timeoutMs);

  const abandoned: Array<{
    jobId: string;
    projectId: string;
    errorCode: string;
    filesWritten: number;
    lastStep: string | null;
  }> = [];
  const seen = new Set<string>();

  const timeoutJobs = await listTimeoutCandidates(timeoutBefore);
  for (const job of timeoutJobs) {
    if (seen.has(job.id)) continue;
    if (!matchesReconcileProject(job.projectId, options.projectIds)) continue;
    seen.add(job.id);
    const { wrote } = await abandonActiveJob(
      job.id,
      {
        errorCode: 'timeout',
        errorMessage: 'The build ran too long',
      },
      { beforeWrite: options.beforeAbandon },
    );
    if (!wrote) continue;
    abandoned.push({
      jobId: job.id,
      projectId: job.projectId,
      errorCode: 'timeout',
      filesWritten: job.filesWritten,
      lastStep: job.lastStep,
    });
  }

  // No owner fencing: a stale heartbeat *is* the ownership test. A live instance rewrites
  // heartbeatAt every HEARTBEAT_INTERVAL_MS, so its in-flight rows never become
  // candidates and a rolling deploy cannot reap the surviving replica's work; a row whose
  // heartbeat stopped is unowned whichever instance last held it. Skipping rows by
  // ownerInstance would also break the only path that recovers a crashed instance's jobs:
  // getInstanceId() is per-process, so the dead instance's id matches nobody, and the two
  // `ownerInstance === currentInstance` guards that used to sit in this loop could never
  // fire anyway — every candidate has a stale or NULL heartbeat by the query's own WHERE.
  const staleJobs = await listReconcileCandidates(staleBefore, queuedStaleBefore);
  for (const job of staleJobs) {
    if (seen.has(job.id)) continue;
    if (!matchesReconcileProject(job.projectId, options.projectIds)) continue;
    seen.add(job.id);
    const { wrote } = await abandonActiveJob(
      job.id,
      {
        errorCode: 'server_restarted',
        errorMessage: 'The server restarted',
      },
      { beforeWrite: options.beforeAbandon },
    );
    if (!wrote) continue;
    abandoned.push({
      jobId: job.id,
      projectId: job.projectId,
      errorCode: 'server_restarted',
      filesWritten: job.filesWritten,
      lastStep: job.lastStep,
    });
  }

  const legacy = await listLegacyStuckProjects();
  const legacyProjects: string[] = [];
  for (const project of legacy) {
    if (!matchesReconcileProject(project.id, options.projectIds)) continue;
    const phase = await resolveResumablePhase(project.id, 0);
    await setProjectResumablePhase(project.id, phase, 'idle');
    if (project.lockedById) {
      await releaseLockQuietly(project.id, project.lockedById);
    }
    log.warn('jobs.legacy_stuck_unstuck', {
      projectId: project.id,
      filesWritten: 0,
      lastStep: null,
    });
    legacyProjects.push(project.id);
  }

  return { abandoned, legacyProjects };
}

export async function abandonInstanceJobs(
  errorCode: 'deploying' | 'server_restarted',
  ownerInstance = getInstanceId(),
) {
  const jobs = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "GenerationJob"
    WHERE status IN ('QUEUED', 'RUNNING')
      AND "ownerInstance" = ${ownerInstance}
  `;
  let abandoned = 0;
  for (const row of jobs) {
    const { wrote } = await abandonActiveJob(row.id, {
      errorCode,
      errorMessage: errorCode === 'deploying' ? 'The server is deploying' : 'The server restarted',
    });
    if (wrote) abandoned += 1;
  }
  return abandoned;
}
