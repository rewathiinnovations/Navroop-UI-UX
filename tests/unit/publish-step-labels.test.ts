import { describe, expect, it } from 'vitest';

import { DEFAULT_DEPLOY_BRANCH } from '@/lib/publish/constants.ts';
import { PUBLISH_STEPPER, PUBLISH_STEPS, stepLabel, stepperIndex } from '@/lib/publish/steps.ts';

/**
 * F-253, first half: three pairs of the ten publish steps shared a label — `files`/`slug`
 * ("Preparing files"), `dns`/`domain` ("Connecting the domain") and `deploy`/`poll` ("Build
 * in progress"). Collapsing them is deliberate in the sheet's six-row stepper, but the raw
 * per-step labels are persisted onto `GenerationJob.steps` and `RecoveryPanel` renders all
 * ten of them as a list. So a failure while claiming the address was reported as "Preparing
 * files", the previous step's name, and the recovery list printed three lines twice.
 *
 * The stepper still collapses; the underlying steps now each name themselves.
 *
 * Goes red if two steps share a label again, if a stepper row stops covering the step keys
 * it claims, or if a step key drops out of the stepper entirely (which is how a step becomes
 * invisible in the sheet).
 */

describe('publish step labels', () => {
  it('gives every step a label of its own', () => {
    const labels = PUBLISH_STEPS.map((step) => step.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('names the step that actually failed, not its predecessor', () => {
    expect(stepLabel('slug')).not.toBe(stepLabel('files'));
    expect(stepLabel('domain')).not.toBe(stepLabel('dns'));
    expect(stepLabel('poll')).not.toBe(stepLabel('deploy'));
  });

  it('still falls back to a sentence for a key it does not know', () => {
    expect(stepLabel('not-a-step')).toBe('Publishing');
    expect(stepLabel(null)).toBe('Publishing');
  });

  it('keeps every step inside exactly one stepper row', () => {
    const covered = PUBLISH_STEPPER.flatMap((row) => row.keys);
    expect(new Set(covered).size).toBe(covered.length);
    expect([...covered].sort()).toEqual(PUBLISH_STEPS.map((step) => step.key).sort());
  });

  it('maps each step to its stepper row', () => {
    expect(stepperIndex('slug')).toBe(0);
    expect(stepperIndex('github')).toBe(1);
    expect(stepperIndex('domain')).toBe(3);
    expect(stepperIndex('poll')).toBe(4);
    expect(stepperIndex('live')).toBe(5);
  });

  it('keeps the collapsed stepper labels the sheet shows', () => {
    expect(PUBLISH_STEPPER.map((row) => row.label)).toEqual([
      'Preparing files',
      'Sending code to GitHub',
      'Creating the app on the server',
      'Connecting the domain',
      'Build in progress',
      'Site is live',
    ]);
  });
});

describe('the deploy branch has one source', () => {
  it('is a shared constant, so Coolify and the push cannot be told different branches', () => {
    expect(DEFAULT_DEPLOY_BRANCH).toBe('main');
  });
});
