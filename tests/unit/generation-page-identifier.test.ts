import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A sibling moved app/generation/page.tsx → GenerationWorkspace. The live
 * workspace then threw ReferenceError: GenerationPage is not defined
 * (request 1870233561) because the project page still rendered <GenerationPage>
 * after the import was removed. Pin that no app/component value-imports it.
 */

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCANNED_ROOTS = ['app', 'components', 'lib'];
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.next',
  'generated',
  'archive',
  'worktrees',
]);

const VALUE_IMPORT = /import\s+(?:type\s+)?(?:\{[^}]*\bGenerationPage\b[^}]*\}|\bGenerationPage\b)\s+from/;
const JSX_OR_CALL = /<GenerationPage\b|\bGenerationPage\s*\(/;

function sourceFiles(dir: string): string[] {
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
      files.push(...sourceFiles(full));
      continue;
    }
    if (full.endsWith('.ts') || full.endsWith('.tsx')) files.push(full);
  }
  return files;
}

describe('GenerationPage leftover identifier', () => {
  it('no app/component/lib file value-imports or renders GenerationPage', () => {
    const hits: string[] = [];
    for (const root of SCANNED_ROOTS) {
      for (const file of sourceFiles(path.join(REPO_ROOT, root))) {
        const source = readFileSync(file, 'utf8');
        if (VALUE_IMPORT.test(source) || JSX_OR_CALL.test(source)) {
          hits.push(path.relative(REPO_ROOT, file));
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('the project workspace imports GenerationWorkspace, not the deleted generation page', () => {
    const page = readFileSync(path.join(REPO_ROOT, 'app/project/[id]/page.tsx'), 'utf8');
    expect(page).toMatch(/import GenerationWorkspace from '@\/components\/workspace\/GenerationWorkspace'/);
    expect(page).toMatch(/<GenerationWorkspace\b/);
    expect(page).not.toMatch(/GenerationPage/);
    expect(page).not.toMatch(/generation\/page/);
  });
});
