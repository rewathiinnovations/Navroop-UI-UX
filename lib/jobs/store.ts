import { nanoid } from 'nanoid';
import { prisma } from '@/lib/db';
import { getInstanceId } from '@/lib/runtime/instance';
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

export async function getLatestJobByKind(
  projectId: string,
  kind: JobKind,
): Promise<GenerationJobRow | null> {
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

/**
 * The newest job on a project among a set of kinds — one statement, whatever the set size.
 *
 * The kind test has to be *inside* the lookup. `getLatestJob` picks the newest row of any
 * kind and a filter applied to its result filters a row that has already been chosen, which
 * is how a settled AUDIT row (the auto quality scans file one after every successful build,
 * back-dated to the scan's `startedAt`) started answering for the chat surface.
 *
 * Fanning `getLatestJobByKind` out over the set answers the same question and was what
 * `getLatestChatJob` did, but at one round trip per kind — four, on the endpoint the
 * workspace polls every 2s per viewer, where a single extra `project.findFirst` had already
 * been measured as a third to a half of the request's database work (F-643). `ANY($2)` over
 * `kind::text` is the same shape `findRecentlySucceededBuild` uses, and it costs one.
 */
export async function getLatestJobOfKinds(
  projectId: string,
  kinds: readonly JobKind[],
): Promise<GenerationJobRow | null> {
  const rows = await selectJobs(
    `WHERE "projectId" = $1
       AND kind::text = ANY($2::text[])
     ORDER BY "createdAt" DESC
     LIMIT 1`,
    projectId,
    [...kinds],
  );
  return rows[0] ? mapJob(rows[0]) : null;
}

/**
 * Chat jobs for a project, oldest first — the workspace hydrate path, not the 2s poll.
 *
 * `GET /api/projects/[id]/job?history=1` is the only caller. The poll stays on
 * `getActiveJob` / `getLatestJobOfKinds` and must not start shipping this list.
 */
export async function listChatJobs(
  projectId: string,
  kinds: readonly JobKind[],
  limit = 40,
): Promise<GenerationJobRow[]> {
  const rows = await selectJobs(
    `WHERE "projectId" = $1
       AND kind::text = ANY($2::text[])
     ORDER BY "createdAt" ASC
     LIMIT $3`,
    projectId,
    [...kinds],
    limit,
  );
  return rows.map(mapJob);
}

/**
 * The live job on a project, but only if it is one of these kinds.
 *
 * WIRED TO NOTHING. This has no production caller — only
 * `tests/unit/job-store-claims-and-lookups.test.ts` names it, and
 * `tests/unit/job-store-claim-docs-match-callers.test.ts` fails if one appears without this
 * paragraph being rewritten. The question it answers stopped being asked when the quality
 * scans stopped holding a live row at all: they run detached and file a settled AUDIT row
 * from `recordScanRun` when they are done, so there is no live scan for anyone to find.
 *
 * `getActiveJob` is kind-blind, which is right for `one_active_job_per_project` — the
 * partial unique index covers every kind, so there is at most one row to find — and wrong
 * for a caller asking "is a scan of *this* flavour already running?": it answers yes about
 * the user's own live BUILD, PUBLISH or the other scan. Same rule as the lookup above, for
 * the same reason: the kind filter belongs in the statement, not in a test applied to the
 * row it returned. That is why this shape is kept rather than deleted — the next caller that
 * needs a kind-scoped liveness test must not reach for `getActiveJob` and filter its answer.
 */
export async function getActiveJobOfKinds(
  projectId: string,
  kinds: readonly JobKind[],
): Promise<GenerationJobRow | null> {
  const rows = await selectJobs(
    `WHERE "projectId" = $1
       AND status IN ('QUEUED', 'RUNNING')
       AND kind::text = ANY($2::text[])
     ORDER BY "createdAt" DESC
     LIMIT 1`,
    projectId,
    [...kinds],
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
  // Stamp the creating instance. A QUEUED row used to carry no owner at all, so the
  // shutdown drain — `abandonInstanceJobs`, fenced to `"ownerInstance" = $1` — could not
  // see a job that was waiting for a provider slot when its process was told to go away,
  // and nothing settled it until the queued staleness window expired.
  // `markJobRunning` overwrites this with whichever instance actually starts the work.
  await prisma.$executeRaw`
    INSERT INTO "GenerationJob" (
      id, "projectId", "workspaceId", "userId", kind, status, "ownerInstance",
      attempt, "maxAttempts", "inputPrompt", "planVersion",
      "idempotencyKey", "requestId", "creditsChargedAt",
      "filesWritten", "createdAt", "updatedAt"
    ) VALUES (
      ${id}, ${input.projectId}, ${workspaceId}, ${input.userId},
      ${input.kind}::"JobKind", ${status}::"JobStatus", ${getInstanceId()},
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

/**
 * Insert a job row that is already over.
 *
 * `one_active_job_per_project` — UNIQUE ("projectId") WHERE status IN ('QUEUED','RUNNING'),
 * see the schema note on `model Job` — means a project has exactly one live job row, and
 * `createOrReuseJob` hands the next caller whatever is holding it. So anything that wants
 * to *record* work without competing for that slot cannot insert QUEUED and settle later:
 * that window is a window in which the user's next message is refused. It has to be
 * terminal from its first statement, which is what this writes.
 *
 * The detached quality scans are the caller. They run against no row at all — a scan that
 * held the slot answered "A build is already running on this project" to a build that had
 * finished — and file what happened here when they are done, so /admin/jobs and the
 * Quality panel still see a scan that failed.
 *
 * `heartbeatAt` stays NULL on purpose: the reaper only reads QUEUED/RUNNING rows, and a
 * row that was never alive has no heartbeat to explain. `attempt`/`maxAttempts` are 1/1
 * because nothing retries these — the next build kicks the next scan.
 */
export async function insertSettledJob(input: {
  projectId: string;
  workspaceId?: string;
  userId: string;
  kind: JobKind;
  status: 'SUCCEEDED' | 'FAILED';
  startedAt: Date;
  finishedAt?: Date;
  currentStep?: string | null;
  steps?: JobStep[] | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}): Promise<GenerationJobRow> {
  const id = nanoid();
  const workspaceId = input.workspaceId ?? WORKSPACE_ROW_ID;
  const finishedAt = input.finishedAt ?? new Date();
  await prisma.$executeRaw`
    INSERT INTO "GenerationJob" (
      id, "projectId", "workspaceId", "userId", kind, status, "ownerInstance",
      attempt, "maxAttempts", "startedAt", "finishedAt",
      "errorCode", "errorMessage", steps, "currentStep",
      "filesWritten", "createdAt", "updatedAt"
    ) VALUES (
      ${id}, ${input.projectId}, ${workspaceId}, ${input.userId},
      ${input.kind}::"JobKind", ${input.status}::"JobStatus", ${getInstanceId()},
      1, 1, ${input.startedAt}, ${finishedAt},
      ${input.errorCode ?? null}, ${input.errorMessage ?? null},
      ${JSON.stringify(input.steps ?? [])}::jsonb, ${input.currentStep ?? null},
      0, ${input.startedAt}, NOW()
    )
  `;
  const created = await getJob(id);
  if (!created) throw new Error('Failed to record a settled job');
  return created;
}

/**
 * The placeholder an in-flight scan attempt carries until it reports its outcome.
 *
 * ABANDONED with `server_restarted` is what the row honestly means if nothing ever
 * overwrites it: an attempt began and the process that owned it went away. The code is an
 * existing `JobErrorCode` on purpose — `CAUSE_LINES` in `./copy` is keyed by that union, so
 * inventing one here would be a row whose cause renders blank. Nothing offers recovery for
 * it either way: `showsChatRecovery('AUDIT')` is false.
 */
const SCAN_ATTEMPT_PLACEHOLDER = {
  status: 'ABANDONED',
  errorCode: 'server_restarted',
  errorMessage: 'The scan did not report back',
} as const;

/**
 * Reserve the one scan a project owes for a step, before a provider is called.
 *
 * WIRED TO NOTHING. This has no production caller: `tests/unit/job-store-claims-and-lookups.test.ts`
 * is the only file in the tree that names it, and `tests/unit/job-store-claim-docs-match-callers.test.ts`
 * fails if that stops being true without this paragraph being rewritten. An earlier revision
 * of this comment described the reservation below as the shipped bound, which it never was;
 * read the two paragraphs after this one as a design for a claim, not as a description of
 * what runs.
 *
 * What actually bounds the unmetered scans today is three things, none of them this:
 * `findRecentlySucceededBuild` refusing a warrant that is not a real finished build inside
 * `AUTO_SCAN_WARRANT_MS`; a module-local `Map` in each of `lib/audit/actions.ts` and
 * `lib/seo/actions.ts`; and `codeScanAttemptedSince` / `seoScanAttemptedSince` reading for an
 * AUDIT row that `recordScanRun` writes only *after* the scan returns. The last of those
 * bounds replays that arrive after a run has finished, not two runs in flight at once —
 * between the eligibility read and that insert the only exclusion is the Map, which a second
 * app instance does not share and a restart forgets. It costs nothing today because the
 * automatic path runs at depth `'static'` and calls no provider: a double run is two snapshot
 * reads and a duplicate AUDIT row. Restore the AI review to that path and it is money.
 *
 * Wiring this in is a change to files this comment does not own. Each action would call it
 * in place of its `…ScanAttemptedSince` read — `claimScanAttempt({ projectId, userId, step:
 * CODE_AUDIT_STEP, since: build.finishedAt })`, returning early when it answers `null` —
 * hold the returned id, and settle it through `applyJobFields` where `recordScanRun` now
 * calls `insertSettledJob`. Until every one of those lands, this stays an unused primitive
 * with an honest comment.
 *
 * The design, for whoever does that: the row goes in first and the caller settles it
 * afterwards. It is inserted terminal for the reason `insertSettledJob` explains —
 * `one_active_job_per_project` is kind-blind, and a live scan row answers "a build is already
 * running" to the user's next message. `createdAt` is the attempt's start, which is what the
 * `…ScanAttemptedSince` reads compare against the build's `finishedAt`, so the two shapes
 * agree on what an attempt record looks like.
 *
 * The lock and the read are separate statements inside one transaction because they have to
 * be. `INSERT … WHERE NOT EXISTS` as a single statement is not exclusive under READ
 * COMMITTED: both instances take their snapshot before either inserts, so both see no
 * attempt and both insert. Holding a transaction-scoped advisory lock keyed on
 * (projectId, step) and *then* reading gives the second instance a snapshot taken after the
 * first committed, so it sees the row and declines. The lock is held for three cheap
 * statements — never across the provider call.
 */
export async function claimScanAttempt(input: {
  projectId: string;
  workspaceId?: string;
  userId: string;
  step: string;
  /** Only an attempt at or after this instant counts — normally the build's `finishedAt`. */
  since: Date;
  startedAt?: Date;
}): Promise<string | null> {
  const id = nanoid();
  const workspaceId = input.workspaceId ?? WORKSPACE_ROW_ID;
  const startedAt = input.startedAt ?? new Date();
  const lockKey = `scan-attempt:${input.projectId}:${input.step}`;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;
    const existing = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "GenerationJob"
      WHERE "projectId" = ${input.projectId}
        AND kind = 'AUDIT'::"JobKind"
        AND "currentStep" = ${input.step}
        AND "createdAt" >= ${input.since}
      LIMIT 1
    `;
    if (existing.length > 0) return null;
    await tx.$executeRaw`
      INSERT INTO "GenerationJob" (
        id, "projectId", "workspaceId", "userId", kind, status, "ownerInstance",
        attempt, "maxAttempts", "startedAt", "finishedAt",
        "errorCode", "errorMessage", steps, "currentStep",
        "filesWritten", "createdAt", "updatedAt"
      ) VALUES (
        ${id}, ${input.projectId}, ${workspaceId}, ${input.userId},
        'AUDIT'::"JobKind", ${SCAN_ATTEMPT_PLACEHOLDER.status}::"JobStatus", ${getInstanceId()},
        1, 1, ${startedAt}, ${startedAt},
        ${SCAN_ATTEMPT_PLACEHOLDER.errorCode}, ${SCAN_ATTEMPT_PLACEHOLDER.errorMessage},
        '[]'::jsonb, ${input.step},
        0, ${startedAt}, NOW()
      )
    `;
    return id;
  });
}

/**
 * The build kinds that owe a quality scan when they settle.
 *
 * `settleStreamedGeneration` is the only kicker and the generate route creates
 * `isEdit ? 'FOLLOWUP' : 'BUILD'`, so this is the whole set. A PLAN produces no site to
 * scan and an IMPORT settles down a different path.
 */
const SCAN_KICKING_JOB_KINDS: readonly JobKind[] = ['BUILD', 'FOLLOWUP'];

/**
 * The build a detached, unmetered follow-up may name as its warrant.
 *
 * The auto-kicked scans are `'use server'` exports, which Next registers as endpoints
 * reachable by anyone who can post to the app — the same reason `isCodeScanInFlight` had
 * to grow a session gate (N-005). An unmetered scan behind an unproven entry point is a
 * free-scan button: the caller pays nothing and the AI review still runs. So the entry
 * point has to be handed a build that actually finished, and this is the lookup that
 * refuses everything else. Paired with "no scan row newer than `finishedAt`" at the call
 * site, a caller can obtain exactly the one scan the settle would have run anyway.
 *
 * `finishedAfter` bounds how long a warrant lasts, so an old job id cannot be replayed
 * forever.
 */
export async function findRecentlySucceededBuild(
  projectId: string,
  jobId: string,
  finishedAfter: Date,
): Promise<GenerationJobRow | null> {
  if (!jobId) return null;
  const rows = await selectJobs(
    `WHERE id = $1
       AND "projectId" = $2
       AND status = 'SUCCEEDED'
       AND kind::text = ANY($3::text[])
       AND "finishedAt" IS NOT NULL
       AND "finishedAt" >= $4
     LIMIT 1`,
    jobId,
    projectId,
    [...SCAN_KICKING_JOB_KINDS],
    finishedAfter,
  );
  return rows[0] ? mapJob(rows[0]) : null;
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

/**
 * Writes the fields and nothing else.
 *
 * `updateJobFields` re-reads the row afterwards, which most callers want and the
 * progress batcher does not: it fires every two seconds for the length of a
 * build and never looks at the result, so the read was a whole extra round trip
 * per flush against the same Postgres every request shares (F-034).
 */
export async function applyJobFields(id: string, fields: JobUpdateFields) {
  const { sql, values } = buildJobUpdate(id, fields);
  await prisma.$executeRawUnsafe(sql, ...values);
}

export async function updateJobFields(id: string, fields: JobUpdateFields) {
  await applyJobFields(id, fields);
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
 * Take a job for this runner, exclusively.
 *
 * `updateJobIfActive` guards on `status IN ('QUEUED','RUNNING')`, which is right for a
 * terminal settle and wrong for starting one: a second request landing on a job that is
 * already RUNNING won that write too, so two runners walked the same publish. Each held
 * its own `steps` array and its own `resourceIds` snapshot, so both raced a force-push on
 * one branch, both called `triggerDeploy`, and — when neither saw the other's application
 * yet — created two Coolify applications for one deployment, the second of which is
 * recorded nowhere and therefore unreapable.
 *
 * QUEUED always wins. RUNNING is only taken over when its heartbeat has stopped, which is
 * the same ownership test `reconcileAbandonedJobs` uses: a live runner rewrites
 * `heartbeatAt` every `HEARTBEAT_INTERVAL_MS`, so its rows are never stale, and a row
 * whose heartbeat stopped is unowned whichever instance last held it. Fencing on
 * `ownerInstance` instead would deadlock the only path that recovers a crashed instance's
 * work.
 *
 * The win is the returned row count, never a re-read: two callers reading "still QUEUED"
 * before either writes is exactly the race this exists to close.
 */
export async function claimJobRun(
  id: string,
  ownerInstance: string,
  staleBefore: Date,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "GenerationJob"
    SET status = 'RUNNING'::"JobStatus",
        "ownerInstance" = ${ownerInstance},
        "startedAt" = COALESCE("startedAt", NOW()),
        "heartbeatAt" = NOW(),
        "updatedAt" = NOW()
    WHERE id = ${id}
      AND (
        status = 'QUEUED'
        OR (status = 'RUNNING' AND ("heartbeatAt" IS NULL OR "heartbeatAt" < ${staleBefore}))
      )
    RETURNING id
  `;
  return rows.length > 0;
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

/**
 * Take an AUDIT row for one flavour of quality scan, by stamping the step that owns it.
 *
 * WIRED TO NOTHING. This has no production caller: the two quality scans stopped taking a
 * live AUDIT row — `one_active_job_per_project` made one the project's build slot, so a scan
 * holding it answered "a build is already running" to the user's next message — and now file
 * a settled row from `recordScanRun` instead. `tests/unit/job-store-claims-and-lookups.test.ts`
 * exercises it and `tests/unit/quality-scan-*.test.ts` still mock it on the store module;
 * `tests/unit/job-store-claim-docs-match-callers.test.ts` fails if a real caller appears
 * without this paragraph being rewritten. Everything below is the history of the race this
 * closed while it was wired, kept because the row shape and the index have not changed and
 * whoever reintroduces a live AUDIT row will meet all of it again.
 *
 * `createOrReuseJob` inserts with `currentStep` NULL and resolves contention through the
 * kind-blind `getActiveJob`, so "is this row mine?" used to be answered off that NULL — and
 * answered yes to both scans. Between the insert and the stamp the caller awaited
 * `markJobRunning`, a real round trip, and a person pressing Scan on Quality→Code and
 * Quality→SEO inside that window was stopped by nothing: the two callers keep separate
 * in-process maps and the project lock is re-entrant for one user. The second scan reused
 * the first's row and replaced its `steps` and `currentStep`, so a code scan that then
 * failed was reported by `getLatestSeoAudit` as an SEO failure while `getLatestCodeAudit`
 * — which filters on the marker — found nothing at all.
 *
 * Claiming and stamping are therefore one statement, and the question is never asked about
 * a row in an indeterminate state: the loser reads a `currentStep` already set to the
 * winner's step. The win is the returned row count, never a re-read — two callers both
 * reading "still NULL" before either writes is precisely the race this closes.
 *
 * What makes it a claim rather than a flavour test is `"currentStep" IS NULL` on its own.
 * The predicate used to end `OR "currentStep" = ${step}`, which excluded the *other* scan
 * and welcomed a second instance of the same one: two `runCodeAudit` calls landing on
 * different app instances (each with its own empty in-process map) both matched a row
 * already stamped `code-audit` and were both told it was theirs. Both then drove
 * `updateJobFields` and `beginJobHeartbeat` on it and both settled it, and because
 * `updateJobIfActive` makes the second settle a silent no-op, a scan that failed after the
 * other had succeeded left /admin/jobs reporting success for a run that errored. Nothing
 * re-enters: each of the two call sites claims once per invocation, and the next scan meets
 * a fresh row because a settled one is excluded by the status guard below — so refusing an
 * already-stamped row costs no legitimate caller anything.
 *
 * That exclusivity is Postgres's, not the process's: the conditional UPDATE takes the row
 * lock, so exactly one statement anywhere can observe the NULL and overwrite it. It does
 * not rest on this product effectively running one container.
 *
 * A settled row is not claimable. `markJobRunning` would throw on one anyway, and adopting
 * it would have `succeedJob` re-settle a job that is already over.
 */
export async function claimAuditJobStep(jobId: string, step: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "GenerationJob"
    SET "currentStep" = ${step}, "updatedAt" = NOW()
    WHERE id = ${jobId}
      AND kind = 'AUDIT'::"JobKind"
      AND status IN ('QUEUED', 'RUNNING')
      AND "currentStep" IS NULL
    RETURNING id
  `;
  return rows.length > 0;
}

/**
 * The marker that says "a keep is in flight on this row".
 *
 * Written by `claimKeptPartialJob` into `lastStep`, which is a free-text progress field, so
 * the claim costs no schema change. `settleKeptPartialJob` overwrites it with
 * `kept_partial` once the files are safely stored.
 */
const KEEP_CLAIM_MARKER = 'keeping';

/**
 * How long a keep claim is honoured before another attempt may take it over.
 *
 * The claim exists to exclude a double click, which arrives within milliseconds. A minute
 * is far past that, and it means a process that died between claiming and storing the files
 * cannot lock the partial build out of being kept for good.
 */
const KEEP_CLAIM_TTL_MS = 60_000;

/**
 * Phase 1 of "keep what was built": take the row without settling it.
 *
 * The settle used to come first, on the reasoning that a double click would otherwise save
 * `lastCode` twice and leave two checkpoints. It does exclude the double click — but
 * `createCheckpoint` writes a snapshot to object storage and can throw, and by then the row
 * was already SUCCEEDED, so it no longer matched `status IN ('ABANDONED','FAILED')`: every
 * further attempt got "already settled", `Project.lastCode` was never written, and the
 * partial files survived only in `Job.partialFiles` where no screen can reach them. A
 * storage blip destroyed the build the button exists to rescue.
 *
 * So the exclusive claim is non-terminal. The job stays ABANDONED/FAILED — and therefore
 * still keepable — until the files are stored.
 */
export async function claimKeptPartialJob(
  id: string,
  staleClaimBefore = new Date(Date.now() - KEEP_CLAIM_TTL_MS),
): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "GenerationJob"
    SET "lastStep" = ${KEEP_CLAIM_MARKER},
        "updatedAt" = NOW()
    WHERE id = ${id}
      AND status IN ('ABANDONED', 'FAILED')
      AND ("lastStep" IS DISTINCT FROM ${KEEP_CLAIM_MARKER} OR "updatedAt" < ${staleClaimBefore})
    RETURNING id
  `;
  return rows.length > 0;
}

/**
 * Hands a claim back when storing the files failed, so the person can click again.
 *
 * Restores whatever `lastStep` the abandoned run had reached, because that string is what
 * /admin/jobs and the recovery copy read to say how far the build got.
 */
export async function releaseKeptPartialClaim(id: string, lastStep: string | null): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "GenerationJob"
    SET "lastStep" = ${lastStep},
        "updatedAt" = NOW()
    WHERE id = ${id}
      AND "lastStep" = ${KEEP_CLAIM_MARKER}
  `;
}

/**
 * Phase 2 of "keep what was built": settle the row now that the files are stored.
 *
 * The recovery-status guard is in the same statement as the write, the same way
 * `updateJobIfActive` guards a terminal settle. The recovery panel is reachable while the
 * generation is still streaming — the client's 90-second heartbeat watchdog opens it
 * without asking the job — and the unguarded `UPDATE ... SET status = 'SUCCEEDED'` behind
 * it settled builds that were still writing files. The real output then landed on a job
 * that was already SUCCEEDED, so `succeedJob` was a no-op and the person kept a
 * half-written site that claimed to be finished.
 *
 * Zero rows means the job is not in a recovery state (still running, or already kept).
 */
export async function settleKeptPartialJob(id: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "GenerationJob"
    SET status = 'SUCCEEDED'::"JobStatus",
        "finishedAt" = NOW(),
        "lastStep" = 'kept_partial',
        "updatedAt" = NOW()
    WHERE id = ${id}
      AND status IN ('ABANDONED', 'FAILED')
    RETURNING id
  `;
  return rows.length > 0;
}

/**
 * The job kinds that legitimately sit QUEUED with no heartbeat.
 *
 * Only the generation stream route parks work in the provider queue:
 * `app/api/generate-ai-code-stream/route.ts:313` is the one `acquire()` call site in the
 * tree, and the job it waits on is `isEdit ? 'FOLLOWUP' : 'BUILD'`. Every other kind —
 * PUBLISH, AUDIT, PLAN, IMPORT and the `withRecordedJob` bookkeeping kinds — calls
 * `markJobRunning` in the statement after `createOrReuseJob`, so a QUEUED row of those
 * kinds means whatever was going to start it is gone.
 *
 * This list is the only gate on that distinction: a kind that starts queueing has to be
 * added here, and it cannot silently inherit the short window from somewhere else.
 */
export const QUEUE_WAITING_JOB_KINDS: readonly JobKind[] = ['BUILD', 'FOLLOWUP'];

/**
 * Reaper candidates, measured against two windows because a QUEUED row carries no
 * heartbeat: `markJobRunning` writes the first one.
 *
 * A build parked in the provider queue waits up to QUEUE_MAX_WAIT_MS for a slot, so
 * judging it by the 60-second heartbeat window abandoned live builds one minute into a
 * legitimate ten-minute wait: the chat flipped to "the server restarted" on a build that
 * had not started, the project left BUILDING, and the route — still holding the QUEUED
 * row it read minutes earlier — flipped the ABANDONED row back to RUNNING.
 *
 * The long window is keyed on kind, not on status alone. Giving it to every QUEUED row
 * meant a kind that never queues — a publish, an audit, an import — sat QUEUED with the
 * project stuck in BUILDING and the chat input locked for eleven minutes after its process
 * died, where the old rule freed it in one. Those kinds are judged by `staleBefore` too.
 */
export async function listReconcileCandidates(
  staleBefore: Date,
  queuedStaleBefore: Date,
  queueWaitingKinds: readonly JobKind[] = QUEUE_WAITING_JOB_KINDS,
) {
  const rows = await selectJobs(
    `WHERE (status = 'RUNNING' AND COALESCE("heartbeatAt", "createdAt") < $1)
        OR (
          status = 'QUEUED'
          AND COALESCE("heartbeatAt", "createdAt")
              < CASE WHEN kind::text = ANY($3::text[]) THEN $2 ELSE $1 END
        )`,
    staleBefore,
    queuedStaleBefore,
    [...queueWaitingKinds],
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
