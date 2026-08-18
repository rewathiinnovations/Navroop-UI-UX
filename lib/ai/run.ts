import { getDefaultCircuit, type CircuitBreaker } from './circuit';
import { EmptyCompletionError, surfaceStreamFailure } from './empty-completion';
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
  failedOver: boolean;
  attempts: ProviderAttempt[];
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

export async function executeWithFailover<T>(
  chain: ProviderEntry[],
  fn: (entry: ProviderEntry, ctx: { signal: AbortSignal }) => Promise<T>,
  opts: { circuit?: CircuitBreaker; timeoutMs?: number; now?: () => Date } = {},
): Promise<ProviderRunResult<T>> {
  const circuit = opts.circuit ?? getDefaultCircuit();
  const timeoutMs = opts.timeoutMs ?? PROVIDER_ATTEMPT_TIMEOUT_MS;
  const now = opts.now ?? (() => new Date());
  let lastError: unknown = new Error('No healthy provider is configured');
  const attempts: ProviderAttempt[] = [];
  let tried = 0;

  for (const entry of chain) {
    if (!circuit.isHealthy(entry.provider)) continue;
    tried += 1;
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
    abortTimer.unref?.();
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
        failedOver: tried > 1 || attempts.some((row) => !row.ok),
        attempts,
      };
    } catch (error) {
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

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new ProviderRunError(message, lastError, attempts);
}

/**
 * Start is timed (30s). Collecting the stream is not — a real first build
 * takes longer than PROVIDER_ATTEMPT_TIMEOUT_MS. An empty completion is a
 * failed attempt so the next configured provider runs. The chain is walked
 * once; the same provider is never retried.
 */
export async function executeWithCompletionFailover<TStream, TCollected>(
  chain: ProviderEntry[],
  start: (entry: ProviderEntry, ctx: { signal: AbortSignal }) => Promise<TStream>,
  collect: (started: TStream, entry: ProviderEntry) => Promise<TCollected>,
  isComplete: (collected: TCollected) => boolean,
  opts: { circuit?: CircuitBreaker; timeoutMs?: number; now?: () => Date } = {},
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
        throw new ProviderRunError(error.message, error.causeError, [...attempts, ...error.attempts]);
      }
      throw error;
    }

    const startFailed = started.attempts.filter((row) => !row.ok);
    if (startFailed.length > 0) {
      attempts.push(...startFailed);
      failedOver = true;
    }

    const servedEntry =
      chain.find((row) => row.provider === started.provider) ?? remaining[0];
    let collected: TCollected;
    try {
      collected = await collect(started.result, servedEntry);
    } catch (collectError) {
      // Job caps abort the whole run — they are not a reason to try the next vendor.
      if (collectError instanceof Error && collectError.name === 'JobCapError') {
        throw collectError;
      }
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
      const servedAt = remaining.findIndex((row) => row.provider === started.provider);
      index += Math.max(1, servedAt + 1);
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
        failedOver: failedOver || started.failedOver || attempts.some((row) => !row.ok),
        attempts,
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

    const servedAt = remaining.findIndex((row) => row.provider === started.provider);
    index += Math.max(1, servedAt + 1);
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new ProviderRunError(message, lastError, attempts);
}
