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

  it('the operator-facing restore command uses pnpm exec, never npx', () => {
    const command = restoreCommand('backups/db/db-2026-01-01-abc123.dump');
    expect(command).toContain('pnpm exec tsx scripts/restore-db.ts');
    expect(command).not.toContain('npx');
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
