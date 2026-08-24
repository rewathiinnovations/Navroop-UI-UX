import { NextResponse } from 'next/server';
import { getSessionUser, type SessionUser } from '@/lib/auth';
import { jsonError } from '@/lib/api/error-response';
import { prisma } from '@/lib/db';
import { log } from '@/lib/logger';
import { creditDeniedJson } from '@/lib/plans/http';
import { checkCredits } from '@/lib/plans/limits';
import { holdProjectLock, type LockHold } from '@/lib/projects/lock';
import { lockConflictJson } from '@/lib/projects/lock-http';
import { WORKSPACE_ROW_ID } from '@/lib/storage/usage';
import { isDeepSeekModel, unknownModelMessage } from '@/lib/ai/providers';
import {
  GENERATION_RATE_LIMIT_MESSAGE,
  allowGenerationSubmit,
} from '@/lib/generation/submit-rate-limit';
import { readGenerationProjectId } from '@/lib/generation/request-project';
import { readUserPrompt } from '@/lib/generation/user-prompt';

/**
 * Everything the generate route must clear before it acquires anything, in the order it
 * must clear it.
 *
 * This lived inline at the top of a ~2,000-line handler, which is what made the order a
 * convention rather than a property: each guard carried a comment saying it must stay
 * ahead of the acquisitions below, and the only thing keeping it there was that nobody
 * moved it. F-001 is what happens when one does — a bare `return` past the credit check,
 * the project lock and its 60s renew timer, the Job row, the provider-queue slot and the
 * job heartbeat leaked all five for the life of the process.
 *
 * The sequence is: refuse for free first (prompt, model, project id — no I/O, nothing
 * held), then identify (session), then authorize (ownership), then meter (rate limit,
 * credits), and only then acquire (the project lock). A refusal that has already spent or
 * locked something is not a refusal.
 *
 * Returns the lock hold rather than releasing it: the caller owns the run and the
 * `finally` that unwinds it. On any `ok: false` nothing has been acquired, so the caller
 * can return `response` directly with nothing to clean up.
 */
export type GenerationIntakeInput = {
  /** `prompt` off the request body, unvalidated. */
  promptInput: unknown;
  /** `model` off the request body, unvalidated. */
  requestedModelRaw: unknown;
  /** `projectId` off the request body. */
  requestProjectId: unknown;
  /** `context.projectId`, the legacy position for the same id. */
  contextProjectId: unknown;
};

export type GenerationIntakeRejected = {
  ok: false;
  /** Ready to return. Nothing was acquired, so there is nothing to release. */
  response: NextResponse;
};

export type GenerationIntakeAccepted = {
  ok: true;
  /** Trimmed and length-checked. Everything downstream reads this, not the raw input. */
  prompt: string;
  /**
   * Explicit only. Defaulting this to `appConfig.ai.defaultModel` pushed that model to
   * the front of the chain and demoted the configured primary (AI_PRIMARY_* / Admin ->
   * Configuration), so `undefined` here means "use the chain", not "use the default".
   */
  requestedModel: string | undefined;
  projectId: string;
  sessionUser: SessionUser;
  /** Live, owned by the caller. Assign `hold.release` before the first `await` that can throw. */
  hold: { ok: true } & LockHold;
};

export type GenerationIntake = GenerationIntakeRejected | GenerationIntakeAccepted;

export async function intakeGenerationRequest(
  input: GenerationIntakeInput,
): Promise<GenerationIntake> {
  // Reject a bad prompt before anything is acquired. This guard used to sit after the
  // credit check, the project lock (with its 60s renew timer), the Job row, the
  // provider-queue slot and the job heartbeat, and its bare `return` leaked all five
  // for the life of the process (F-001). It must stay ahead of every acquisition below.
  //
  // `readUserPrompt` is the whole contract: a string, non-empty after trimming, and no
  // longer than MAX_USER_PROMPT_CHARS. A whitespace-only request used to buy a full build
  // on no instruction, a non-string was coerced five different ways downstream (F-005),
  // and nothing bounded the length at all — so an oversized paste was refused by the
  // provider, after the credit was charged, as a `request_rejected` the recovery panel
  // offers no Try again for (F-007). Everything below reads the trimmed `prompt`.
  const promptCheck = readUserPrompt(input.promptInput);
  if (!promptCheck.ok) {
    return {
      ok: false,
      response: NextResponse.json({ success: false, error: promptCheck.message }, { status: 400 }),
    };
  }
  const prompt = promptCheck.prompt;

  const requestedModel =
    typeof input.requestedModelRaw === 'string' && input.requestedModelRaw.trim()
      ? input.requestedModelRaw.trim()
      : undefined;
  // Validated here, ahead of the session, the credit check, the project lock, the Job
  // row and the provider-queue slot: an unoffered model must not cost any of those.
  // It used to be trimmed and nothing else, then handed to the chain and on to
  // `client(entry.model)`, so any authenticated member could run every build on a
  // model the operator never configured and never priced — and a nonexistent id came
  // back from DeepSeek as `request_rejected`, which reads as an outage (F-003).
  if (requestedModel && !isDeepSeekModel(requestedModel)) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: unknownModelMessage(requestedModel) },
        { status: 400 },
      ),
    };
  }

  // The run's project, resolved once and required. A request with neither `projectId`
  // nor `context.projectId` used to run the whole build with `generationJob` null, which
  // skipped the provider-queue slot, the credit charge inside `markJobRunning`, the caps,
  // the heartbeat, the progress batcher and every terminal settle — a metered feature
  // turned off by omitting one field (F-035). See `readGenerationProjectId` for why this
  // is a refusal rather than a workspace-scoped meter. Validated with the prompt and the
  // model, before the session and before anything is acquired.
  const projectCheck = readGenerationProjectId(input.requestProjectId, input.contextProjectId);
  if (!projectCheck.ok) {
    return {
      ok: false,
      response: NextResponse.json({ success: false, error: projectCheck.message }, { status: 400 }),
    };
  }
  const projectId = projectCheck.projectId;

  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Sign in required' }, { status: 401 }),
    };
  }

  // The project id comes from the request body, so the session gate above is
  // not the whole authorization: without this, any signed-in member could name
  // another member's project and have this handler charge the workspace, take
  // that project's lock away from its owner, open a Job on it and settle
  // generated code over its `lastCode`. `persistProjectGeneration`
  // (lib/projects/actions.ts) already refuses a non-owner for exactly that
  // reason; this is the same decision on the route that does the writing
  // (F-313). It runs before the rate limiter, the credit check and the lock:
  // a refusal that has already spent or locked something is not a refusal.
  const ownedProject = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, ownerId: true },
  });
  if (!ownedProject) {
    return { ok: false, response: jsonError('Project not found', 'NOT_FOUND', 404) };
  }
  if (sessionUser.id !== ownedProject.ownerId && sessionUser.role !== 'ADMIN') {
    return { ok: false, response: jsonError('Forbidden', 'FORBIDDEN', 403) };
  }

  // Rate, not total. `checkCredits` bounds the month's spend and the
  // `one_active_job_per_project` index bounds concurrency per *project* — so a loop
  // creating a project and firing one generation each could spend the whole allowance as
  // fast as HTTP allows, with the spend ceiling (which trails by the job's own duration)
  // as the only backstop. Keyed on the member, ahead of the credit check and every
  // acquisition (F-010).
  if (!allowGenerationSubmit(sessionUser.id).allowed) {
    log.warn('generation.rate_limited', { userId: sessionUser.id });
    return {
      ok: false,
      response: jsonError(GENERATION_RATE_LIMIT_MESSAGE, 'RATE_LIMITED', 429),
    };
  }
  const creditCheck = await checkCredits(WORKSPACE_ROW_ID, sessionUser.id, 'generation');
  if (!creditCheck.ok) return { ok: false, response: creditDeniedJson(creditCheck) };

  // `holdProjectLock` rather than the hand-rolled acquire + heartbeat + release triple.
  // `acquireLock` is re-entrant for the same user, so when this user already held a live
  // lock on the project — their own audit or publish, or a hold leaked by an earlier run —
  // the old code took `ok: true`, started a second timer renewing a hold it did not own,
  // and then released the *other* feature's lock in its cleanup (security review NAV-03).
  // The hold knows whether it owns anything, so `release()` is a no-op on re-entry.
  //
  // Last, and the only thing this function acquires: every refusal above it is free.
  const hold = await holdProjectLock(projectId, sessionUser.id, 'generation');
  if (!hold.ok) return { ok: false, response: lockConflictJson(hold) };

  return { ok: true, prompt, requestedModel, projectId, sessionUser, hold };
}
