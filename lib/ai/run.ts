import { JOB_TIMEOUT_MS } from '@/lib/jobs/poll';
import { CircuitOpenError, getDefaultCircuit, type CircuitBreaker } from './circuit';
import { EmptyCompletionError, StreamStalledError, surfaceStreamFailure } from './empty-completion';
import { PROVIDER_ATTEMPT_TIMEOUT_MS, shouldFailover } from './failover';
import type { ProviderEntry, ProviderName } from './providers';

export class ProviderRunError extends Error {
  readonly causeError: unknown;
  readonly attempts: ProviderAttempt[];
  constructor(message: string, causeError?: unknown, attempts: ProviderAttempt[] = []) {
    super(message);
    this.name = 'ProviderRunError';
    this.causeError = causeError;
    this.attempts = attempts;
  }
}

export class ProviderAttemptTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Provider attempt timed out after ${timeoutMs}ms`);
    this.name = 'ProviderAttemptTimeoutError';
  }
}

/**
 * How long a stream may go quiet before it is treated as dead.
 *
 * `PROVIDER_ATTEMPT_TIMEOUT_MS` bounds only `start` — the `streamText` call that returns a
 * lazy handle — and both the racing timer and its AbortController are cleared as soon as
 * that handle exists. Collection was then unbounded, so a provider that accepted the
 * request and stalled mid-stream held the request handler, the provider-queue slot and the
 * project lock for up to the 20-minute job timeout: the staleness reaper is no help,
 * because the heartbeat is a `setInterval` that a stalled `await` does not stop.
 *
 * An idle bound rather than a wall clock, because a legitimate first build streams for
 * minutes. Derived from `JOB_TIMEOUT_MS` rather than picked, so the three bounds on one run
 * — the platform's `maxDuration`, this, and the job's own hard timeout — cannot drift apart
 * (F-030).
 *
 * A quarter of the job timeout (5 minutes) rather than something tighter, because
 * `textStream` yields text deltas only: a thinking-mode model can reason for a long time
 * before its first visible token, and cutting that off would fail healthy builds. Five
 * minutes of silence still leaves fifteen for the run and ends a wedged handler long
 * before the reaper would.
 */
export const STREAM_IDLE_TIMEOUT_MS = JOB_TIMEOUT_MS / 4;

export type ProviderAttempt = {
  provider: ProviderName;
  model: string;
  ok: boolean;
  error?: string;
  at: string;
};

export type ProviderRunResult<T> = {
  result: T;
  provider: ProviderName;
  model: string;
  /**
   * The chain entry that actually served, by identity.
   *
   * `provider` cannot stand in for it: the chain shape allows two entries for the
   * same provider (two DeepSeek models), so matching a result back to its entry by
   * provider name always resolved to the first one. That handed `collect` the wrong
   * model and made the failover index advance land short, re-running the entry that
   * had just failed (F-055).
   */
  entry: ProviderEntry;
  failedOver: boolean;
  attempts: ProviderAttempt[];
  /**
   * Aborts the attempt's provider-facing signal — the one handed to `streamText`. The
   * idle bound below needs it: nothing else can end a `for await` over a stream the
   * provider has stopped feeding.
   */
  abort: (reason?: unknown) => void;
};

/** What `collect` is given so a live stream can say so. */
export type ProviderCollectContext = {
  /** Call on every chunk received. Rearms the idle timer. */
  progress: () => void;
};

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProviderAttemptTimeoutError(timeoutMs)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type ProviderRunOptions = {
  circuit?: CircuitBreaker;
  timeoutMs?: number;
  now?: () => Date;
  /**
   * External cancellation — Cancel / Start over settling the job row (F-022). Aborting
   * it aborts the current attempt's provider-facing signal (which the caller hands to
   * `streamText`), so an in-flight stream stops mid-collection. A cancelled attempt is
   * neither retried on the next provider nor counted as a circuit failure: the user
   * stopping the work says nothing about provider health.
   */
  signal?: AbortSignal;
  /**
   * Silence allowed between two chunks of a stream before it is abandoned. Defaults to
   * `STREAM_IDLE_TIMEOUT_MS`.
   */
  idleTimeoutMs?: number;
};

export async function executeWithFailover<T>(
  chain: ProviderEntry[],
  fn: (entry: ProviderEntry, ctx: { signal: AbortSignal }) => Promise<T>,
  opts: ProviderRunOptions = {},
): Promise<ProviderRunResult<T>> {
  const circuit = opts.circuit ?? getDefaultCircuit();
  const timeoutMs = opts.timeoutMs ?? PROVIDER_ATTEMPT_TIMEOUT_MS;
  const now = opts.now ?? (() => new Date());
  let lastError: unknown = new Error('No healthy provider is configured');
  const attempts: ProviderAttempt[] = [];
  let tried = 0;
  /** The furthest-out breaker among the entries this run declined to call. */
  let restingUntil = 0;

  for (const entry of chain) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('The run was aborted');
    if (!circuit.isHealthy(entry.provider)) {
      const until = circuit.openUntil(entry.provider);
      if (until != null && until > restingUntil) restingUntil = until;
      continue;
    }
    tried += 1;
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
    abortTimer.unref?.();
    // Deliberately left attached past this attempt: the controller's signal is what the
    // caller hands to the provider stream, and collection continues after `fn` returns —
    // an external cancel must still reach it mid-collection. Aborting a finished
    // attempt's controller is a no-op.
    opts.signal?.addEventListener('abort', () => controller.abort(opts.signal?.reason), {
      once: true,
    });
    try {
      const result = await withTimeout(fn(entry, { signal: controller.signal }), timeoutMs);
      circuit.recordSuccess(entry.provider);
      attempts.push({
        provider: entry.provider,
        model: entry.model,
        ok: true,
        at: now().toISOString(),
      });
      return {
        result,
        provider: entry.provider,
        model: entry.model,
        entry,
        failedOver: tried > 1 || attempts.some((row) => !row.ok),
        attempts,
        abort: (reason?: unknown) => controller.abort(reason),
      };
    } catch (error) {
      // A cancelled attempt is not a provider verdict: no failover, no circuit failure.
      if (opts.signal?.aborted) throw error;
      lastError = error;
      attempts.push({
        provider: entry.provider,
        model: entry.model,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        at: now().toISOString(),
      });
      if (!shouldFailover(error)) throw error;
      circuit.recordFailure(entry.provider);
    } finally {
      clearTimeout(abortTimer);
    }
  }

  // Every entry was skipped because its breaker is open: the app declined to call the
  // provider. Reporting that as `lastError`'s placeholder ("No healthy provider is
  // configured") told the user the vendor did not respond and the operator that their
  // configuration was wrong, and mentioned neither the real cause nor that it clears by
  // itself (F-031).
  if (tried === 0 && restingUntil > 0) {
    const resting = new CircuitOpenError(
      chain[0]?.provider ?? 'unknown',
      restingUntil - now().getTime(),
    );
    throw new ProviderRunError(resting.message, resting, attempts);
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new ProviderRunError(message, lastError, attempts);
}

/**
 * Collect the stream with a rolling idle bound.
 *
 * The timer is rearmed by `ctx.progress()` on every chunk, so a slow-but-live stream runs
 * as long as it needs and a silent one is cut. On expiry the attempt's provider-facing
 * signal is aborted — the only thing that can end a `for await` over a stream nobody is
 * feeding — and the stall is reported as the collect failure so the normal classification
 * and failover path applies.
 */
async function collectWithIdleBound<TStream, TCollected>(
  started: ProviderRunResult<TStream>,
  entry: ProviderEntry,
  collect: (
    started: TStream,
    entry: ProviderEntry,
    ctx: ProviderCollectContext,
  ) => Promise<TCollected>,
  idleMs: number,
): Promise<TCollected> {
  const { promise: stalled, reject } = Promise.withResolvers<never>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const rearm = () => {
    if (done) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const error = new StreamStalledError(started.provider, idleMs);
      started.abort(error);
      reject(error);
    }, idleMs);
    timer.unref?.();
  };
  rearm();
  const work = collect(started.result, entry, { progress: rearm });
  // Whichever promise loses the race still settles; attaching a handler here is what
  // keeps the loser from surfacing as an unhandled rejection.
  void work.catch(() => undefined);
  void stalled.catch(() => undefined);
  try {
    return await Promise.race([work, stalled]);
  } finally {
    done = true;
    clearTimeout(timer);
  }
}

/**
 * Start is timed (30s) and collection is bounded by silence rather than a wall clock
 * (`STREAM_IDLE_TIMEOUT_MS`) — a real first build streams for longer than
 * PROVIDER_ATTEMPT_TIMEOUT_MS but never goes quiet for minutes. An empty completion is a
 * failed attempt so the next configured provider runs. The chain is walked once; the
 * entry that served is never retried.
 */
export async function executeWithCompletionFailover<TStream, TCollected>(
  chain: ProviderEntry[],
  start: (entry: ProviderEntry, ctx: { signal: AbortSignal }) => Promise<TStream>,
  collect: (
    started: TStream,
    entry: ProviderEntry,
    ctx: ProviderCollectContext,
  ) => Promise<TCollected>,
  isComplete: (collected: TCollected) => boolean,
  opts: ProviderRunOptions = {},
): Promise<ProviderRunResult<TCollected>> {
  const circuit = opts.circuit ?? getDefaultCircuit();
  const now = opts.now ?? (() => new Date());
  const attempts: ProviderAttempt[] = [];
  let lastError: unknown = new Error('No healthy provider is configured');
  let failedOver = false;
  let index = 0;

  while (index < chain.length) {
    const remaining = chain.slice(index);
    let started: ProviderRunResult<TStream>;
    try {
      started = await executeWithFailover(remaining, start, opts);
    } catch (error) {
      if (error instanceof ProviderRunError) {
        throw new ProviderRunError(error.message, error.causeError, [
          ...attempts,
          ...error.attempts,
        ]);
      }
      throw error;
    }

    const startFailed = started.attempts.filter((row) => !row.ok);
    if (startFailed.length > 0) {
      attempts.push(...startFailed);
      failedOver = true;
    }

    let collected: TCollected;
    try {
      // The entry that served, by identity — never a provider-name lookup. With two
      // entries for the same provider the name resolves to the first one, so `collect`
      // was handed the wrong model (F-055).
      collected = await collectWithIdleBound(
        started,
        started.entry,
        collect,
        opts.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS,
      );
    } catch (collectError) {
      // Job caps abort the whole run — they are not a reason to try the next vendor.
      if (collectError instanceof Error && collectError.name === 'JobCapError') {
        throw collectError;
      }
      // So does an external cancel: the next vendor must not redo cancelled work, and a
      // user stopping the build is not a circuit failure (F-022).
      if (opts.signal?.aborted) throw collectError;
      lastError = collectError;
      failedOver = true;
      attempts.push({
        provider: started.provider,
        model: started.model,
        ok: false,
        error: collectError instanceof Error ? collectError.message : String(collectError),
        at: now().toISOString(),
      });
      if (!shouldFailover(collectError)) throw collectError;
      circuit.recordFailure(started.provider);
      // Past the entry that served, by identity. The old provider-name lookup
      // answered 0 for every DeepSeek entry, so a failure on the second one
      // advanced by 1 and the loop restarted it (F-055).
      index += Math.max(1, remaining.indexOf(started.entry) + 1);
      continue;
    }

    if (isComplete(collected)) {
      attempts.push({
        provider: started.provider,
        model: started.model,
        ok: true,
        at: now().toISOString(),
      });
      return {
        result: collected,
        provider: started.provider,
        model: started.model,
        entry: started.entry,
        failedOver: failedOver || started.failedOver || attempts.some((row) => !row.ok),
        attempts,
        // The attempt's controller, so a caller that keeps the result can still stop
        // anything the stream left running. Aborting a finished attempt is a no-op.
        abort: started.abort,
      };
    }

    const streamError = await surfaceStreamFailure(
      started.result as { text?: PromiseLike<string>; streamError?: unknown },
    );
    const cause = streamError ?? new EmptyCompletionError(started.provider, started.model);
    if (cause && typeof cause === 'object' && !('provider' in cause)) {
      Object.assign(cause, { provider: started.provider });
    }
    lastError = cause;
    failedOver = true;
    attempts.push({
      provider: started.provider,
      model: started.model,
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
      at: now().toISOString(),
    });
    if (!shouldFailover(cause)) throw cause;
    circuit.recordFailure(started.provider);

    index += Math.max(1, remaining.indexOf(started.entry) + 1);
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new ProviderRunError(message, lastError, attempts);
}
