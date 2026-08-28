import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WORKSPACE = fileURLToPath(
  new URL('../../components/workspace/GenerationWorkspace.tsx', import.meta.url),
);

describe('?url= does not auto-start a billed import', () => {
  it('shows the URL but does not arm shouldAutoGenerate from the query param', () => {
    const source = readFileSync(WORKSPACE, 'utf8');
    const urlBlockAt = source.indexOf('if (storedUrl) {');
    expect(urlBlockAt).toBeGreaterThan(0);
    const urlBlock = source.slice(urlBlockAt, source.indexOf('// Trim this workspace', urlBlockAt));
    expect(urlBlock).toMatch(/setHomeUrlInput\(storedUrl\)/);
    expect(urlBlock).toMatch(/setSourceUrl\(/);
    expect(urlBlock).not.toMatch(/setShouldAutoGenerate\(true\)/);
  });

  it('does not startGeneration from the one-second URL-param timer', () => {
    const source = readFileSync(WORKSPACE, 'utf8');
    expect(source).not.toContain('[generation] Auto-triggering generation from URL params');
    const timerAt = source.indexOf('Auto-trigger generation when flag is set');
    if (timerAt > 0) {
      const effect = source.slice(timerAt, timerAt + 900);
      // ImportSource resume may still use the flag; ?url= must not be what sets it.
      expect(effect).not.toMatch(/from URL params/);
    }
  });
});
