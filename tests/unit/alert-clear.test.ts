import '../setup/data-dir-guard';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { maybeAlertLowSpace, runTmpSweep, type DataDirStatus } from '@/lib/runtime/data-dir';

/**
 * Clearing an "alert already sent" flag used to be `delete(...).catch(() => undefined)`, which
 * hid two very different things: the ordinary not-found (no alert was ever sent) and a real
 * write failure. The second one matters, because the flag is what suppresses repeat emails — if
 * it stays set, no further low-disk email is ever sent and nobody is told.
 */

let errors: string[];
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errors = [];
  errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  });
});

afterEach(() => {
  errorSpy.mockRestore();
});

const healthy: DataDirStatus = {
  checked: true,
  path: '/data',
  writable: true,
  error: null,
  volumeId: 'vol',
  volumeCreatedAt: null,
  volumeChanged: false,
  previousVolumeId: null,
  freeBytes: 900,
  totalBytes: 1000,
  freeRatio: 0.9,
  warnLowSpace: false,
  alertLowSpace: false,
};

describe('low-space alert flag', () => {
  it('clears quietly when there is nothing to alert about', async () => {
    const result = await maybeAlertLowSpace({
      status: healthy,
      setAlerted: async () => undefined,
    });
    expect(result).toEqual({ sent: false });
    expect(errors).toEqual([]);
  });

  it('reports and logs when the flag cannot be cleared', async () => {
    const result = await maybeAlertLowSpace({
      status: healthy,
      setAlerted: async () => {
        throw new Error('database is down');
      },
    });

    // Reported upward, not swallowed: a flag stuck at "already sent" silences every later email.
    expect(result).toMatchObject({ sent: false, alertFlagStale: true });
    expect(errors.join(' ')).toContain('could not clear the low-space alert flag');
    expect(errors.join(' ')).toContain('database is down');
  });
});

describe('runTmpSweep', () => {
  const identity = async () => ({ changed: false as const, previousId: null, currentId: 'vol' });

  it('reports ok when both alerting steps succeed', async () => {
    const result = await runTmpSweep({
      identity,
      alert: async () => ({ sent: false as const }),
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('reports not ok when the low-space email throws', async () => {
    const result = await runTmpSweep({
      identity,
      alert: async () => {
        throw new Error('smtp unreachable');
      },
    });

    // handleCron turns ok:false into a 500 and a failed CronRun row. The old version returned
    // ok:true here, so a volume filling up looked like a clean hourly sweep.
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('smtp unreachable');
    expect(errors.join(' ')).toContain('low-space alert failed');
  });

  it('reports not ok when the volume-changed warning throws', async () => {
    const result = await runTmpSweep({
      identity: async () => {
        throw new Error('cannot read volume id');
      },
      alert: async () => ({ sent: false as const }),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('cannot read volume id');
  });

  it('reports not ok when the alert flag is stuck, because a later email would be suppressed', async () => {
    const result = await runTmpSweep({
      identity,
      alert: async () => ({ sent: false as const, alertFlagStale: true as const, error: 'write failed' }),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('suppressed');
  });
});
