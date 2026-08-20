import { channel } from 'node:diagnostics_channel';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allowLocalhost } from '../setup/network-guard';

/**
 * What a redeploy is allowed to cost.
 *
 * The SIGTERM handler exists to make a deploy honest: mark this instance's in-flight jobs
 * `deploying` so the workspace recovery panel appears at once instead of after a 60-second
 * stale heartbeat. Two ways it got that wrong, and this suite holds both.
 *
 * It awaited `abandonInstanceJobs` with no deadline, and that function writes one row per job
 * serially — so when Postgres was the reason for the restart, or merely slow, the await never
 * settled, the exit was never reached, and the container sat there until Docker's SIGKILL. The
 * jobs then stayed RUNNING under a dead instance and only surfaced a minute later through
 * `reap-jobs`, which is the frozen-generation symptom draining exists to prevent — paid for with
 * a stuck deploy.
 *
 * Then, with that bounded, it called `process.exit(0)` in a `finally` the moment the row writes
 * finished — usually within milliseconds. Nothing closed or waited for the HTTP listener, so
 * every in-flight request died at the socket, including the SSE generation stream, which is a
 * long-lived response by design (F-747). And exit code 0 claimed a clean shutdown even when the
 * drain had timed out or thrown.
 *
 * Goes red if the drain becomes unbounded again, if a drain error or a timeout stops the process
 * from exiting, if the jobs stop being marked recoverable, if SIGINT loses its handler, if the
 * exit stops waiting for the listener, or if a truncated shutdown starts reporting success.
 */

const lifecycle = vi.hoisted(() => ({ abandonInstanceJobs: vi.fn() }));

vi.mock('@/lib/jobs/lifecycle', () => ({ abandonInstanceJobs: lifecycle.abandonInstanceJobs }));

const SIGNALS = ['SIGTERM', 'SIGINT'] as const;
const REQUEST_START = 'http.server.request.start';

let exit: MockInstance<(code?: number) => never>;
let before: Record<string, unknown[]>;

/**
 * The listener is invoked directly rather than through `process.emit`, because emitting a real
 * signal in the worker would also run Vitest's own handlers and take the run down with it.
 */
function listenerFor(signal: (typeof SIGNALS)[number]) {
  const added = process.listeners(signal).filter((fn) => !before[signal].includes(fn));
  expect(added, `${signal} has no handler`).toHaveLength(1);
  return added[0] as () => void;
}

type FakeServer = {
  listening: boolean;
  close: MockInstance<() => void>;
  closeIdleConnections: MockInstance<() => void>;
  once: (event: 'close', fn: () => void) => void;
  /** Ends the last connection, the way Node fires 'close' once every socket has finished. */
  finishDraining: () => void;
};

function fakeServer(listening = true): FakeServer {
  const onClose: (() => void)[] = [];
  return {
    listening,
    close: vi.fn(() => undefined),
    closeIdleConnections: vi.fn(() => undefined),
    once: (_event, fn) => void onClose.push(fn),
    finishDraining: () => {
      for (const fn of onClose.splice(0)) fn();
    },
  };
}

/**
 * The production capture path: Node publishes this on every request with the `http.Server` that
 * accepted it, which is the only handle the drain can get — Next creates the listener before the
 * instrumentation that wires the drain ever loads. Publishing here is what a request does.
 */
function serveOneRequest(message: Record<string, unknown>) {
  channel(REQUEST_START).publish(message);
}

async function wire() {
  vi.resetModules();
  const { wireShutdownDrain } = await import('@/lib/runtime/shutdown');
  wireShutdownDrain();
}

/**
 * Lets the drain's pending awaits run to completion. `setImmediate` rather than a duration:
 * the wait is for the microtask and I/O queues to empty, not for any amount of wall clock.
 */
function settle() {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(() => resolve());
  return promise;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  before = Object.fromEntries(SIGNALS.map((signal) => [signal, [...process.listeners(signal)]]));
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

afterEach(() => {
  // Every listener this file added is removed again: a leaked handler would call
  // `process.exit` for real the next time anything signals the worker.
  for (const signal of SIGNALS) {
    for (const fn of process.listeners(signal)) {
      if (!before[signal].includes(fn)) process.off(signal, fn as never);
    }
  }
  exit.mockRestore();
  vi.useRealTimers();
});

describe('the shutdown drain', () => {
  it('marks this instance\u2019s jobs recoverable and then exits', async () => {
    lifecycle.abandonInstanceJobs.mockResolvedValue(3);
    await wire();

    listenerFor('SIGTERM')();
    await vi.advanceTimersByTimeAsync(0);

    // `deploying` is the reason the recovery panel shows "the server is deploying" rather than
    // an unexplained abandoned job.
    expect(lifecycle.abandonInstanceJobs).toHaveBeenCalledWith('deploying');
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits on a drain that never settles, instead of waiting for SIGKILL', async () => {
    // Resolvers are captured and never called: this is the slow-Postgres case.
    lifecycle.abandonInstanceJobs.mockReturnValue(Promise.withResolvers<number>().promise);
    await wire();

    listenerFor('SIGTERM')();
    await vi.advanceTimersByTimeAsync(1_000);
    // Still draining: the deadline is a backstop, not a race the drain usually loses.
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    // Non-zero: the jobs were not marked, so this shutdown was truncated and the deploy log
    // should say so rather than report success.
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits when the drain throws, because the jobs are recoverable either way', async () => {
    lifecycle.abandonInstanceJobs.mockRejectedValue(new Error('connection terminated'));
    await wire();

    listenerFor('SIGTERM')();
    await vi.advanceTimersByTimeAsync(0);

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('drains on SIGINT too, so a local Ctrl-C leaves the same recoverable state', async () => {
    lifecycle.abandonInstanceJobs.mockResolvedValue(1);
    await wire();

    listenerFor('SIGINT')();
    await vi.advanceTimersByTimeAsync(0);

    expect(lifecycle.abandonInstanceJobs).toHaveBeenCalledWith('deploying');
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('wires each signal once, however many times it is called', async () => {
    lifecycle.abandonInstanceJobs.mockResolvedValue(0);
    vi.resetModules();
    const { wireShutdownDrain } = await import('@/lib/runtime/shutdown');
    wireShutdownDrain();
    wireShutdownDrain();

    // A second registration would drain and exit twice per signal.
    for (const signal of SIGNALS) listenerFor(signal);
  });

  it('waits for the in-flight requests before exiting', async () => {
    lifecycle.abandonInstanceJobs.mockResolvedValue(2);
    const server = fakeServer();
    await wire();
    serveOneRequest({ server, socket: {}, request: {}, response: {} });

    listenerFor('SIGTERM')();
    await vi.advanceTimersByTimeAsync(0);

    // The jobs are already marked, which is all the old handler waited for. The stream this
    // process is still writing is the reason it may not exit yet.
    expect(lifecycle.abandonInstanceJobs).toHaveBeenCalledWith('deploying');
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(exit).not.toHaveBeenCalled();

    server.finishDraining();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('gives up on a listener that will not drain, inside Docker\u2019s grace period', async () => {
    lifecycle.abandonInstanceJobs.mockResolvedValue(1);
    const server = fakeServer();
    await wire();
    serveOneRequest({ server, socket: {}, request: {}, response: {} });

    listenerFor('SIGTERM')();
    // Docker's default grace is ten seconds; the whole budget has to land inside it.
    await vi.advanceTimersByTimeAsync(9_000);

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('takes the listener from the socket when the message has no server field', async () => {
    // Older Node runtimes publish `http.server.request.start` without `server`; the socket a
    // net.Server accepted has always carried `.server`.
    lifecycle.abandonInstanceJobs.mockResolvedValue(0);
    const server = fakeServer();
    await wire();
    serveOneRequest({ socket: { server }, request: {}, response: {} });

    listenerFor('SIGTERM')();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).not.toHaveBeenCalled();

    server.finishDraining();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('stops accepting new connections when nothing else has closed the listener', async () => {
    // Next's own cleanup closes it first in production. With `NEXT_MANUAL_SIG_HANDLE`, or a
    // custom server, nobody does — and a draining process must not keep taking work.
    lifecycle.abandonInstanceJobs.mockResolvedValue(0);
    const stillOpen = fakeServer(true);
    await wire();
    serveOneRequest({ server: stillOpen, socket: {}, request: {}, response: {} });

    listenerFor('SIGTERM')();
    await vi.advanceTimersByTimeAsync(0);

    expect(stillOpen.close).toHaveBeenCalled();
    expect(stillOpen.closeIdleConnections).toHaveBeenCalled();
  });

  it('does not close a listener Next has already closed', async () => {
    lifecycle.abandonInstanceJobs.mockResolvedValue(0);
    const closing = fakeServer(false);
    await wire();
    serveOneRequest({ server: closing, socket: {}, request: {}, response: {} });

    listenerFor('SIGTERM')();
    await vi.advanceTimersByTimeAsync(0);

    // A second `close()` on a closing server calls back with ERR_SERVER_NOT_RUNNING, which
    // Next logs — one confusing error line on every single redeploy.
    expect(closing.close).not.toHaveBeenCalled();
  });

  it('exits immediately when no request was ever served on this instance', async () => {
    // Nothing published on the channel, so there is no listener and nothing holding a
    // connection open: waiting out the budget would only slow the deploy down.
    lifecycle.abandonInstanceJobs.mockResolvedValue(0);
    await wire();

    listenerFor('SIGTERM')();
    await vi.advanceTimersByTimeAsync(0);

    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe('the shutdown drain against a real http.Server', () => {
  it('captures Node\u2019s own listener and holds the exit until the response ends', async () => {
    // Everything above drives the capture with a double. This is the assumption underneath it:
    // that Node really does publish the accepting `http.Server` on
    // `http.server.request.start`, and that `close()` on it really does stay pending until the
    // last response finishes. Next creates the listener before this instrumentation loads, so
    // that channel is the only handle the drain can ever get — if it is wrong, the drain is
    // silently back to cutting streams at the socket.
    vi.useRealTimers();
    allowLocalhost('the drain must be proved against Node\u2019s http.Server, not a double');
    lifecycle.abandonInstanceJobs.mockResolvedValue(0);
    await wire();

    const finish = Promise.withResolvers<void>();
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      // Headers and a first chunk, body still open: an SSE generation stream in miniature.
      response.write('streaming');
      void finish.promise.then(() => response.end('done'));
    });
    // The drain's own 'close' listener was registered first, at capture time, so by the time
    // this one runs the drain has already been told the listener finished.
    const closed = Promise.withResolvers<void>();
    server.once('close', () => closed.resolve());
    const listening = Promise.withResolvers<void>();
    try {
      server.listen(0, '127.0.0.1', () => listening.resolve());
      await listening.promise;
      const { port } = server.address() as AddressInfo;
      // `connection: close` so the client socket ends with the body. A keep-alive socket sits
      // idle for seconds after the response, and the whole point of the assertion below is
      // that the listener closes once the last *request* is done.
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { connection: 'close' },
      });

      listenerFor('SIGTERM')();
      // No wait: the handler closes the listener synchronously, before its first await.
      expect(server.listening).toBe(false);
      expect(exit).not.toHaveBeenCalled();
      await settle();
      // The jobs are marked and the listener takes no new connections, but this request is
      // still being written, so the process must still be alive.
      expect(lifecycle.abandonInstanceJobs).toHaveBeenCalledWith('deploying');
      expect(exit).not.toHaveBeenCalled();

      finish.resolve();
      expect(await response.text()).toBe('streamingdone');
      await closed.promise;
      await settle();
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      finish.resolve();
      server.closeAllConnections();
      server.close();
    }
  });
});
