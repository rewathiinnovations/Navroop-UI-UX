import { describe, expect, it } from 'vitest';
import { hasExistingSite, hasStoredSite } from '@/components/workspace/types';

/**
 * Every chat follow-up used to reach /api/generate-ai-code-stream with
 * isEdit:false. Edit-ness was read from conversationContext.appliedCode, and
 * that list stopped growing when applying stopped being a stream (startApply
 * resolves `{ finalData: null }` by design, so the branch that appended to it
 * was dead). The route then printed "FIRST GENERATION MODE", never loaded the
 * project's files, and the model rewrote the whole site instead of changing
 * the one thing the person asked for.
 *
 * The first fix for that read three client-side inputs, all of which can only
 * under-report a site — so it failed OPEN, and the rewrite it was closing came
 * straight back for anyone whose file map did not load. `storedSite` is the
 * fail-closed input; these cases pin the direction.
 */
describe('hasExistingSite', () => {
  it('is false for the first message of a project with no files', () => {
    expect(
      hasExistingSite({
        projectFiles: {},
        streamedFiles: [],
        appliedCode: [],
        // A successful, empty read: the one case that proves there is nothing
        // to change. Only here may the model build from scratch.
        storedSite: false,
      }),
    ).toBe(false);
  });

  it('is true on a reopened project, whose apply history is empty', () => {
    expect(
      hasExistingSite({
        projectFiles: { 'src/App.tsx': 'export default function App() { return null; }' },
        streamedFiles: [],
        // Nothing survives a reload here — this is exactly the case the old
        // appliedCode check answered "fresh build" to.
        appliedCode: [],
        storedSite: false,
      }),
    ).toBe(true);
  });

  it('is true for the turn right after a build, before the file fetch lands', () => {
    expect(
      hasExistingSite({
        projectFiles: {},
        streamedFiles: [{ path: 'src/App.tsx' }],
        appliedCode: [],
        storedSite: false,
      }),
    ).toBe(true);
  });

  it('keeps treating a URL-imported project as an edit', () => {
    expect(
      hasExistingSite({
        projectFiles: {},
        streamedFiles: [],
        appliedCode: [{ files: [], timestamp: new Date() }],
        storedSite: false,
      }),
    ).toBe(true);
  });

  it('is true when the client learned nothing, so a rewrite can never be the fallback', () => {
    expect(
      hasExistingSite({
        projectFiles: {},
        streamedFiles: [],
        appliedCode: [],
        storedSite: true,
      }),
    ).toBe(true);
  });
});

/**
 * `GET /api/projects/[id]/files` answers 403 to any non-owner non-admin, while
 * app/project/[id]/page.tsx renders the workspace for any signed-in member and
 * POST /api/generate-ai-code-stream has no owner check. So a member opening a
 * teammate's finished project got an empty file map every time — not a race —
 * and the client-only predicate then asked the model for a brand-new site,
 * which `settleStreamedGeneration` wrote over the owner's Project.lastCode.
 */
describe('hasStoredSite', () => {
  it('treats a refused file map as a site, even on a project this browser cannot read', () => {
    expect(hasStoredSite({ initialPhase: 'COMPLETE', fileMapUnreadable: true })).toBe(true);
    // 5xx or an offline blip on a project mid-build: still not proof of empty.
    expect(hasStoredSite({ initialPhase: 'BUILDING', fileMapUnreadable: true })).toBe(true);
    expect(hasStoredSite({ initialPhase: null, fileMapUnreadable: true })).toBe(true);
  });

  it('trusts the server-rendered phase over an empty client map', () => {
    // COMPLETE means the row has lastCode/a checkpoint. No failed fetch, and no
    // fresh mount that has not fetched yet, can take that away.
    expect(hasStoredSite({ initialPhase: 'COMPLETE', fileMapUnreadable: false })).toBe(true);
  });

  it('still lets a genuinely new project build from scratch', () => {
    // The commonest path in the product: prompt on the home page, project
    // created, generate immediately. Calling this an edit sends EDIT MODE
    // ("DO NOT regenerate App.jsx") at a project with no files, and the first
    // build comes back half-made — so a pending fetch must not fail closed.
    expect(hasStoredSite({ initialPhase: 'PLANNING', fileMapUnreadable: false })).toBe(false);
    expect(hasStoredSite({ initialPhase: 'BUILDING', fileMapUnreadable: false })).toBe(false);
    expect(hasStoredSite({ initialPhase: null, fileMapUnreadable: false })).toBe(false);
  });
});

/**
 * End-to-end shape of the workspace's decision: the two functions composed the
 * way GenerationWorkspace composes them at send time.
 */
describe('the isEdit flag the workspace sends', () => {
  it('is an edit for a member whose files fetch was refused on a finished project', () => {
    expect(
      hasExistingSite({
        projectFiles: {},
        streamedFiles: [],
        appliedCode: [],
        storedSite: hasStoredSite({ initialPhase: 'COMPLETE', fileMapUnreadable: true }),
      }),
    ).toBe(true);
  });

  it('is a fresh build for a new project whose files fetch succeeded and was empty', () => {
    expect(
      hasExistingSite({
        projectFiles: {},
        streamedFiles: [],
        appliedCode: [],
        storedSite: hasStoredSite({ initialPhase: 'PLANNING', fileMapUnreadable: false }),
      }),
    ).toBe(false);
  });
});
