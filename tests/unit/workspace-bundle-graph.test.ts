import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Two of the largest avoidable items in the workspace route's first client chunk
 * were pulled out of it. Asserted by scanning the source rather than measuring
 * bytes, so the guard is deterministic and cannot be defeated by a static import
 * creeping back in (F-639, F-640).
 *
 *  - The syntax highlighter (~1 MB of refractor grammars) must not be a static
 *    import of the `'use client'` panel; it lives behind a `next`-lazy boundary
 *    and uses `PrismLight` with only the languages it renders.
 *  - The `esbuild-wasm` JS wrapper must be a type-only import at module scope and
 *    a runtime `await import()` where it is actually used.
 */
function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

describe('F-639: the syntax highlighter is not in the workspace route bundle', () => {
  const panel = source('components/workspace/StreamingCodePanel.tsx');
  const block = source('components/workspace/StreamedCodeBlock.tsx');

  it('the panel has no static import of react-syntax-highlighter', () => {
    expect(panel).not.toMatch(/import[^;]*from\s+['"]react-syntax-highlighter/);
  });

  it('the panel reaches the highlighter only through a dynamic import', () => {
    expect(panel).toMatch(/import\(\s*['"]\.\/StreamedCodeBlock['"]\s*\)/);
  });

  it('the highlighter chunk uses PrismLight, not the full Prism build', () => {
    expect(block).toMatch(/PrismLight/);
    // The root `Prism` export is the ~1 MB variant this replaced.
    expect(block).not.toMatch(/import\s*\{\s*Prism\s+as/);
    // Only the languages the panel can actually render are registered.
    for (const language of ['jsx', 'css', 'json', 'markup']) {
      expect(block).toContain(`languages/prism/${language}`);
    }
  });
});

describe('F-640: esbuild-wasm is not in the workspace route bundle', () => {
  const bundle = source('lib/preview/bundle.ts');

  it('imports the esbuild-wasm types only (erased at compile time)', () => {
    expect(bundle).toMatch(/import\s+type\s+\*\s+as\s+\w+\s+from\s+['"]esbuild-wasm['"]/);
  });

  it('has no value-level static import of esbuild-wasm', () => {
    // A static `import * as esbuild from 'esbuild-wasm'` (no `type`) is exactly
    // what put the wrapper in the first client chunk.
    for (const line of bundle.split('\n')) {
      if (/from\s+['"]esbuild-wasm['"]/.test(line)) {
        expect(line).toMatch(/import\s+type/);
      }
    }
  });

  it('loads the wrapper with a runtime dynamic import', () => {
    expect(bundle).toMatch(/import\(\s*['"]esbuild-wasm['"]\s*\)/);
  });
});
