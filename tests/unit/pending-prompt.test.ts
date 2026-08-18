import { describe, expect, it } from 'vitest';
import {
  countFirstBuilds,
  decidePendingPromptAction,
} from '../../lib/projects/pending-prompt';

describe('pending prompt during PLANNING', () => {
  it('does not start a build from the pending prompt', () => {
    expect(decidePendingPromptAction({ phase: 'PLANNING', prompt: 'A landing page for a bakery' })).toEqual({
      kind: 'show',
      text: 'A landing page for a bakery',
    });
  });

  it('starts exactly one first build when the user then approves', () => {
    expect(countFirstBuilds({ pendingPhase: 'PLANNING', approved: true })).toBe(1);
  });

  it('starts a build from the pending prompt only on the skip-planning path', () => {
    expect(decidePendingPromptAction({ phase: 'BUILDING', prompt: 'Skip the plan' })).toEqual({
      kind: 'send',
      text: 'Skip the plan',
    });
    expect(countFirstBuilds({ pendingPhase: 'BUILDING', approved: false })).toBe(1);
  });

  it('does not send a leftover prompt on an already-complete project', () => {
    expect(decidePendingPromptAction({ phase: 'COMPLETE', prompt: 'Already built' }).kind).toBe('show');
    expect(countFirstBuilds({ pendingPhase: 'COMPLETE', approved: false })).toBe(0);
  });

  it('ignores a blank pending prompt', () => {
    expect(decidePendingPromptAction({ phase: 'BUILDING', prompt: '   ' })).toEqual({ kind: 'none' });
  });
});
