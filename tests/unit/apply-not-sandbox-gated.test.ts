import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Generated code reaches the project through applyGeneratedCode(). That call
 * used to sit inside `if (activeSandboxData && generatedCode)`, and once the
 * sandbox subsystem was removed the sandbox state was permanently null — so
 * the chat streamed a generation, listed the files it had written, and then
 * silently dropped every one of them. Nothing failed loudly, which is what
 * makes this shape worth pinning: an apply that only runs when a VM exists is
 * an apply that never runs.
 */

const WORKSPACE = fileURLToPath(
  new URL('../../components/workspace/GenerationWorkspace.tsx', import.meta.url),
);

/** Source with comments stripped, so commented-out history does not count. */
function liveSource(): string {
  return readFileSync(WORKSPACE, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

describe('applying generated code does not depend on a sandbox', () => {
  it('still has the apply calls this guards', () => {
    expect(liveSource().match(/\bapplyGeneratedCode\(/g)?.length ?? 0).toBeGreaterThan(1);
  });

  it('never guards an apply behind sandbox state', () => {
    // An `if` whose condition mentions a sandbox, with an apply close behind it.
    const gated = new RegExp(
      'if\\s*\\([^)]*[Ss]andbox[^)]*\\)[\\s\\S]{0,400}?applyGeneratedCode\\(',
      'g',
    );
    const matches = liveSource().match(gated) ?? [];
    expect(matches.map((match) => match.split('\n')[0].trim())).toEqual([]);
  });
});
