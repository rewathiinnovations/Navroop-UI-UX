import { nanoid } from 'nanoid';
import { prisma } from '@/lib/db';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import {
  parseJobSteps,
  parsePartialFiles,
  parseResourceIds,
  type GenerationJobRow,
  type JobKind,
  type JobResourceIds,
  type JobStatus,
  type JobStep,
  type PartialFile,
} from './types';

type JobSqlRow = {
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
  partialFiles: unknown;
  filesWritten: number;
  lastStep: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  estimatedCostUsd: unknown;
  provider: string | null;
  model: string | null;
  queuePosition: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  requestId: string | null;
  idempotencyKey: string | null;
  creditsChargedAt: Date | null;
  steps: unknown;
  currentStep: string | null;
  resourceIds: unknown;
  createdAt: Date;
  updatedAt: Date;
};

function mapJob(row: JobSqlRow): GenerationJobRow {
  return {
    ...row,
    estimatedCostUsd: row.estimatedCostUsd == null ? null : Number(row.estimatedCostUsd),
    provider: row.provider ?? null,
    model: row.model ?? null,
    queuePosition: row.queuePosition ?? null,
    partialFiles: parsePartialFiles(row.partialFiles),
    steps: parseJobSteps(row.steps),
    currentStep: row.currentStep ?? null,
    resourceIds: parseResourceIds(row.resourceIds),
  };
}

/**
 * Plain SQL text, spliced into the statement — never handed to Prisma as a value.
 *
 * This was `Prisma.raw(...)` interpolated into a `$queryRaw` tagged template. Prisma's
 * tagged-template path treats every interpolation as a bind parameter and only flattens
 * a nested fragment when the fragment's `Sql` class is the same one the client's runtime
 * holds. Under plain Node that identity matches, so tests passed; inside the bundled
 * Next server it does not, and the column list collapsed to a single placeholder —
 * `SELECT $1 FROM "GenerationJob"` — which Postgres rejects with 42601. Building the
 * text ourselves and binding values positionally removes the identity dependency
 * altogether. Every value below is still a parameter; only fixed column names are text.
 */
const JOB_COLUMNS = `
  id, "projectId", "workspaceId", "userId", kind, status,
  "ownerInstance", "heartbeatAt", "startedAt", "finishedAt",
  attempt, "maxAttempts", "inputPrompt", "planVersion", "partialFiles",
  "filesWritten", "lastStep", "tokensIn", "tokensOut",
  "estimatedCostUsd", provider, model, "queuePosition",
  "errorCode", "errorMessage", "requestId", "idempotencyKey",
  "creditsChargedAt", steps, "currentStep", "resourceIds",
  "createdAt", "updatedAt"
`;

function selectJobs(where: string, ...values: unknown[]) {
  return prisma.$queryRawUnsafe<JobSqlRow[]>(
    `SELECT ${JOB_COLUMNS} FROM "GenerationJob" ${where}`,
    ...values,
  );
}

export async function getJob(id: string): Promise<GenerationJobRow | null> {
  const rows = await selectJobs('WHERE id = $1 LIMIT 1', id);
  return rows[0] ? mapJob(rows[0]) : null;
}

export async function getActiveJob(projectId: string): Promise<GenerationJobRow | null> {
  const rows = await selectJobs(
    `WHERE "projectId" = $1
       AND status IN ('QUEUED', 'RUNNING')
     ORDER BY "createdAt" DESC
     LIMIT 1`,
    projectId,
  );
  return rows[0] ? mapJob(rows[0]) : null;
}

export async function getLatestJobByKind(projectId: string, kind: JobKind): Promise<GenerationJobRow | null> {
  const rows = await selectJobs(
    `WHERE "projectId" = $1
       AND kind = $2::"JobKind"
     ORDER BY "createdAt" DESC
     LIMIT 1`,
    projectId,
    kind,
  );
  return rows[0] ? mapJob(rows[0]) : null;
}

export async function getLatestJob(projectId: string): Promise<GenerationJobRow | null> {
  const rows = await selectJobs(
    `WHERE "projectId" = $1
     ORDER BY "createdAt" DESC
     LIMIT 1`,
    projectId,
  );
  return rows[0] ? mapJob(rows[0]) : null;
}

export async function findJobByIdempotency(
  projectId: string,
  idempotencyKey: string,
): Promise<GenerationJobRow | null> {
  const rows = await selectJobs(
    `WHERE "projectId" = $1
       AND "idempotencyKey" = $2
     ORDER BY "createdAt" DESC
     LIMIT 1`,
    projectId,
    idempotencyKey,
  );
  return rows[0] ? mapJob(rows[0]) : null;
}

export async function listActiveJobs(): Promise<GenerationJobRow[]> {
  const rows = await selectJobs(
    `WHERE status IN ('QUEUED', 'RUNNING')
     ORDER BY "createdAt" DESC`,
  );
  return rows.map(mapJob);
}

export async function listRecentTerminalJobs(since: Date): Promise<GenerationJobRow[]> {
  const rows = await selectJobs(
    `WHERE status IN ('ABANDONED', 'FAILED')
       AND "createdAt" >= $1
     ORDER BY "createdAt" DESC`,
    since,
  );
  return rows.map(mapJob);
}

export async function listAbandonmentCounts(since: Date) {
  return prisma.$queryRaw<Array<{ day: Date; count: bigint }>>`
    SELECT date_trunc('day', "finishedAt") AS day, COUNT(*)::bigint AS count
    FROM "GenerationJob"
    WHERE status = 'ABANDONED'
      AND "finishedAt" >= ${since}
    GROUP BY 1
    ORDER BY 1 DESC
  `;
}

export async function insertJobRaw(input: {
  id?: string;
  projectId: string;
  workspaceId?: string;
  userId: string;
  kind: JobKind;
  status?: JobStatus;
  inputPrompt?: string | null;
  planVersion?: number | null;
  idempotencyKey?: string | null;
  requestId?: string | null;
  attempt?: number;
  maxAttempts?: number;
  creditsChargedAt?: Date | null;
}): Promise<GenerationJobRow> {
  const id = input.id ?? nanoid();
  const workspaceId = input.workspaceId ?? WORKSPACE_ROW_ID;
  const status = input.status ?? 'QUEUED';
  await prisma.$executeRaw`
    INSERT INTO "GenerationJob" (
      id, "projectId", "workspaceId", "userId", kind, status,
      attempt, "maxAttempts", "inputPrompt", "planVersion",
      "idempotencyKey", "requestId", "creditsChargedAt",
      "filesWritten", "createdAt", "updatedAt"
    ) VALUES (
      ${id}, ${input.projectId}, ${workspaceId}, ${input.userId},
      ${input.kind}::"JobKind", ${status}::"JobStatus",
      ${input.attempt ?? 1}, ${input.maxAttempts ?? 2},
      ${input.inputPrompt ?? null}, ${input.planVersion ?? null},
      ${input.idempotencyKey ?? null}, ${input.requestId ?? null},
      ${input.creditsChargedAt ?? null},
      0, NOW(), NOW()
    )
  `;
  const created = await getJob(id);
  if (!created) throw new Error('Failed to create generation job');
  return created;
}

export async function setProjectActiveJob(projectId: string, jobId: string | null) {
  await prisma.$executeRaw`
    UPDATE "Project"
    SET "activeJobId" = ${jobId}, "updatedAt" = NOW()
    WHERE id = ${projectId}
  `;
}

export type JobUpdateFields = {
  status?: JobStatus;
  ownerInstance?: string | null;
  heartbeatAt?: Date | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  attempt?: number;
  partialFiles?: PartialFile[] | null;
  filesWritten?: number;
  lastStep?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  estimatedCostUsd?: number | null;
  provider?: string | null;
  model?: string | null;
  queuePosition?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  creditsChargedAt?: Date | null;
  steps?: JobStep[] | null;
  currentStep?: string | null;
  resourceIds?: JobResourceIds | null;
};

export async function updateJobFields(id: string, fields: JobUpdateFields) {
  const { sql, values } = buildJobUpdate(id, fields);
  await prisma.$executeRawUnsafe(sql, ...values);
  return getJob(id);
}

/**
 * The `SET` clause and its bind parameters, numbered by hand.
 *
 * Exported so a test can assert the SQL text directly. The heartbeat is the hottest
 * caller — `beginJobHeartbeat` writes `heartbeatAt` every 10s — so a malformed clause
 * here stops `heartbeatAt` advancing and the reaper abandons live jobs at 60s.
 */
export function buildJobUpdate(
  id: string,
  fields: JobUpdateFields,
  options?: { activeOnly?: boolean },
) {
  const sets: string[] = ['"updatedAt" = NOW()'];
  const values: unknown[] = [];
  // Column name and cast are fixed text from this file; the value is always a parameter.
  const set = (column: string, value: unknown, cast = '') => {
    values.push(value);
    sets.push(`${column} = $${values.length}${cast}`);
  };

  if (fields.status !== undefined) set('status', fields.status, '::"JobStatus"');
  if (fields.ownerInstance !== undefined) set('"ownerInstance"', fields.ownerInstance);
  if (fields.heartbeatAt !== undefined) set('"heartbeatAt"', fields.heartbeatAt);
  if (fields.startedAt !== undefined) set('"startedAt"', fields.startedAt);
  if (fields.finishedAt !== undefined) set('"finishedAt"', fields.finishedAt);
  if (fields.attempt !== undefined) set('attempt', fields.attempt);
  if (fields.partialFiles !== undefined) {
    set('"partialFiles"', JSON.stringify(fields.partialFiles), '::jsonb');
  }
  if (fields.filesWritten !== undefined) set('"filesWritten"', fields.filesWritten);
  if (fields.lastStep !== undefined) set('"lastStep"', fields.lastStep);
  if (fields.tokensIn !== undefined) set('"tokensIn"', fields.tokensIn);
  if (fields.tokensOut !== undefined) set('"tokensOut"', fields.tokensOut);
  if (fields.estimatedCostUsd !== undefined) set('"estimatedCostUsd"', fields.estimatedCostUsd);
  if (fields.provider !== undefined) set('provider', fields.provider);
  if (fields.model !== undefined) set('model', fields.model);
  if (fields.queuePosition !== undefined) set('"queuePosition"', fields.queuePosition);
  if (fields.errorCode !== undefined) set('"errorCode"', fields.errorCode);
  if (fields.errorMessage !== undefined) set('"errorMessage"', fields.errorMessage);
  if (fields.creditsChargedAt !== undefined) set('"creditsChargedAt"', fields.creditsChargedAt);
  if (fields.steps !== undefined) set('steps', JSON.stringify(fields.steps), '::jsonb');
  if (fields.currentStep !== undefined) set('"currentStep"', fields.currentStep);
  if (fields.resourceIds !== undefined) {
    set('"resourceIds"', JSON.stringify(fields.resourceIds), '::jsonb');
  }

  values.push(id);
  // Status names are source literals, never parameters — same rule as JOB_COLUMNS.
  const activeGuard = options?.activeOnly ? ` AND status IN ('QUEUED', 'RUNNING')` : '';
  return {
    sql: `UPDATE "GenerationJob" SET ${sets.join(', ')} WHERE id = $${values.length}${activeGuard}`,
    values,
  };
}

/**
 * Terminal settle: the QUEUED/RUNNING guard is the same statement as the write.
 * Zero rows means another writer already settled — a genuine no-op, not a clobber.
 */
export async function updateJobIfActive(id: string, fields: JobUpdateFields) {
  const { sql, values } = buildJobUpdate(id, fields, { activeOnly: true });
  const count = await prisma.$executeRawUnsafe(sql, ...values);
  // Prisma types this as number; treat 0 / 0n / empty as a lost write.
  if (Number(count) === 0) return null;
  return getJob(id);
}

/**
 * Stamp `creditsChargedAt` only if it is still NULL. Two replicas racing to start
 * the same job both see `creditsChargedAt: null` in a plain read, so the stamp has
 * to be the same statement as the condition.
 */
export async function claimJobCreditCharge(id: string, at: Date): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "GenerationJob"
    SET "creditsChargedAt" = ${at}, "updatedAt" = NOW()
    WHERE id = ${id}
      AND "creditsChargedAt" IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}

/** Undo a claim whose ledger write failed, so the job is not left marked as charged. */
export async function releaseJobCreditCharge(id: string, at: Date): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "GenerationJob"
    SET "creditsChargedAt" = NULL, "updatedAt" = NOW()
    WHERE id = ${id}
      AND "creditsChargedAt" = ${at}
  `;
}

export async function listReconcileCandidates(staleBefore: Date) {
  // heartbeatAt is NULL until markJobRunning. NULL is not stale — use createdAt.
  const rows = await selectJobs(
    `WHERE status IN ('QUEUED', 'RUNNING')
       AND COALESCE("heartbeatAt", "createdAt") < $1`,
    staleBefore,
  );
  return rows.map(mapJob);
}

export async function listTimeoutCandidates(startedBefore: Date) {
  const rows = await selectJobs(
    `WHERE status = 'RUNNING'
       AND "startedAt" IS NOT NULL
       AND "startedAt" < $1`,
    startedBefore,
  );
  return rows.map(mapJob);
}

export async function listLegacyStuckProjects() {
  return prisma.$queryRaw<
    Array<{
      id: string;
      phase: string;
      generationStatus: string;
      lastCode: string | null;
      ownerId: string;
      lockedById: string | null;
    }>
  >`
    SELECT p.id, p.phase::text AS phase, p."generationStatus", p."lastCode", p."ownerId", p."lockedById"
    FROM "Project" p
    WHERE p."deletedAt" IS NULL
      AND p.phase = 'BUILDING'
      AND p."generationStatus" IN ('idle', 'error', 'ready')
      AND NOT EXISTS (
        SELECT 1 FROM "GenerationJob" j
        WHERE j."projectId" = p.id
          AND j.status IN ('QUEUED', 'RUNNING')
      )
  `;
}

export async function setProjectResumablePhase(
  projectId: string,
  phase: 'PLANNING' | 'COMPLETE',
  generationStatus = 'idle',
) {
  await prisma.$executeRaw`
    UPDATE "Project"
    SET
      phase = ${phase}::"ProjectPhase",
      "generationStatus" = ${generationStatus},
      "activeJobId" = NULL,
      "updatedAt" = NOW()
    WHERE id = ${projectId}
  `;
}
