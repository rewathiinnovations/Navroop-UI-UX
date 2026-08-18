import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `reconcileAbandonedJobs` scans the whole GenerationJob table unless the caller
 * passes `projectIds`. Production cron/boot omit that on purpose. A test that
 * omits it abandons stale rows belonging to whatever suite is running beside it —
 * which is how `job-terminal-race` saw ABANDONED on a job it had just succeeded.
 */

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TESTS_ROOT = path.join(REPO_ROOT, 'tests');
const CALLEE = 'reconcileAbandonedJobs';
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.next', 'generated']);

function testFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...testFiles(full));
      continue;
    }
    if (full.endsWith('.ts') || full.endsWith('.tsx')) files.push(full);
  }
  return files;
}

function matchingClose(source: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function unscopedCalls(source: string): number[] {
  const needle = `${CALLEE}(`;
  const lines: number[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at === -1) break;
    const open = at + CALLEE.length;
    const close = matchingClose(source, open);
    const args = close === -1 ? '' : source.slice(open + 1, close);
    if (!/\bprojectIds\s*:/.test(args)) {
      lines.push(source.slice(0, at).split('\n').length);
    }
    from = at + needle.length;
  }
  return lines;
}

describe('test-tree job reapers stay on their own rows', () => {
  it('every reconcileAbandonedJobs call in tests/ passes projectIds', () => {
    const offenders: string[] = [];
    for (const file of testFiles(TESTS_ROOT)) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes(CALLEE)) continue;
      const lines = unscopedCalls(source);
      if (lines.length === 0) continue;
      offenders.push(`${path.relative(REPO_ROOT, file)}:${lines.join(',')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('still sees the calls this is guarding', () => {
    const race = readFileSync(path.join(TESTS_ROOT, 'integration', 'job-terminal-race.test.ts'), 'utf8');
    expect(unscopedCalls(race)).toEqual([]);
    expect(race).toContain(`${CALLEE}({`);
    expect(race).toMatch(/\bprojectIds\s*:/);
  });
});
