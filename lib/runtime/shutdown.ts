import { log, logError } from '@/lib/logger';
import { abandonInstanceJobs } from '@/lib/jobs/lifecycle';

let wired = false;

/**
 * Docker's default grace after SIGTERM is ten seconds and `docs/coolify.md` asks operators for
 * fifteen, so the drain needs a deadline well inside the smaller of the two.
 * `abandonInstanceJobs` writes one row per in-flight job serially; if Postgres is the reason
 * for the restart — or merely slow — the unbounded await never settled, `process.exit(0)` was
 * never reached, and the container hung until SIGKILL. Every job then stayed RUNNING under a
 * dead instance's `ownerInstance` until `reap-jobs` noticed a minute later, so the user's
 * generation looked frozen rather than "the server is deploying" — the opposite of what
 * draining is for.
 */
const DRAIN_DEADLINE_MS = 5_000;

export function wireShutdownDrain() {
  if (wired || process.env.NEXT_RUNTIME === 'edge') return;
  wired = true;

  const drain = async (signal: string) => {
    log.warn('runtime.shutdown_drain', { signal });
    const deadline = Promise.withResolvers<'timeout'>();
    // Unref'd: the drain is what is being waited on, and the deadline must never be the
    // reason the process stays alive.
    setTimeout(() => deadline.resolve('timeout'), DRAIN_DEADLINE_MS).unref();
    try {
      const outcome = await Promise.race([abandonInstanceJobs('deploying'), deadline.promise]);
      if (outcome === 'timeout') {
        // Exiting anyway is the better failure: the jobs are recoverable through `reap-jobs`,
        // whereas a container that will not die is a stuck deploy.
        log.warn('runtime.shutdown_drain_timeout', { signal, deadlineMs: DRAIN_DEADLINE_MS });
      } else {
        log.warn('runtime.shutdown_drained', { signal, abandoned: outcome });
      }
    } catch (error) {
      logError('runtime.shutdown_drain_failed', error, { signal });
    }
  };

  // SIGINT as well as SIGTERM. A local Ctrl-C left this instance's jobs RUNNING owned by a
  // process that no longer exists, which is the same recoverable state a redeploy produces and
  // deserves the same handling.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void drain(signal).finally(() => {
        process.exit(0);
      });
    });
  }
}
