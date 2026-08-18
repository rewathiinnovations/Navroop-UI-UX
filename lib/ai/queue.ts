import { backoffMs } from './failover';

export const QUEUE_TIMEOUT_MESSAGE = 'The build waited too long in the queue';
export const QUEUE_MAX_WAIT_MS = 10 * 60_000;

export function queuePositionLabel(n: number) {
  return `In queue — ${n} builds ahead`;
}

export type QueueStartResult =
  | { ok: true }
  | { ok: false; errorMessage: string };

export type QueueAcquire = {
  position: number;
  started: Promise<QueueStartResult>;
  release: () => void;
};

type Waiter = {
  jobId: string;
  resolve: (result: QueueStartResult) => void;
  settled: boolean;
};

export function createProviderQueue(opts: {
  concurrency: number;
  maxWaitMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}) {
  const concurrency = Math.max(1, opts.concurrency);
  const maxWaitMs = opts.maxWaitMs ?? QUEUE_MAX_WAIT_MS;
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        // unref so a 10-minute queue timeout does not hold the process open.
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }));
  const running = new Map<string, number>();
  const waiters = new Map<string, Waiter[]>();

  function runningCount(id: string) {
    return running.get(id) ?? 0;
  }

  function take(id: string) {
    running.set(id, runningCount(id) + 1);
  }

  function promote(id: string) {
    const list = waiters.get(id) ?? [];
    while (list.length > 0 && runningCount(id) < concurrency) {
      const next = list.shift();
      if (!next || next.settled) continue;
      take(id);
      next.resolve({ ok: true });
    }
    waiters.set(id, list);
  }

  function handleRateLimit(providerId: string, input: { retryAfterSeconds?: number; attempt?: number } = {}) {
    void providerId;
    if (input.retryAfterSeconds != null && Number.isFinite(input.retryAfterSeconds)) {
      const waitMs = Math.min(60_000, Math.max(0, input.retryAfterSeconds * 1000));
      return { waitMs };
    }
    return { waitMs: Math.min(60_000, backoffMs(input.attempt ?? 0)) };
  }

  function acquire(
    providerId: string,
    input: { jobId: string; onPosition?: (n: number) => void },
  ): QueueAcquire {
    const queuedAhead = Math.max(0, runningCount(providerId) - concurrency) + (waiters.get(providerId)?.length ?? 0);
    const needsQueue = runningCount(providerId) >= concurrency;
    const position = needsQueue ? queuedAhead + 1 : 0;

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      running.set(providerId, Math.max(0, runningCount(providerId) - 1));
      promote(providerId);
    };

    if (!needsQueue) {
      take(providerId);
      input.onPosition?.(0);
      return { position: 0, started: Promise.resolve({ ok: true as const }), release };
    }

    input.onPosition?.(position);
    let settle: (result: QueueStartResult) => void = () => undefined;
    const started = new Promise<QueueStartResult>((resolve) => {
      settle = resolve;
    });
    const waiter: Waiter = {
      jobId: input.jobId,
      settled: false,
      resolve: (result) => {
        if (waiter.settled) return;
        waiter.settled = true;
        settle(result);
      },
    };
    const list = waiters.get(providerId) ?? [];
    list.push(waiter);
    waiters.set(providerId, list);

    sleep(maxWaitMs)
      .then(() => {
        if (waiter.settled) return;
        const remaining = (waiters.get(providerId) ?? []).filter((row) => row !== waiter);
        waiters.set(providerId, remaining);
        waiter.resolve({ ok: false, errorMessage: QUEUE_TIMEOUT_MESSAGE });
      })
      .catch(() => {
        // A failed timer must not leave the waiter hanging, and must not become an
        // unhandled rejection.
        if (waiter.settled) return;
        waiter.resolve({ ok: false, errorMessage: QUEUE_TIMEOUT_MESSAGE });
      });

    return { position, started, release };
  }

  return { acquire, handleRateLimit, now };
}

const defaultQueue = createProviderQueue({
  concurrency: Number.parseInt(process.env.AI_PROVIDER_CONCURRENCY || '2', 10) || 2,
});

export function getDefaultProviderQueue() {
  return defaultQueue;
}
