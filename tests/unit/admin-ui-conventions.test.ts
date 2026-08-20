import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { restoreCommand } from '@/lib/backup/copy';
import { sandboxAttemptLine, sandboxChoiceLines } from '@/lib/jobs/sandbox-choice';

/**
 * Conventions the admin surface has already broken once each:
 *
 * - `window.confirm` snuck back after ConfirmAction shipped (servers,
 *   workspace pause, sandbox providers, the assets panel).
 * - The restore command shown on /admin/backups said `npx tsx`, in a repo
 *   where npx has corrupted pnpm-workspace.yaml.
 * - /admin/jobs printed the same failure paragraph twice per row.
 */

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

describe('admin UI conventions', () => {
  it('no component or page calls window.confirm — ConfirmAction is the dialog', () => {
    const offenders: string[] = [];
    for (const root of ['app', 'components']) {
      for (const file of walk(root)) {
        const source = readFileSync(file, 'utf8');
        // The ConfirmAction doc comment may mention the API by name.
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        if (code.includes('window.confirm')) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * F-644. Three instructions existed for one command: `/admin/backups` printed `pnpm exec`,
   * `scripts/restore-db.ts` and AGENTS.md said `npx`, and this assertion pinned the `pnpm exec`
   * form — the one the lessons file, both git hooks and `docs/release.md` forbid, because
   * pnpm's dependency-status check can offer to purge `node_modules` before running anything.
   * A disaster-recovery restore is the worst moment to lose the dependency tree, and `npx` has
   * separately corrupted `pnpm-workspace.yaml` here. The hooks' direct-binary form is the
   * only one that is safe, so it is the only one an operator is shown.
   */
  it('the operator-facing restore command invokes the binary directly, never pnpm exec or npx', () => {
    const command = restoreCommand('backups/db/db-2026-01-01-abc123.dump');
    expect(command).toBe(
      'node ./node_modules/tsx/dist/cli.mjs scripts/restore-db.ts --key backups/db/db-2026-01-01-abc123.dump',
    );
    expect(command).not.toContain('pnpm exec');
    expect(command).not.toContain('npx');
  });

  it('no operator-facing string in lib/backup or the restore script offers a forbidden runner', () => {
    const sources = [
      'lib/backup/copy.ts',
      'lib/backup/admin.ts',
      'scripts/restore-db.ts',
      'scripts/rollback.ts',
    ];
    const offenders = sources.filter((file) =>
      /(pnpm exec|npx)\s+tsx\s+scripts\//.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('a failed attempt matching the already-shown job error compresses instead of repeating', () => {
    const attempt = {
      driver: 'modal',
      ok: false,
      error: 'Modal created a sandbox but npm install failed (exit 1)',
      selectionReason: 'Modal — monthly free credit.',
    };
    const duplicated = sandboxAttemptLine(attempt, { omitError: attempt.error });
    expect(duplicated).toBe('modal — failed with the error above. Modal — monthly free credit.');

    // Without the option (workspace surfaces), the full error still prints.
    expect(sandboxAttemptLine(attempt)).toContain('npm install failed');

    const lines = sandboxChoiceLines(
      { sandboxAttempts: [attempt], sandboxSkipped: [] },
      { omitError: attempt.error },
    );
    expect(lines[0]).toContain('failed with the error above');
  });
});
