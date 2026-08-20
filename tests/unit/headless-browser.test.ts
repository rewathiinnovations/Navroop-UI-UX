import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Audit code used to fork Chromium concurrently inside the serving process with
 * no limit, and Lighthouse picked a random debugging port with no collision
 * check and no timeout (F-751). The shared runner serialises every browser run,
 * hands out an OS-assigned port, and bounds each run. These prove the
 * serialisation, the real port, and the timeout without launching a browser.
 */

type LaunchArgs = { headless?: boolean; args?: string[] };

let concurrent = 0;
let maxConcurrent = 0;
const launchArgs: LaunchArgs[] = [];

const launch = vi.fn(async (options: LaunchArgs) => {
  launchArgs.push(options);
  concurrent += 1;
  maxConcurrent = Math.max(maxConcurrent, concurrent);
  return {
    close: async () => {
      concurrent -= 1;
    },
  };
});

vi.mock('playwright', () => ({ chromium: { launch } }));

const { withHeadlessBrowser } = await import('@/lib/audit/headless-browser');

beforeEach(() => {
  launch.mockClear();
  launchArgs.length = 0;
  concurrent = 0;
  maxConcurrent = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('withHeadlessBrowser', () => {
  it('never runs two browsers at once, even when callers overlap', async () => {
    // Three runs started in the same tick. The runner chains each on the previous
    // one's completion, so a launch only happens after the prior browser closed —
    // no timer needed to observe it, and a broken (unchained) impl would launch
    // all three before any close and push maxConcurrent above 1.
    await Promise.all([
      withHeadlessBrowser(async () => undefined),
      withHeadlessBrowser(async () => undefined),
      withHeadlessBrowser(async () => undefined),
    ]);
    expect(launch).toHaveBeenCalledTimes(3);
    expect(maxConcurrent).toBe(1);
    expect(concurrent).toBe(0);
  });

  it('hands out a real OS-assigned debugging port and passes it to Chromium', async () => {
    const port = await withHeadlessBrowser(async ({ debugPort }) => debugPort, {
      debugPort: true,
    });
    expect(typeof port).toBe('number');
    expect(port).toBeGreaterThan(0);
    expect(launchArgs[0].args).toContain(`--remote-debugging-port=${port}`);
  });

  it('omits the debugging port when it was not requested', async () => {
    const port = await withHeadlessBrowser(async ({ debugPort }) => debugPort);
    expect(port).toBeNull();
    expect(launchArgs[0].args?.some((arg) => arg.startsWith('--remote-debugging-port'))).toBe(
      false,
    );
  });

  it('bounds a run with a timeout instead of hanging forever', async () => {
    vi.useFakeTimers();
    try {
      // A run that never settles — a Lighthouse call with no timeout was exactly
      // this, holding an admin request open indefinitely. The clock is advanced
      // deterministically rather than slept through.
      const pending = withHeadlessBrowser(
        () => {
          const { promise } = Promise.withResolvers<never>();
          return promise;
        },
        { timeoutMs: 25 },
      );
      const assertion = expect(pending).rejects.toThrow(/exceeded/);
      await vi.advanceTimersByTimeAsync(30);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed run does not break the queue for the next caller', async () => {
    await expect(
      withHeadlessBrowser(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // The queue is still usable.
    const ok = await withHeadlessBrowser(async () => 'ok');
    expect(ok).toBe('ok');
  });

  it('closes the browser after every run', async () => {
    await withHeadlessBrowser(async () => undefined);
    expect(concurrent).toBe(0);
  });
});

/**
 * `lib/import/capture.ts` is the one other launcher, and it is deliberately not
 * asserted away here: URL import genuinely drives a page, and moving it onto
 * this queue is a behaviour change this test is not the place to make. It is
 * named so the exception is a decision rather than an oversight.
 */
const KNOWN_LAUNCHERS = ['audit/headless-browser.ts', 'import/capture.ts'];

describe('there is only one Chromium launcher per purpose', () => {
  it('no other module under lib/ launches a browser of its own', () => {
    // `lib/checkpoints/thumbnail.ts` did: `chromium.launch()` straight in the
    // serving process, outside this queue and outside its timeout — the
    // unbounded fork F-751 closed. It was also unreachable (F-151):
    // `captureThumbnail` returns null unless `Project.previewUrl` is set, and
    // nothing has written that column since the sandbox subsystem was removed,
    // so every checkpoint got the placeholder gradient. A launcher must not come
    // back through that door.
    const libDir = join(fileURLToPath(new URL('../../', import.meta.url)), 'lib');
    const offenders = readdirSync(libDir, { recursive: true, encoding: 'utf8' })
      .filter((entry) => typeof entry === 'string' && entry.endsWith('.ts'))
      .filter((entry) => !KNOWN_LAUNCHERS.includes(entry.replace(/\\/g, '/')))
      .filter((entry) =>
        /chromium\s*\.\s*launch|\.launchPersistentContext\s*\(/.test(
          readFileSync(join(libDir, entry), 'utf8'),
        ),
      );

    expect(offenders).toEqual([]);
  });
});
