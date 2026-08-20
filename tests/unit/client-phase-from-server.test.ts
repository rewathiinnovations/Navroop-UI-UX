import { describe, expect, it } from 'vitest';
import { phaseFromPoll } from '../../components/workspace/useProjectPlan';
import { resumablePhaseFromEvidence } from '../../lib/jobs/resumable-phase';

/**
 * The workspace does not decide whether a project has a site.
 *
 * `useProjectPlan` used to promote BUILDING to COMPLETE on two client-side rules: the
 * latest job is ABANDONED / FAILED / CANCELLED, or `generationStatus === 'ready'`.
 * Neither consults `lastCode` or checkpoints, so a first build that failed with zero
 * files showed as a finished project: the PLANNING gate and the plan card disappeared,
 * the preview claimed there was something to show, and the next message was treated as
 * an edit. A reload corrected it, because the server never agreed (F-048).
 *
 * The server settles phase from evidence — `resumablePhaseFromEvidence`, reached from
 * `failJob` / `abandonJob` via `resolveResumablePhase` — so the only correct client rule
 * is "use what the server said, and re-read if a terminal job means the row we just read
 * was already stale".
 */

describe('phaseFromPoll', () => {
  it('takes the phase the server computed', () => {
    expect(
      phaseFromPoll({ serverPhase: 'COMPLETE', jobStatus: 'SUCCEEDED', localPhase: 'BUILDING' })
        .phase,
    ).toBe('COMPLETE');
  });

  it('does not promote BUILDING to COMPLETE because a job failed', () => {
    const next = phaseFromPoll({
      serverPhase: 'PLANNING',
      jobStatus: 'FAILED',
      localPhase: 'BUILDING',
    });

    // The evidence rule the server applies for exactly this job: no site, so PLANNING.
    expect(resumablePhaseFromEvidence({ filesWritten: 11 })).toBe('PLANNING');
    expect(next.phase).toBe('PLANNING');
  });

  it('does not promote BUILDING to COMPLETE because the row still says BUILDING', () => {
    const next = phaseFromPoll({
      serverPhase: 'BUILDING',
      jobStatus: 'ABANDONED',
      localPhase: 'BUILDING',
    });

    expect(next.phase).toBe('BUILDING');
    // The project row was read before the job row, and the terminal transition writes
    // both — so this reading may predate the server's own phase write. Re-read rather
    // than guess what it will say.
    expect(next.recheck).toBe(true);
  });

  it('does not ask for a re-read once the server has moved off BUILDING', () => {
    expect(
      phaseFromPoll({ serverPhase: 'COMPLETE', jobStatus: 'CANCELLED', localPhase: 'BUILDING' })
        .recheck,
    ).toBe(false);
  });

  it('does not ask for a re-read while the job is still running', () => {
    expect(
      phaseFromPoll({ serverPhase: 'BUILDING', jobStatus: 'RUNNING', localPhase: 'BUILDING' })
        .recheck,
    ).toBe(false);
  });

  it('keeps the last known phase when the project read failed', () => {
    expect(
      phaseFromPoll({ serverPhase: null, jobStatus: 'SUCCEEDED', localPhase: 'BUILDING' }).phase,
    ).toBe('BUILDING');
  });
});
