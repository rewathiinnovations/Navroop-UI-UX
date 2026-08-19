/**
 * A watchdog stop must not outlive the job it judged.
 *
 * Live incident: a follow-up was watched, the client watchdog stopped, and the
 * chat opened "Previous generation stopped". Because the stop also switches
 * polling off (`shouldPoll` requires `!clientStop`), nothing in the hook could
 * observe anything afterwards. A later repair job — started by the preview's own
 * "Fix this" button, and verified running with a healthy 10-second-old heartbeat
 * — therefore ran to completion behind a locked input with no progress line, and
 * the chat kept reporting the *previous* job's verdict.
 */
import { describe, expect, it } from 'vitest';
import { watchdogStopIsStale } from '@/lib/jobs/poll';

describe('watchdogStopIsStale', () => {
  it('drops the verdict once the server reports a different job', () => {
    expect(
      watchdogStopIsStale({ stop: 'stale_heartbeat', stoppedJobId: 'job_1', jobId: 'job_2' }),
    ).toBe(true);
  });

  it('keeps the verdict while it still describes the job on screen', () => {
    expect(
      watchdogStopIsStale({ stop: 'stale_heartbeat', stoppedJobId: 'job_1', jobId: 'job_1' }),
    ).toBe(false);
  });

  it('drops the verdict when a generation is streaming in this tab', () => {
    // The id may not have arrived yet — polling is off, so the stream is the
    // only evidence available, and it is conclusive.
    expect(
      watchdogStopIsStale({
        stop: 'timeout',
        stoppedJobId: 'job_1',
        jobId: 'job_1',
        isJobActive: true,
      }),
    ).toBe(true);
  });

  it('has nothing to drop when no stop is set', () => {
    expect(watchdogStopIsStale({ stop: null, stoppedJobId: null, jobId: 'job_2' })).toBe(false);
    expect(watchdogStopIsStale({ stop: null, stoppedJobId: null, isJobActive: true })).toBe(false);
  });

  it('does not treat a missing job id as newer work', () => {
    // A failed poll returns null; absence of a job is not evidence of a new one,
    // and clearing here would restart polling in a loop.
    expect(watchdogStopIsStale({ stop: 'timeout', stoppedJobId: 'job_1', jobId: null })).toBe(
      false,
    );
    expect(watchdogStopIsStale({ stop: 'timeout', stoppedJobId: null, jobId: undefined })).toBe(
      false,
    );
  });
});
