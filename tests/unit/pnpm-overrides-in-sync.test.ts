import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `pnpm install --frozen-lockfile` — the install both CI workflows run — fails when
 * the `overrides` block in `pnpm-workspace.yaml` disagrees with the one pnpm recorded
 * in `pnpm-lock.yaml`. Editing one and not the other is an easy mistake to make while
 * patching an advisory, and the failure lands on CI rather than on the editor.
 *
 * F-638: the `tar: ^7.5.19` override outlived its dependency. `@e2b/code-interpreter`
 * left with the sandbox subsystem and `tar` stopped resolving anywhere in the tree, so
 * the entry was a no-op that read like protection. Removing it means removing it from
 * both files, which is what this pins.
 *
 * Deliberately a text parse, not a YAML dependency: the lockfile is 10k lines and the
 * block is a flat `key: value` map at a known indent in both files.
 */

const ROOT = new URL('../../', import.meta.url);

function overridesBlock(relative: string) {
  const source = readFileSync(fileURLToPath(new URL(relative, ROOT)), 'utf8');
  const lines = source.split(/\r?\n/);
  const start = lines.indexOf('overrides:');
  if (start < 0) return null;
  const entries: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('  ') || !line.trim()) break;
    entries.push(line.trim().replace(/^'|'(?=:)/g, ''));
  }
  return entries;
}

describe('the pnpm overrides block is the same in both files', () => {
  const workspace = overridesBlock('pnpm-workspace.yaml');
  const lockfile = overridesBlock('pnpm-lock.yaml');

  it('finds a non-empty block in each file', () => {
    // Anti-vacuity: two nulls, or two empty arrays, would satisfy the equality below.
    expect(workspace, 'pnpm-workspace.yaml has no overrides: block').not.toBeNull();
    expect(lockfile, 'pnpm-lock.yaml has no overrides: block').not.toBeNull();
    expect(workspace?.length ?? 0).toBeGreaterThan(15);
  });

  it('agrees entry for entry, so --frozen-lockfile installs', () => {
    expect(lockfile).toEqual(workspace);
  });

  it('carries no override for a package that is not in the tree', () => {
    const lock = readFileSync(fileURLToPath(new URL('pnpm-lock.yaml', ROOT)), 'utf8');
    // Scoped names are quoted in the lockfile (`'@scope/name@1.2.3':`), plain ones are
    // not; both forms have to be recognised or every scoped override reads as dead.
    // `snapshots:` and `packages:` list every resolved package, so a name that appears
    // only in `overrides:` is pinning nothing.
    const resolved = new Set(
      [...lock.matchAll(/^ {2}'?((?:@[^/@\s']+\/)?[^@\s']+)@[0-9]/gm)].map((match) => match[1]),
    );
    const dead = (workspace ?? [])
      .map((entry) => entry.split(':')[0]?.replace(/@\d+$/, '').trim() ?? '')
      .filter((name) => name && !resolved.has(name));
    expect(dead, `overrides pin packages that no longer resolve: ${dead.join(', ')}`).toEqual([]);
  });
});
