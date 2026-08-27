/**
 * Two defects lived in the same conditional in `PreviewPanel`, both observed on
 * a real project rather than inferred from reading code.
 *
 * 1. `view === 'code'` was missing from the allowlist that lets a tab render its
 *    own children/empty state. On a project still planning (no files yet), the
 *    Code tab fell into the preview-only branch and rendered the preview orb
 *    plus "Approve it and this panel becomes your live site" — preview copy,
 *    under the Code tab.
 * 2. That branch's non-COMPLETE case always reads "Approve it…", even when the
 *    active plan is already `APPROVED` and only reset to PLANNING because
 *    boot-reconcile found an abandoned build. The reader sees an APPROVED badge
 *    in the chat and is told to approve a plan whose Approve control no longer
 *    exists.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import PreviewPanel from '@/components/workspace/PreviewPanel';

const CODE_CHILD_MARKER = 'CODE_VIEW_CHILD_MARKER';

function render(props: Partial<Parameters<typeof PreviewPanel>[0]>) {
  return renderToStaticMarkup(
    createElement(
      PreviewPanel,
      {
        phase: 'PLANNING',
        planTrigger: 'initial',
        hasFiles: false,
        view: 'code',
        ...props,
      },
      createElement('div', null, CODE_CHILD_MARKER),
    ),
  );
}

describe('PreviewPanel empty-state branch', () => {
  it('renders the Code view children instead of the preview empty state while still planning', () => {
    const markup = render({ view: 'code' });

    expect(markup).toContain(CODE_CHILD_MARKER);
    expect(markup).not.toContain('Something cool is on the way');
    expect(markup).not.toContain('Approve it and this panel becomes your live site.');
  });

  it('does not tell an already-approved plan to be approved', () => {
    const markup = render({ view: 'preview', planApproved: true });

    expect(markup).not.toContain('Approve it and this panel becomes your live site.');
    expect(markup).toContain('Something cool is on the way');
    expect(markup).toContain('Try again');
  });

  it('keeps the genuine still-planning copy when the plan has not been approved', () => {
    const markup = render({ view: 'preview', planApproved: false });

    expect(markup).toContain('Approve it and this panel becomes your live site.');
  });
});
