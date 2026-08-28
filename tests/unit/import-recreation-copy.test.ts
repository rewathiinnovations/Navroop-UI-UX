import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { importRecreationProgress, importRecreationSuccess } from '@/lib/import/copy';
import { getStack } from '@/lib/stacks';

const WORKSPACE = fileURLToPath(
  new URL('../../components/workspace/GenerationWorkspace.tsx', import.meta.url),
);

describe('import recreation copy is stack-accurate', () => {
  it('names the project stack, not a React app', () => {
    expect(importRecreationProgress(getStack('NEXTJS').label)).toBe(
      'Website scraped successfully! Building Next.js (App Router) site...',
    );
    expect(importRecreationProgress(getStack('STATIC_HTML').label)).toBe(
      'Website scraped successfully! Building Static HTML site...',
    );
    expect(importRecreationProgress(getStack('REACT').label)).toBe(
      'Website scraped successfully! Building React (Vite) site...',
    );
    expect(importRecreationProgress(getStack('NEXTJS').label)).not.toMatch(/React app/i);
  });

  it('success copy names the stack, not a modern React app', () => {
    const url = 'https://example.com';
    expect(importRecreationSuccess(url, getStack('NEXTJS').label)).toBe(
      `Successfully recreated ${url} as a Next.js (App Router) site!`,
    );
    expect(importRecreationSuccess(url, getStack('STATIC_HTML').label)).toMatch(/Static HTML site/);
    expect(importRecreationSuccess(url, getStack('NEXTJS').label)).not.toMatch(/React app/i);
  });
});

describe('the workspace import path does not invent a second generation', () => {
  it('uses stack-accurate copy and does not start a generate stream after import files exist', () => {
    const source = readFileSync(WORKSPACE, 'utf8');
    expect(source).toContain('importRecreationProgress');
    expect(source).toContain('importRecreationSuccess');
    expect(source).not.toContain('Generating React app...');
    expect(source).not.toContain('as a modern React app');
    const importAt = source.indexOf('const imported = await streamProjectImport({');
    expect(importAt).toBeGreaterThan(0);
    const afterImport = source.slice(importAt, source.indexOf('} catch (error)', importAt));
    expect(afterImport).toMatch(/if \(!importedCode\) \{/);
    expect(afterImport).toMatch(/startGenerationStream\(/);
    // The generate stream is only for brand-extension (no filesXml). An import
    // that already persisted the site must not invent a second billed stream.
    const streamGuard = afterImport.slice(
      afterImport.indexOf('if (!importedCode)'),
      afterImport.indexOf('if (generatedCode)'),
    );
    expect(streamGuard).toContain('startGenerationStream');
    expect(afterImport).toContain('importRecreationSuccess');
  });

  it('switches to Code during import work, not Preview then Code 1.5s later', () => {
    const source = readFileSync(WORKSPACE, 'utf8');
    const startAt = source.indexOf('const startGeneration = async (sourceUrlOverride?: string)');
    const body = source.slice(startAt, startAt + 2500);
    expect(body).toMatch(/setActiveTab\('generation'\)/);
    expect(body).not.toMatch(/setActiveTab\('preview'\)/);
    expect(source).not.toMatch(
      /setTimeout\(\(\) => \{\s*setLoadingStage\('generating'\);\s*setActiveTab\('generation'\);\s*\}, 1500\)/,
    );
  });
});
