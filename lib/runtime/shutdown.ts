import { channel } from 'node:diagnostics_channel';
import { log, logError } from '@/lib/logger';
import { abandonInstanceJobs } from '@/lib/jobs/lifecycle';

let wired = false;

/**
 * What a redeploy is allowed to cost.
 *
 * Two deadlines, because two different things have to finish.
 *
 * `abandonInstanceJobs` writes one row per in-flight job serially, so if Postgres is the reason
 * for the restart — or merely slow — an unbounded await never settles and the container hangs
 * until SIGKILL. Every job then stays RUNNING under a dead instance's `ownerInstance` until
 * `reap-jobs` notices a minute later, so the user's generation looks frozen rather than "the
 * server is deploying". That is the job deadline.
 *
 * The listener deadline is the other half, and it is the one this module used to get wrong: it
 * raced the job drain against five seconds and then called `process.exit(0)` in a `finally`,
 * usually within milliseconds. Nothing waited for the HTTP listener, so every in-flight request
 * — including the SSE generation stream, a long-lived response by design — was cut at the
 * socket the moment the row writes finished (F-747). Docker's default grace after SIGTERM is
 * ten seconds and `docs/coolify.md` asks operators for fifteen, so the total budget has to stay
 * inside the smaller of the two: a container that will not die is a stuck deploy.
 */
const JOB_DRAIN_DEADLINE_MS = 5_000;
const TOTAL_DEADLINE_MS = 8_000;

/**
 * Only what the drain calls. Node's `http.Server` satisfies it; so does a test double, which is
 * the point — the capture below is the production path and the tests drive it through the same
 * channel a real request publishes on.
 */
export type DrainableListener = {
  listening?: boolean;
  close(callback?: (error?: Error) => void): unknown;
  closeIdleConnections?: () => void;
  once(event: 'close', listener: () => void): unknown;
};

/**
 * How the drain gets hold of the listener it has to wait for.
 *
 * Next creates the `http.Server` in `start-server`, installs its own SIGTERM/SIGINT cleanup in
 * the `listening` callback, and only then loads this instrumentation — so by the time
 * `wireShutdownDrain` runs there is no handle to be had and no way to intercept its creation.
 * Node publishes one on every request instead: `http.server.request.start` carries the `server`
 * that accepted it (and, on runtimes that predate that field, the socket whose `.server` is the
 * same object). The container healthcheck hits `/api/health` every fifteen seconds, so the
 * capture lands well before the first redeploy. The subscription is dropped as soon as it fires,
 * so the steady-state cost is one comparison per request until then and nothing after.
 */
const REQUEST_START_CHANNEL = 'http.server.request.start';

type Capture = {
  listener: DrainableListener;
  /**
   * Resolves when the listener has closed and every connection it held has ended. It carries a
   * value rather than `void` because `withDeadline` reports a lost race as `undefined`, and a
   * promise that resolves to `undefined` is indistinguishable from a timeout.
   */
  closed: Promise<'closed'>;
  isClosed: () => boolean;
};

let capture: Capture | null = null;

function listenerFrom(message: unknown): DrainableListener | null {
  if (!message || typeof message !== 'object') return null;
  const fields = message as { server?: unknown; socket?: { server?: unknown } };
  for (const candidate of [fields.server, fields.socket?.server]) {
    if (
      candidate &&
      typeof candidate === 'object' &&
      typeof (candidate as DrainableListener).close === 'function' &&
      typeof (candidate as DrainableListener).once === 'function'
    ) {
      return candidate as DrainableListener;
    }
  }
  return null;
}

function captureListener(message: unknown) {
  if (capture) return;
  const listener = listenerFrom(message);
  if (!listener) return;
  const done = Promise.withResolvers<'closed'>();
  let closed = false;
  listener.once('close', () => {
    closed = true;
    done.resolve('closed');
  });
  capture = { listener, closed: done.promise, isClosed: () => closed };
  channel(REQUEST_START_CHANNEL).unsubscribe(captureListener);
}

/** `undefined` when the deadline won the race, so a resolved value is proof of completion. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  const deadline = Promise.withResolvers<undefined>();
  // Unref'd: the work is what is being waited on, and the deadline must never be the reason
  // the process stays alive.
  const timer = setTimeout(() => deadline.resolve(undefined), ms);
  timer.unref?.();
  try {
    return await Promise.race([work, deadline.promise]);
  } finally {
    clearTimeout(timer);
  }
}

export function wireShutdownDrain() {
  if (wired || process.env.NEXT_RUNTIME === 'edge') return;
  wired = true;
  channel(REQUEST_START_CHANNEL).subscribe(captureListener);

  const drain = async (signal: string) => {
    const started = Date.now();
    log.warn('runtime.shutdown_drain', { signal, listener: capture ? 'known' : 'unobserved' });

    // Next's own cleanup runs first — it registered its handler before this instrumentation
    // loaded — so in production the listener is already closing by now and this is a no-op.
    // It is not dead code: it is what stops a deployment where nothing else owns the listener
    // (`NEXT_MANUAL_SIG_HANDLE`, a future custom server) from accepting new work while draining.
    if (capture && capture.listener.listening) {
      capture.listener.close();
      capture.listener.closeIdleConnections?.();
    }

    let jobsDrained = false;
    try {
      const abandoned = await withDeadline(abandonInstanceJobs('deploying'), JOB_DRAIN_DEADLINE_MS);
      jobsDrained = abandoned !== undefined;
      if (jobsDrained) {
        log.warn('runtime.shutdown_drained', { signal, abandoned });
      } else {
        // Exiting anyway is the better failure: the jobs are recoverable through `reap-jobs`,
        // whereas a container that will not die is a stuck deploy.
        log.warn('runtime.shutdown_drain_timeout', {
          signal,
          deadlineMs: JOB_DRAIN_DEADLINE_MS,
        });
      }
    } catch (error) {
      logError('runtime.shutdown_drain_failed', error, { signal });
    }

    // Whatever budget the job drain left goes to the in-flight requests. `unobserved` means no
    // request was ever served on this instance, so there is nothing holding a connection open.
    let listenerClosed = true;
    if (capture) {
      const remaining = Math.max(0, TOTAL_DEADLINE_MS - (Date.now() - started));
      listenerClosed =
        capture.isClosed() || (await withDeadline(capture.closed, remaining)) !== undefined;
      if (!listenerClosed) {
        log.warn('runtime.shutdown_listener_timeout', { signal, deadlineMs: TOTAL_DEADLINE_MS });
      }
    }

    // An honest exit code: zero only when the jobs were marked and the listener drained, so a
    // deploy log distinguishes a clean shutdown from a truncated one.
    return jobsDrained && listenerClosed ? 0 : 1;
  };

  // SIGINT as well as SIGTERM. A local Ctrl-C left this instance's jobs RUNNING owned by a
  // process that no longer exists, which is the same recoverable state a redeploy produces and
  // deserves the same handling.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void drain(signal)
        .catch((error: unknown) => {
          // The drain owns the exit, so nothing else will call it: a throw on this path used
          // to be impossible because the old handler exited from a `finally`. Keep that
          // guarantee — an unhandled rejection here is a container that never dies.
          logError('runtime.shutdown_handler_failed', error, { signal });
          return 1;
        })
        .then((code) => {
          process.exit(code);
        });
    });
  }
}
