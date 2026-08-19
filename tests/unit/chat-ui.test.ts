import { describe, expect, it } from 'vitest';
import {
  chatPlaceholder,
  isChatBuilding,
  isChatLocked,
  showsChatRecovery,
} from '../../lib/jobs/chat-ui';
import type { JobKind } from '../../lib/jobs/types';

const JOB_KINDS: JobKind[] = [
  'PLAN',
  'BUILD',
  'FOLLOWUP',
  'IMPORT',
  'AUDIT',
  'PUBLISH',
  'DOMAIN_VERIFY',
  'EXPORT',
  'TEMPLATE_THUMBNAIL',
];

describe('isChatBuilding follows the latest job, not Project.phase', () => {
  it.each(['ABANDONED', 'FAILED', 'CANCELLED', 'SUCCEEDED'] as const)(
    'unlocks when the latest job is %s even if phase is BUILDING',
    (jobStatus) => {
      expect(isChatBuilding({ phase: 'BUILDING', jobStatus })).toBe(false);
      expect(isChatLocked({ sending: true, phase: 'BUILDING', jobStatus })).toBe(false);
    },
  );

  it('stays locked while the latest job is QUEUED or RUNNING', () => {
    expect(isChatBuilding({ phase: 'COMPLETE', jobStatus: 'QUEUED' })).toBe(true);
    expect(isChatBuilding({ phase: 'PLANNING', jobStatus: 'RUNNING' })).toBe(true);
    expect(isChatLocked({ phase: 'COMPLETE', jobStatus: 'RUNNING' })).toBe(true);
  });

  it('does not treat a stale BUILDING phase with no job as building', () => {
    expect(isChatBuilding({ phase: 'BUILDING' })).toBe(false);
    expect(isChatBuilding({ phase: 'BUILDING', jobStatus: null })).toBe(false);
    expect(isChatLocked({ sending: false, phase: 'BUILDING' })).toBe(false);
    expect(chatPlaceholder({ phase: 'BUILDING' })).toBe('Ask Navroop…');
  });
});

describe('chat recovery panel visibility', () => {
  it('shows the panel for plan, build, follow-up, and import only', () => {
    expect(JOB_KINDS.filter(showsChatRecovery)).toEqual(['PLAN', 'BUILD', 'FOLLOWUP', 'IMPORT']);
  });

  it('hides the panel for publish, audit, domain, export, and thumbnail jobs', () => {
    for (const kind of [
      'PUBLISH',
      'AUDIT',
      'DOMAIN_VERIFY',
      'EXPORT',
      'TEMPLATE_THUMBNAIL',
    ] as const) {
      expect(showsChatRecovery(kind), `${kind} must not open the chat recovery panel`).toBe(false);
    }
  });

  it('still unlocks chat when a hidden-kind job is FAILED or ABANDONED', () => {
    for (const kind of ['PUBLISH', 'AUDIT', 'EXPORT'] as const) {
      expect(showsChatRecovery(kind)).toBe(false);
      expect(isChatBuilding({ phase: 'BUILDING', jobStatus: 'FAILED' })).toBe(false);
      expect(isChatLocked({ sending: true, phase: 'BUILDING', jobStatus: 'FAILED' })).toBe(false);
      expect(isChatLocked({ sending: true, phase: 'BUILDING', jobStatus: 'ABANDONED' })).toBe(
        false,
      );
      expect(isChatLocked({ sending: true, phase: 'BUILDING', jobStatus: 'CANCELLED' })).toBe(
        false,
      );
    }
  });
});
