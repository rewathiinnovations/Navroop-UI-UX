import { createCheckpoint } from '@/lib/checkpoints/actions';
import {
  placeholderReplacements,
  replaceNeedImageTokens,
  sweepNeedImageTokens,
} from '@/lib/assets/need-image';
import { prisma } from '@/lib/db';
import { getCurrentProjectFiles } from '@/lib/github/current-files';
import { toLastCode } from '@/lib/projects/last-code';
import { bumpContentVersion } from '@/lib/projects/lock';
import { getApprovedPlanGenerationContext } from '@/lib/projects/plan';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { showsChatRecovery } from './chat-ui';
import { cancelJob, createOrReuseJob, resolveResumablePhase } from './lifecycle';
import { buildResumePrompt, shouldResumePartial } from './resume';
import {
  claimKeptPartialJob,
  getActiveJob,
  getJob,
  getLatestJobOfKinds,
  releaseKeptPartialClaim,
  setProjectResumablePhase,
  settleKeptPartialJob,
} from './store';
import {
  isRecoveryJobStatus,
  parsePartialFiles,
  type GenerationJobRow,
  type JobKind,
  type PartialFile,
} from './types';

/**
 * The kinds the chat surface is about, as a list rather than a predicate.
 *
 * `showsChatRecovery` says whether one row belongs to chat, and that is the wrong shape
 * for picking the newest one: `getLatestJob` is `ORDER BY "createdAt" DESC LIMIT 1` over
 * every kind, so filtering after it filters a single row that has already been chosen. The
 * auto quality scans file a settled AUDIT row after every successful build — and
 * `insertSettledJob` stamps `createdAt` with the scan's `startedAt`, which is later than
 * the build's — so "newest row" became "the scan" on every project that had ever built,
 * and both readers below then saw a job the chat had never shown.
 *
 * `tests/unit/chat-job-outlives-scan-row.test.ts` pins this against `showsChatRecovery`, so
 * a kind cannot be added to one and forgotten in the other.
 */
export const CHAT_JOB_KINDS: readonly JobKind[] = ['PLAN', 'BUILD', 'FOLLOWUP', 'IMPORT'];

/**
 * The newest job the chat surface could have been showing, in one round trip.
 *
 * This composed `getLatestJobByKind` over `CHAT_JOB_KINDS` for a while — four statements
 * fanned out with `Promise.all`. Its hot caller is `GET /api/projects/[id]/job`, which the
 * workspace polls every 2s per open viewer for the first two minutes of a build and every
 * 10s after; a project sitting in BUILDING with its job already settled reaches this
 * fallback on every single tick, so the fan-out turned a two-query request into a
 * five-query one — on the same endpoint where a lone `project.findFirst` had already been
 * measured as a third to a half of the request's database work (F-643). The other caller,
 * `resolveRecoveryTarget`'s no-jobId path, paid the same four for one click.
 *
 * `getLatestJobOfKinds` asks the same question with the kind set bound into the statement.
 * That placement is the load-bearing part, not an optimisation: filtering `getLatestJob`'s
 * single row by kind afterwards filters a row that has already been chosen, which is how a
 * settled AUDIT row came to answer for the chat surface in the first place.
 */
export function getLatestChatJob(projectId: string): Promise<GenerationJobRow | null> {
  return getLatestJobOfKinds(projectId, CHAT_JOB_KINDS);
}

/**
 * Failures that were ours rather than the build's.
 *
 * `server_restarted` and `deploying` are a redeploy or a crash taking the process away
 * mid-build; `timeout` and `client_disconnected` end an attempt the person did not abort.
 * Paired with zero files written, none of them is anything they did and none of them
 * produced output, so the retry continues a build they have already paid for. Nothing
 * refunds `creditsChargedAt` — neither `abandonActiveJob` nor `failJob` does — so dropping
 * the stamp on these debits a second credit for the same nothing.
 */
const OUR_FAULT_ERROR_CODES = new Set<string>([
  'server_restarted',
  'deploying',
  'timeout',
  'client_disconnected',
]);

function wasOurFault(job: { filesWritten: number; errorCode: string | null }) {
  return job.filesWritten === 0 && OUR_FAULT_ERROR_CODES.has(job.errorCode ?? '');
}

export async function keepPartialBuild(jobId: string) {
  const job = await getJob(jobId);
  if (!job) return { ok: false as const, error: 'Job not found', status: 404 };
  // The panel that offers this is also reachable while the build is still streaming —
  // the client opens it on a 90-second heartbeat gap, not on the job's status — so
  // "keep what was built" used to settle live builds. The generation then finished into
  // an already-SUCCEEDED row, its output was dropped, and the person was left on a
  // half-written site that claimed to be done. Only a job that has actually stopped can
  // be kept.
  if (!isRecoveryJobStatus(job.status)) {
    return {
      ok: false as const,
      error: 'That build has not stopped. Reload the page to see where it got to.',
      status: 409,
    };
  }
  const files = parsePartialFiles(job.partialFiles);
  if (files.length === 0) {
    return { ok: false as const, error: 'No files were written', status: 409 };
  }
  // Claim the job first, but do not settle it. The status write used to come first — a
  // double click otherwise saved lastCode twice and left two checkpoints of the same
  // partial build — and that turned any storage failure below into permanent loss: the row
  // was already SUCCEEDED, so it no longer matched the recovery statuses, every further
  // click got "already settled", and the files stayed in Job.partialFiles where no screen
  // can reach them. The claim is non-terminal, so the build stays keepable until it is
  // actually saved.
  const claimed = await claimKeptPartialJob(job.id);
  if (!claimed) {
    return {
      ok: false as const,
      error: 'That build has already been settled. Reload the page to see where it got to.',
      status: 409,
    };
  }
  try {
    // Merge over the current site, never replace it. `partialFiles` holds only the
    // files *this* run streamed — on a failed edit that is a fraction of the site,
    // and writing them as the whole tree turned a 30-file project into a 2-file
    // project, then checkpointed the damage. Same contract as the settle path
    // (settle-generation.ts): base from lastCode, partials spread on top. A first
    // build with no base falls out naturally — the merge is just the partials.
    const project = await prisma.project.findUnique({
      where: { id: job.projectId },
      select: { lastCode: true },
    });
    const existing = getCurrentProjectFiles({ lastCode: project?.lastCode ?? null });
    const kept: Record<string, string> = {};
    for (const file of files) {
      // Same last-line-of-defence sweep the settle path runs: a kept build must
      // not ship a literal `NEED_IMAGE: …` token into stored files.
      const leftovers = placeholderReplacements(file.content);
      const replaced =
        leftovers.length > 0 ? replaceNeedImageTokens(file.content, leftovers) : file.content;
      kept[file.path.replace(/^\.?\//, '')] = sweepNeedImageTokens(replaced);
    }
    // An unchanged tree (the edit re-streamed what was already there) still settles
    // the job below, but earns no rewrite, no version bump, and no duplicate
    // checkpoint of an identical snapshot.
    const changed = Object.entries(kept).some(([path, content]) => existing[path] !== content);
    await prisma.project.update({
      where: { id: job.projectId },
      data: {
        // A kept partial is code nobody checked — the run died before validation. The verdict
        // is cleared rather than left alone: whatever it said was about the files this write
        // is replacing, and a stale `false` would hold a site back from its own preview while
        // a stale `true` would let a half-written one publish. `null` is the truth here.
        ...(changed
          ? { lastCode: toLastCode({ ...existing, ...kept }), lastCodeValidated: null }
          : {}),
        generationStatus: 'ready',
      },
    });
    if (changed) {
      // Other tabs poll contentVersion to learn the content moved — the normal
      // persist path (persistProjectGeneration, settleStreamedGeneration) bumps
      // it after every lastCode write, and this write is no different.
      await bumpContentVersion(job.projectId);
      await createCheckpoint(job.projectId, {
        trigger: job.kind === 'FOLLOWUP' ? 'followup' : 'initial',
        sourceMessage: job.inputPrompt,
      });
    }
  } catch (error) {
    // Hand the claim back so the person can click again. createCheckpoint writes a snapshot
    // to object storage, and a 5xx there must not cost them the build.
    await releaseKeptPartialClaim(job.id, job.lastStep);
    throw error;
  }
  await settleKeptPartialJob(job.id);
  await setProjectResumablePhase(job.projectId, 'COMPLETE', 'ready');
  return { ok: true as const, filesWritten: files.length };
}

export async function retryAbandonedJob(jobId: string, idempotencyKey?: string | null) {
  const job = await getJob(jobId);
  if (!job) return { ok: false as const, error: 'Job not found', status: 404 };
  // The recovery panel opens on the client's 90-second heartbeat watchdog, not on the job's
  // status, so a still-RUNNING build is a reachable target for this button too. Retrying one
  // is a silent no-op dressed as success: `createOrReuseJob` returns the job that is already
  // active, the route answers 200 with a prompt and a resume flag, and nothing happens.
  // Only a stopped build can be retried — "Start over" is the button for a live one.
  if (!isRecoveryJobStatus(job.status)) {
    return {
      ok: false as const,
      error: 'That build has not stopped. Reload the page to see where it got to.',
      status: 409,
    };
  }
  const files = parsePartialFiles(job.partialFiles);
  const resume = shouldResumePartial({
    kind: job.kind,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    filesWritten: job.filesWritten,
    errorCode: job.errorCode,
  });
  const planContext =
    job.kind === 'BUILD' ? await getApprovedPlanGenerationContext(job.projectId) : '';
  const prompt = resume
    ? buildResumePrompt({
        originalPrompt: job.inputPrompt || '',
        planContext,
        writtenFiles: files,
      })
    : job.inputPrompt || planContext || '';
  // Refuse rather than create a job that cannot be started. `prompt` is empty whenever the
  // row has no `inputPrompt` and there is no approved plan to fall back on — always for a
  // FOLLOWUP, since `planContext` is only fetched for BUILD. The route answered ok with
  // that empty string, so a QUEUED row was inserted that nothing would ever start: it held
  // `one_active_job_per_project` and left the phase BUILDING with chat locked until the
  // queued-stale reaper. `recoveryRetryIntent` declines this in the client too (F-033).
  if (!prompt.trim()) {
    return {
      ok: false as const,
      error: 'We do not have the prompt for this build. Type what you want changed instead.',
      status: 400,
    };
  }

  const next = await createOrReuseJob({
    projectId: job.projectId,
    workspaceId: job.workspaceId || WORKSPACE_ROW_ID,
    userId: job.userId,
    kind: job.kind,
    inputPrompt: job.inputPrompt,
    planVersion: job.planVersion,
    idempotencyKey: idempotencyKey ?? null,
    attempt: resume ? job.attempt + 1 : 1,
    maxAttempts: job.maxAttempts,
    // A fresh attempt is a new billed build, which is what the recovery panel promises.
    // Copying the stamp forward made every "Try again" free and repeatable, because
    // chargeJobCreditsOnce short-circuits on creditsChargedAt. A resume continues the build
    // that was already charged, so that one keeps the stamp — and so does an attempt that
    // produced nothing because we took the process away. `shouldResumePartial` is false for
    // a BUILD abandoned with zero files, so billing on that basis alone charged a second
    // credit for our own redeploy and delivered nothing twice.
    creditsChargedAt: resume || wasOurFault(job) ? job.creditsChargedAt : null,
  });

  return {
    ok: true as const,
    job: next,
    prompt,
    resume,
  };
}

export async function startOverJob(jobId: string) {
  const job = await getJob(jobId);
  if (!job) return { ok: false as const, error: 'Job not found', status: 404 };
  // No stopped-status check here, unlike keep and retry. The panel opens on the client's
  // heartbeat watchdog while the build may still be RUNNING, and cancelling a live build is
  // exactly what "Start over" means — it is the only way out of a build the watchdog says is
  // hung. cancelJob's own conditional write makes a double click idempotent.
  await cancelJob(jobId, 'Start over');
  const phase = await resolveResumablePhase(job.projectId, 0);
  await setProjectResumablePhase(job.projectId, phase, 'idle');
  if (phase === 'PLANNING') {
    // An APPROVED plan renders no Approve button, so resetting to PLANNING
    // while the plan stayed APPROVED stranded the project: "review the plan
    // and approve" with nothing to click. Reopen the plan so the PlanCard
    // offers Approve & Build again.
    const { prisma } = await import('@/lib/db');
    await prisma.projectPlan.updateMany({
      where: { projectId: job.projectId, status: 'APPROVED' },
      data: { status: 'PENDING' },
    });
  }
  return { ok: true as const, phase };
}

export type RecoveryTarget =
  { ok: true; job: GenerationJobRow } | { ok: false; error: string; code: string; status: number };

/**
 * The job a recovery click may act on.
 *
 * The three recovery routes used to resolve their own target with `getLatestJob` and
 * ignore the client entirely, so a click made against a panel drawn seconds earlier
 * applied to whatever was newest at that instant — "start over" on a project whose newest
 * job had become a running PUBLISH cancelled the publish, and "keep" settled a job the
 * person never saw. So: when the client names the job it rendered, that job is loaded and
 * judged on its own terms, never swapped for another one.
 *
 * Validating the named job by requiring it to *be* the newest row was the first attempt at
 * that, and it was too strong, because any project-scoped job becomes newest:
 * `withRecordedJob` writes EXPORT rows for a ZIP download, DOMAIN_VERIFY rows for a domain
 * check, TEMPLATE_THUMBNAIL rows for a screenshot. Download the ZIP with the recovery panel
 * open and "Keep what was built" answered "This project has moved on" about a build that was
 * exactly where it was left. What actually makes a panel unsafe to act on is another job
 * being *live*, because all three actions rewrite `Project.phase`.
 *
 * The client cannot always name one. The recovery UI also opens on the client's own
 * watchdog, which fires on a heartbeat gap and does not need a job object, so a panel with
 * no rendered job is normal rather than a broken caller. That path falls back to the newest
 * job, but only within the kinds the recovery UI can possibly be showing
 * (`CHAT_JOB_KINDS`) — a publish, audit or cron job is never reachable without being
 * named, which is the defect that let "start over" cancel a running publish.
 *
 * The kind restriction has to be part of that lookup, not a test applied to its result.
 * `getLatestJob` picked the newest row of any kind and the `showsChatRecovery` check below
 * then refused it, so once the auto quality scans started filing an AUDIT row after every
 * successful build this path answered 409 NOT_RECOVERABLE for every project that had ever
 * built — the panel's own buttons, dead, on a build sitting right where it was left.
 */
export async function resolveRecoveryTarget(
  projectId: string,
  jobId: unknown,
): Promise<RecoveryTarget> {
  const named = typeof jobId === 'string' ? jobId.trim() : '';
  const job = named ? await getJob(named) : await getLatestChatJob(projectId);
  // A named job belonging to another project is not this caller's to see, so it reads as
  // missing rather than forbidden.
  if (!job || job.projectId !== projectId) {
    return { ok: false, error: 'No generation job found', code: 'NOT_FOUND', status: 404 };
  }
  if (!showsChatRecovery(job.kind)) {
    return {
      ok: false,
      error: 'That job was not started from chat, so it cannot be recovered from here.',
      code: 'NOT_RECOVERABLE',
      status: 409,
    };
  }
  const active = await getActiveJob(projectId);
  if (active && active.id !== job.id) {
    return {
      ok: false,
      error:
        'This project has moved on since that panel was drawn. Reload the page to see where it got to.',
      code: 'STALE_JOB',
      status: 409,
    };
  }
  return { ok: true, job };
}

export function recoveryFiles(job: { partialFiles: PartialFile[] | null }): PartialFile[] {
  return parsePartialFiles(job.partialFiles);
}
