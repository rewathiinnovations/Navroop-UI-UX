import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getCurrentProjectFiles } from '@/lib/github/current-files';
import { toLastCode } from '@/lib/projects/last-code';

/**
 * An edit has to show the model the site it is being asked to change.
 *
 * That context used to come from `global.sandboxState.fileCache` — a
 * server-global a sandbox kept in sync. Nothing writes it now, so
 * `hasBackendFiles` was always false and every edit fell into FIRST
 * GENERATION MODE: the model never saw the existing files and rewrote the
 * whole site instead of changing the one thing that was asked for. Nothing
 * errored, which is why it survived a full test suite.
 */

const ROUTE = fileURLToPath(
  new URL('../../app/api/generate-ai-code-stream/route.ts', import.meta.url),
);

describe('edit context comes from the project row', () => {
  it('round-trips stored files back into edit context', () => {
    const files = {
      'src/App.tsx': 'export default function App() {\n  return <Hero />;\n}',
      'src/components/Hero.tsx': 'export function Hero() {\n  return <h1>Fern</h1>;\n}',
    };
    // What a generation stores, and what an edit must be able to read back.
    const recovered = getCurrentProjectFiles({ lastCode: toLastCode(files) });
    expect(Object.keys(recovered).sort()).toEqual(Object.keys(files).sort());
    expect(recovered['src/components/Hero.tsx']).toContain('Fern');
  });

  it('reads current files from the project, not a sandbox global', () => {
    const source = readFileSync(ROUTE, 'utf8');
    expect(source).toContain('getCurrentProjectFiles');
    // The assignment that decides whether the model sees anything at all.
    expect(source).toMatch(/let backendFiles: Record<string, string> = \{\};/);
    expect(source).not.toMatch(/backendFiles\s*=\s*global\.sandboxState/);
  });

  it('never dereferences a sandbox manifest while building context', () => {
    // Comments stripped: the prose explaining this bug quotes the expression.
    const live = readFileSync(ROUTE, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    // These assertions threw the moment real files reached the branch.
    expect(live).not.toContain('global.sandboxState!.fileCache!.manifest!');
  });

  it('leaves no reader of the sandbox global in the generation route', () => {
    // The global has no writer, so every branch gated on it was unreachable:
    // the search plan, the surgical edit context and the keyword fallback all
    // hung off `global.sandboxState?.fileCache?.manifest`. A dead branch that
    // still compiles is how the file-context selector stayed degraded.
    const live = readFileSync(ROUTE, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    expect(live).not.toContain('sandboxState');
    expect(live).not.toContain('selectFilesForEdit');
  });

  it('prefers the project row over any sandbox global that reappears', () => {
    // Defence in depth for the merge paths: `settleStreamedGeneration` and the
    // "keep what was built" path both spread a generation over whatever this
    // returns, so a stale cache winning here would silently resurrect files
    // the person deleted.
    const globals = globalThis as { sandboxState?: unknown };
    globals.sandboxState = {
      fileCache: { files: { 'src/App.tsx': { content: 'stale sandbox copy' } } },
    };
    try {
      const recovered = getCurrentProjectFiles({
        lastCode: toLastCode({ 'src/App.tsx': 'current project copy' }),
      });
      expect(recovered['src/App.tsx']).toBe('current project copy');
    } finally {
      delete globals.sandboxState;
    }
  });
});
