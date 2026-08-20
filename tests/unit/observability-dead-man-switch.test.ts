import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The daily digest is the sender for every other cron's staleness, so it cannot report its
 * own silence: delete its scheduled task, or start answering 500, and every stale cron goes
 * invisible at once while /admin/health stays green. Total silence and total health look
 * identical (F-784).
 *
 * The only mechanism that can distinguish them lives outside this process: the digest pings
 * an external monitor on every run, and the monitor alerting on a *missing* ping is what
 * detects a missed digest. So the two things this file pins are (a) the ping happens on every
 * run — including the healthy run, which is the common case and the one that would otherwise
 * never ping — and (b) a ping that did not leave the building is reported rather than
 * swallowed, because a silently broken ping is the same failure one layer down.
 *
 * Goes red if: the healthy early-return path stops pinging; a failed ping is downgraded to a
 * successful digest run; or a configured monitor URL stops being read.
 */

const settings = vi.hoisted(() => ({ getSetting: vi.fn() }));
const email = vi.hoisted(() => ({ resolveSendAdminEmail: vi.fn() }));
const store = vi.hoisted(() => ({ listLatestCronRunPerName: vi.fn() }));

vi.mock('@/lib/settings/resolve', () => ({ getSetting: settings.getSetting }));

vi.mock('@/lib/observability/alerts', () => ({
  resolveSendAdminEmail: email.resolveSendAdminEmail,
}));

vi.mock('@/lib/observability/store', () => ({
  getObservabilityStore: () => store,
}));

const { pingDeadManSwitch, DEAD_MAN_SETTING_KEY } =
  await import('@/lib/observability/dead-man-switch.ts');
const { sendSystemChecksDigest, SYSTEM_CHECK_JOBS } =
  await import('@/lib/observability/system-checks.ts');

const MONITOR = 'https://hc-ping.com/00000000-0000-0000-0000-000000000000';
const NOW = new Date('2026-08-20T06:00:00.000Z');

function ok() {
  return new Response(null, { status: 200 });
}

/** Every monitored cron ran a minute ago and succeeded: the digest has nothing to say. */
function healthyRuns() {
  return SYSTEM_CHECK_JOBS.map((name, index) => ({
    id: `run_${index}`,
    name,
    ok: true,
    durationMs: 10,
    detail: null,
    createdAt: new Date(NOW.getTime() - 60_000),
  }));
}

beforeEach(() => {
  settings.getSetting.mockReset();
  email.resolveSendAdminEmail.mockReset();
  store.listLatestCronRunPerName.mockReset();
  settings.getSetting.mockResolvedValue(MONITOR);
  email.resolveSendAdminEmail.mockReturnValue(async () => undefined);
  store.listLatestCronRunPerName.mockResolvedValue(healthyRuns());
});

describe('pingDeadManSwitch', () => {
  it('does nothing when no monitor is configured, and says so', async () => {
    settings.getSetting.mockResolvedValue(null);
    const fetchImpl = vi.fn();

    const result = await pingDeadManSwitch({ fetchImpl });

    expect(result.state).toBe('not-configured');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('calls the configured monitor', async () => {
    const fetchImpl = vi.fn(async () => ok());

    const result = await pingDeadManSwitch({ fetchImpl });

    expect(result).toEqual({ state: 'ok', status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(MONITOR);
  });

  it('reports a monitor that answers an error status', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }));

    const result = await pingDeadManSwitch({ fetchImpl });

    expect(result.state).toBe('failed');
    expect(result.state === 'failed' && result.detail).toContain('404');
  });

  it('reports a transport failure instead of throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND hc-ping.com');
    });

    const result = await pingDeadManSwitch({ fetchImpl });

    expect(result.state).toBe('failed');
    expect(result.state === 'failed' && result.detail).toContain('ENOTFOUND');
  });

  it('refuses a configured value that is not an http(s) URL rather than calling it', async () => {
    settings.getSetting.mockResolvedValue('file:///etc/passwd');
    const fetchImpl = vi.fn(async () => ok());

    const result = await pingDeadManSwitch({ fetchImpl });

    expect(result.state).toBe('failed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('names the setting an operator has to fill in', () => {
    expect(DEAD_MAN_SETTING_KEY).toBe('observability.deadManUrl');
  });
});

describe('sendSystemChecksDigest', () => {
  it('pings the monitor on a run with nothing to report — the run that proves it is alive', async () => {
    const fetchImpl = vi.fn(async () => ok());

    const result = await sendSystemChecksDigest({ fetchImpl, now: NOW });

    expect(result.sent).toBe(false);
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.deadMan).toEqual({ state: 'ok', status: 200 });
  });

  it('pings the monitor on a run that found problems', async () => {
    store.listLatestCronRunPerName.mockResolvedValue([]);
    const fetchImpl = vi.fn(async () => ok());

    const result = await sendSystemChecksDigest({
      fetchImpl,
      now: new Date('2026-08-20T00:00:00.000Z'),
    });

    expect(result.sent).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails the run when the ping could not be delivered', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));

    const result = await sendSystemChecksDigest({ fetchImpl, now: NOW });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('monitoring heartbeat');
  });

  it('stays green when no monitor is configured — nothing was promised', async () => {
    settings.getSetting.mockResolvedValue(null);
    const fetchImpl = vi.fn();

    const result = await sendSystemChecksDigest({ fetchImpl, now: NOW });

    expect(result.ok).toBe(true);
    expect(result.deadMan.state).toBe('not-configured');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
