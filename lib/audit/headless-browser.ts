import { createServer } from 'node:net';
import { chromium, type Browser } from 'playwright';

/**
 * The one way audit code forks Chromium.
 *
 * Every browser run goes through a single-slot queue, so no two run at once
 * anywhere in the process. Before this, a code audit launched two Chromium
 * instances concurrently and an SEO audit a third, with no limit across audits —
 * the most likely OOM in the product, and one that takes the whole serving
 * container down rather than just the audit. Two concurrent SEO audits could
 * also pick the same random `--remote-debugging-port` and attach Lighthouse to
 * the *other* audit's browser, scoring the wrong page (F-751).
 *
 * Serialising also makes the debugging port safe to hand out: it is bound from
 * an ephemeral socket and read back rather than guessed, and nothing else in
 * this process holds a browser while a run is in flight.
 *
 * Two things this deliberately does NOT change, both out of scope for a bounded
 * fix and noted so they are not mistaken for oversights:
 *  - `--no-sandbox` stays. Removing it makes Chromium refuse to start in the
 *    containers this runs in (no user-namespace / seccomp profile). Rendering
 *    generated content without the renderer sandbox is a real risk; the fix is a
 *    hardened container or a dedicated worker, not dropping the flag here.
 *  - The browser still runs in the serving process. Moving it to a dedicated
 *    worker is the right home for something that forks Chromium, but that is an
 *    architectural change, not a bounded one.
 */

/** No browser run — launch, navigation, Lighthouse — may outlast this. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Serialises every run; a failure never breaks the chain for the next caller. */
let queue: Promise<unknown> = Promise.resolve();

export type HeadlessBrowserContext = {
  browser: Browser;
  /** The CDP port, when `debugPort` was requested; null otherwise. */
  debugPort: number | null;
};

export type HeadlessBrowserOptions = {
  /** Bind and pass a real debugging port — Lighthouse attaches over it. */
  debugPort?: boolean;
  timeoutMs?: number;
};

/** An OS-assigned free TCP port, so no two runs collide on a guessed one. */
async function freeDebugPort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (typeof address !== 'object' || address === null) {
      server.close(() => reject(new Error('could not read an ephemeral port')));
      return;
    }
    const { port } = address;
    server.close((error) => (error ? reject(error) : resolve(port)));
  });
  return promise;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const { promise: timeout, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  timer.unref?.();
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs `task` with a headless Chromium, one at a time, bounded by a timeout, and
 * always closed afterwards. The browser and any debugging port are handed to the
 * task; nothing else may launch a browser directly.
 */
export async function withHeadlessBrowser<T>(
  task: (context: HeadlessBrowserContext) => Promise<T>,
  options: HeadlessBrowserOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const run = queue.then(async () => {
    const debugPort = options.debugPort ? await freeDebugPort() : null;
    const args = ['--no-sandbox'];
    if (debugPort !== null) args.push(`--remote-debugging-port=${debugPort}`);
    let browser: Browser | null = null;
    try {
      browser = await withTimeout(
        chromium.launch({ headless: true, args }),
        timeoutMs,
        'chromium.launch',
      );
      return await withTimeout(task({ browser, debugPort }), timeoutMs, 'headless browser run');
    } finally {
      // A Chromium we failed to close stays resident — never silent.
      await browser?.close().catch((error) => {
        console.warn('[audit] headless browser close failed', error);
      });
    }
  });
  // The next caller waits on this run's completion, not its result: one audit's
  // failure must not reject the queue for the audit behind it.
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
