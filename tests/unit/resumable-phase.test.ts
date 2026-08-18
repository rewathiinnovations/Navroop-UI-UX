import { describe, expect, it } from 'vitest';
import { resumablePhaseFromEvidence } from '../../lib/jobs/resumable-phase';

describe('resolveResumablePhase evidence', () => {
  it('resumes to PLANNING when the first plan never generated and nothing was built', () => {
    expect(resumablePhaseFromEvidence({})).toBe('PLANNING');
    expect(
      resumablePhaseFromEvidence({
        filesWritten: 0,
        hasLastCode: false,
        checkpointCount: 0,
        hasActivePlan: false,
      }),
    ).toBe('PLANNING');
  });

  it('stays PLANNING when a plan is pending and there is still no site', () => {
    expect(resumablePhaseFromEvidence({ hasActivePlan: true })).toBe('PLANNING');
  });

  it('resumes to COMPLETE when a finished site exists and a follow-up plan was discarded', () => {
    expect(resumablePhaseFromEvidence({ hasLastCode: true, hasActivePlan: false })).toBe('COMPLETE');
    expect(resumablePhaseFromEvidence({ checkpointCount: 1, hasActivePlan: false })).toBe('COMPLETE');
    expect(resumablePhaseFromEvidence({ filesWritten: 4, hasActivePlan: false })).toBe('COMPLETE');
  });
});
