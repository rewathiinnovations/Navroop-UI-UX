import { describe, expect, it } from 'vitest';
import { DESIGN_DIRECTION_IDS } from '@/lib/design/directions';
import { buildRepoFiles } from '@/lib/deploy/repo-files';
import { STACK_IDS } from '@/lib/stacks';
import { getStackStarterFiles } from '@/lib/stacks/starter';
import {
  ALLOWED_STARTER_LICENSES,
  STARTER_PROVENANCE,
  isThirdParty,
  renderStarterCredits,
  starterProvenanceForPath,
} from '@/lib/stacks/templates/provenance';

/**
 * The gate that makes vendoring a component slower than copy-pasting one.
 *
 * `withStarterFiles` feeds `buildRepoFiles`, so a starter file is pushed to a
 * repository the client owns and served by Coolify from their domain. That is
 * redistribution, and a reciprocal licence — Origin UI is AGPL-3.0 at its root
 * while every list still calls it MIT — would land its obligations on the
 * client's site. So the licence of a merged file is asserted here rather than
 * described in a header comment, and a file with no recorded origin cannot
 * reach the merge point without failing this file first.
 */

/** Every path any stack merges, across every direction, deduplicated. */
function allStarterPaths(): string[] {
  const paths = new Set<string>();
  for (const stack of STACK_IDS) {
    for (const direction of DESIGN_DIRECTION_IDS) {
      for (const path of Object.keys(getStackStarterFiles(stack, direction))) {
        paths.add(path);
      }
    }
  }
  return [...paths].sort();
}

describe('starter kit provenance', () => {
  it('records an origin and licence for every merged path', () => {
    const missing = allStarterPaths().filter((path) => !starterProvenanceForPath(path));
    // Naming the paths matters more than the count: the failure is read by
    // whoever just added a file, and the fix is one entry per name listed.
    expect(missing, `no provenance entry for: ${missing.join(', ')}`).toEqual([]);
  });

  it('allows only permissive licences', () => {
    for (const [path, entry] of Object.entries(STARTER_PROVENANCE)) {
      expect(
        ALLOWED_STARTER_LICENSES,
        `${path} carries ${entry.license}, which is not redistributable through publish`,
      ).toContain(entry.license);
    }
  });

  it('carries the copyright line for third-party code, since that is the notice', () => {
    for (const [path, entry] of Object.entries(STARTER_PROVENANCE)) {
      if (!isThirdParty(entry)) continue;
      expect(entry.copyright, `${path} names an upstream but no copyright line`).toBeTruthy();
      expect(entry.url, `${path} names an upstream but no source URL`).toBeTruthy();
    }
  });

  it('has no entry for a path no stack merges', () => {
    // A stale claim is its own defect: it says the repo ships code it does not,
    // and it would put a notice for absent code into a client's repository.
    const merged = new Set(allStarterPaths().map((path) => path.replace(/^src\//, '')));
    const orphans = Object.keys(STARTER_PROVENANCE).filter((path) => !merged.has(path));
    expect(orphans, `provenance recorded for unmerged paths: ${orphans.join(', ')}`).toEqual([]);
  });

  it('resolves the REACT layout through the same entry as NEXTJS', () => {
    expect(starterProvenanceForPath('src/components/ui/button.tsx')).toBe(
      starterProvenanceForPath('components/ui/button.tsx'),
    );
  });
});

describe('renderStarterCredits', () => {
  it('reproduces one notice per upstream and lists what it covers', () => {
    const credits = renderStarterCredits(allStarterPaths());
    expect(credits).toBeTruthy();
    expect(credits).toContain('shadcn/ui');
    expect(credits).toContain('Copyright (c) 2023 shadcn');
    expect(credits).toContain('components/ui/button.tsx');
    // Deduped by origin: MIT asks for the notice once, not once per file.
    expect(credits!.match(/^## shadcn\/ui$/gm)).toHaveLength(1);
  });

  it('omits first-party files, which need no notice', () => {
    expect(renderStarterCredits(['tailwind.config.js', 'components/ui/reveal.tsx'])).toBeNull();
  });

  it('is null for a file set with no starter files at all', () => {
    expect(renderStarterCredits(['app/page.tsx'])).toBeNull();
  });
});

describe('the notice reaches the repository that redistributes the code', () => {
  it('ships CREDITS.md in the pushed and exported file set', () => {
    const files = buildRepoFiles('NEXTJS', { 'app/page.tsx': 'export default () => null;' });
    expect(files['CREDITS.md']).toContain('Copyright (c) 2023 shadcn');
  });

  it('leaves a generated CREDITS.md alone', () => {
    const files = buildRepoFiles('NEXTJS', { 'CREDITS.md': 'mine' });
    expect(files['CREDITS.md']).toBe('mine');
  });

  it('adds nothing to a stack that merges no starter files', () => {
    expect(
      buildRepoFiles('STATIC_HTML', { 'index.html': '<!doctype html>' })['CREDITS.md'],
    ).toBeUndefined();
  });
});
