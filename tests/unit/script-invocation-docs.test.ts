/**
 * N-018: five scripts documented their own invocation as `npx tsx scripts/…` or
 * `pnpm exec tsx scripts/…` in their header comment. Both runners are forbidden here —
 * pnpm's dependency-status check can offer to purge `node_modules` before running anything,
 * and `npx` has separately corrupted `pnpm-workspace.yaml` in this repo. F-644 and F-530
 * removed the doc-facing copies; the script headers are where an operator actually looks,
 * and they still named the forbidden forms.
 *
 * The one safe form is the direct binary the git hooks and every `verify` step already use.
 * `lib/backup`'s operator-facing restore string is guarded separately in
 * `admin-ui-conventions.test.ts`; this file guards the scripts themselves, all of them, so
 * the next script added cannot reintroduce either runner.
 *
 * `pnpm run <script>` is deliberately not covered: it names a `package.json` entry rather
 * than resolving a binary, and two scripts point at their own npm alias that way.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function scriptFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) scriptFiles(path, out);
    else if (/\.(ts|mts|mjs|js)$/.test(name)) out.push(path);
  }
  return out;
}

const FORBIDDEN_RUNNER = /(?:\bnpx\b|\bpnpm\s+(?:exec|dlx)\b)/;

const TSX_BINARY = 'node ./node_modules/tsx/dist/cli.mjs';

describe('scripts document a runner that cannot purge node_modules (N-018)', () => {
  const files = scriptFiles('scripts');

  it('finds the scripts to check', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('names neither npx nor pnpm exec anywhere', () => {
    const offenders = files.filter((file) => FORBIDDEN_RUNNER.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('spells its own invocation as the direct tsx binary where it spells one at all', () => {
    const usageLines = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .filter((line) => /\btsx\b/.test(line) && line.includes('scripts/'))
        .map((line) => ({ file, line: line.trim() })),
    );
    expect(usageLines.length).toBeGreaterThan(0);
    for (const { file, line } of usageLines) {
      expect(line, `${file} documents a runner other than the direct binary`).toContain(TSX_BINARY);
    }
  });
});
