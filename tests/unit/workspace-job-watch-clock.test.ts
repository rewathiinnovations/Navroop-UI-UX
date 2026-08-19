import { describe, expect, it } from 'vitest';
import { watchStartedAtMs } from '@/components/workspace/useGenerationJob';
import { CLIENT_POLL_CEILING_MS } from '@/lib/jobs/poll';

/**
 * The client poll ceiling stops watching a build after 25 minutes and opens the
 * recovery panel. It used to be measured from a `startedAtRef` set on the first
 * poll of the mount and never cleared — the age of the *workspace*, not of the
 * build. A tab left open for half an hour (ordinary in a builder) therefore hit
 * the ceiling on the first poll after the next message and reported a timeout on
 * a build one second old. The QUEUED branch made that the only guard queued
 * builds have, so the false verdict was reachable on work that had not started.
 */
describe('watchStartedAtMs', () => {
  const now = new Date('2026-08-19T12:00:00.000Z').getTime();
  const halfAnHourAgo = now - 30 * 60_000;

  it('times a fresh build from the build, not from a long-open workspace', () => {
    const clock = watchStartedAtMs(
      { startedAt: null, createdAt: new Date(now - 1_000).toISOString() },
      halfAnHourAgo,
    );
    expect(now - clock).toBeLessThan(CLIENT_POLL_CEILING_MS);
  });

  it('does not time out a retry of a row that was created hours ago', () => {
    // `act` stamps the watch when a recovery call succeeds; the retried row keeps
    // its original createdAt, so reading the row alone would expire the build
    // before it ran.
    const clock = watchStartedAtMs(
      { startedAt: null, createdAt: new Date(now - 4 * 60 * 60_000).toISOString() },
      now,
    );
    expect(clock).toBe(now);
  });

  it('uses the job row when polling armed before the row existed', () => {
    // Phase BUILDING arms the poll; the job row lands a few seconds later. Its
    // own start is then the honest clock.
    const startedAt = new Date(now - 5_000).toISOString();
    expect(
      watchStartedAtMs({ startedAt, createdAt: new Date(now - 9_000).toISOString() }, now - 20_000),
    ).toBe(new Date(startedAt).getTime());
  });

  it('falls back to the watch when the job has no usable timestamps', () => {
    expect(watchStartedAtMs(null, now)).toBe(now);
    expect(watchStartedAtMs(undefined, now)).toBe(now);
    expect(watchStartedAtMs({ startedAt: null, createdAt: 'not a date' }, now)).toBe(now);
  });

  it('still lets a genuinely long build reach the ceiling', () => {
    const clock = watchStartedAtMs(
      {
        startedAt: new Date(now - 26 * 60_000).toISOString(),
        createdAt: new Date(now - 27 * 60_000).toISOString(),
      },
      now - 26 * 60_000,
    );
    expect(now - clock).toBeGreaterThanOrEqual(CLIENT_POLL_CEILING_MS);
  });
});
