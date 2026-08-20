import { NextResponse } from 'next/server';
import { jsonError } from '../api/error-response';
import { logError } from '../logger';
import { readRequestId, REQUEST_ID_HEADER } from '../request-id';
import { authorizeCron } from './auth';
import { getCronClaimStore, type CronClaimStore } from './claim';
import {
  recordAbandonedCronRun,
  withCronRun,
  type CronOutcome,
  type CronRecordDeps,
} from './record';

export type CronHandleDeps = CronRecordDeps & {
  claims?: CronClaimStore;
};

export async function handleCron<T extends CronOutcome>(
  name: string,
  request: Request,
  fn: () => Promise<T>,
  deps: CronHandleDeps = {},
) {
  if (!(await authorizeCron(request))) {
    return jsonError('Unauthorized', 'UNAUTHORIZED', 401);
  }
  const requestId = readRequestId(request.headers);
  const now = deps.now ? deps.now() : new Date();

  // Claimed before any work, so a scheduler retry, a slow run overlapping the next tick, a
  // second replica or a hand-fired request cannot double it up (F-708). The claim outlives the
  // process, which is what lets the next invocation report a run that was killed.
  const outcome = await (deps.claims ?? getCronClaimStore()).claim(name, now);
  if (!outcome.claimed) {
    // 409, not 500: nothing failed. The run holding the claim writes the only CronRun row, so
    // a refused request must not add one — a red row here would blame the wrong invocation.
    return jsonError(
      `${name} is already running (claimed ${outcome.runningSince})`,
      'CRON_ALREADY_RUNNING',
      409,
      requestId,
    );
  }

  try {
    if (outcome.abandoned) {
      await recordAbandonedCronRun(name, outcome.abandoned, deps);
    }
    // No response mapper. There used to be an optional one, and every route that passed it
    // skipped the `!result.ok` branch below — a cron could report a failed run and still answer
    // 200 to Coolify's scheduler. No route used it.
    const result = await withCronRun(name, fn, deps);
    if (!result.ok) {
      // The cron reports its own failure shape and may carry diagnostic fields,
      // so the body is passed through; only the correlation id is added.
      return NextResponse.json(result, {
        status: 500,
        headers: { [REQUEST_ID_HEADER]: requestId },
      });
    }
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(message, 'CRON_FAILED', 500);
  } finally {
    // Released on every exit, including the throwing one, or the schedule stops until the claim
    // goes stale. A failed release is logged rather than thrown: a throw from `finally`
    // discards the response above, and turning a healthy run into a 500 because one cleanup
    // DELETE did not land is a worse outcome than one stale claim, which the next invocation
    // settles by itself.
    try {
      await outcome.claim.release();
    } catch (error) {
      logError('cron.claim_release_failed', error, { requestId, cron: name });
    }
  }
}
