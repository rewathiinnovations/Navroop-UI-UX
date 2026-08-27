/**
 * The header must not claim a save that never happened.
 *
 * Observed live: the header read "Last saved 8 minutes ago" for a project
 * whose `lastCode` was empty and which had zero checkpoints — that timestamp
 * was `Project.updatedAt` moving because boot-reconcile abandoned a dead job,
 * not evidence anything was ever saved. `ProjectWorkspace` already derives
 * `hasStoredFiles` from the project's stored files; `saveLabel` must reuse
 * that instead of trusting `updatedAt` alone.
 *
 * `hasStoredFiles` alone isn't a safe gate either: `useProjectFiles` starts
 * it `false` while the files fetch is in flight, and it stays `false`
 * forever if that fetch errors — neither state means the project has no
 * saved content. `saveLabel` takes a fourth argument, `filesKnown` (true
 * only once the files fetch has resolved successfully), so it can tell
 * "known empty" apart from "don't know yet" and only suppress the label in
 * the former case.
 *
 * `WorkspaceTopBar` itself pulls in `pushProjectToGitHub`, a server action
 * whose dependency chain (prisma/next-auth) does not resolve under this
 * harness (the same reason `GenerationCodeView` was split out as a pure
 * component, per its test) — so this exercises the exported `saveLabel`
 * helper directly rather than rendering the component.
 */
import { describe, expect, it, vi } from 'vitest';

// `WorkspaceTopBar` imports the `pushProjectToGitHub` server action, whose
// dependency chain (prisma/next-auth) does not resolve under this harness —
// the established repo pattern (see e.g. tests/unit/project-write-authz.test.ts)
// is to stub the module rather than let it pull in `next-auth`.
vi.mock('@/lib/github/actions', () => ({ pushProjectToGitHub: vi.fn() }));

const { saveLabel } = await import('@/components/workspace/WorkspaceTopBar');

const UPDATED_AT = new Date(Date.now() - 8 * 60_000).toISOString();

describe('WorkspaceTopBar saveLabel', () => {
  it('shows no "Last saved" label when the project is known to have no stored files', () => {
    // Known-empty: the files fetch resolved and found nothing.
    expect(saveLabel('idle', UPDATED_AT, false, true)).toBeNull();
  });

  it('keeps the "Last saved" label, unchanged, for a project known to have stored files', () => {
    // Known-has-content: the files fetch resolved and found files.
    expect(saveLabel('idle', UPDATED_AT, true, true)).toBe('Last saved 8 minutes ago');
  });

  it('keeps the "Last saved" label while it is not yet known whether the project has stored files', () => {
    // Not-yet-known: the files fetch is still in flight (or errored), so
    // `hasStoredFiles` is `false` but untrustworthy — must not be read as
    // "known empty". This must behave exactly as it did before Task 3, i.e.
    // the label must not be suppressed.
    expect(saveLabel('idle', UPDATED_AT, false, false)).toBe('Last saved 8 minutes ago');
  });

  it('still shows "Saving…" while a save is in flight, regardless of stored files', () => {
    expect(saveLabel('saving', UPDATED_AT, false, true)).toBe('Saving…');
  });

  it('still shows "All changes saved" once saved, regardless of stored files', () => {
    expect(saveLabel('saved', UPDATED_AT, false, true)).toBe('All changes saved');
  });

  it('still prompts sign-in over any save claim, regardless of stored files', () => {
    expect(saveLabel('signin', UPDATED_AT, false, true)).toBe('Sign in to save');
  });

  it('returns null with no timestamp, as before', () => {
    expect(saveLabel('idle', null, true, true)).toBeNull();
  });
});
