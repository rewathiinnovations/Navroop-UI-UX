import { describe, expect, it } from 'vitest';
import { packageNameFromImport, shouldSkipPackageInstall } from '@/lib/stacks';

/**
 * The install-skip decision the generate route makes for every detected import
 * (app/api/generate-ai-code-stream/route.ts). These assertions used to live in
 * scripts/verify-stack-pipeline.mjs, which nothing ran and which asserted three
 * stacks (ASTRO, VUE, SVELTE) that do not exist; they run here instead.
 */
describe('shouldSkipPackageInstall', () => {
  it('skips the packages each real stack already scaffolds', () => {
    expect(shouldSkipPackageInstall('NEXTJS', 'react-dom')).toBe(true);
    expect(shouldSkipPackageInstall('NEXTJS', 'next/link')).toBe(true);
    expect(shouldSkipPackageInstall('REACT', 'react')).toBe(true);
    expect(shouldSkipPackageInstall('REACT', 'react-dom/client')).toBe(true);
  });

  it('does not apply one stack\u2019s skip list to another', () => {
    // `next` is scaffolded by NEXTJS only — a REACT (Vite) project importing it
    // must still get an install.
    expect(shouldSkipPackageInstall('REACT', 'next')).toBe(false);
    // STATIC_HTML scaffolds no framework packages at all.
    expect(shouldSkipPackageInstall('STATIC_HTML', 'react')).toBe(false);
    expect(shouldSkipPackageInstall('STATIC_HTML', 'react-dom')).toBe(false);
  });

  it('always skips relative, absolute and aliased imports', () => {
    for (const stack of ['NEXTJS', 'REACT', 'STATIC_HTML']) {
      expect(shouldSkipPackageInstall(stack, './App')).toBe(true);
      expect(shouldSkipPackageInstall(stack, '/src/main')).toBe(true);
      expect(shouldSkipPackageInstall(stack, '@/lib/foo')).toBe(true);
    }
  });

  it('installs third-party packages on every stack', () => {
    for (const stack of ['NEXTJS', 'REACT', 'STATIC_HTML']) {
      expect(shouldSkipPackageInstall(stack, 'zod')).toBe(false);
      expect(shouldSkipPackageInstall(stack, 'lucide-react/dist/esm/icons/x')).toBe(false);
      expect(shouldSkipPackageInstall(stack, '@tanstack/react-query')).toBe(false);
    }
  });
});

describe('packageNameFromImport', () => {
  it('keeps the scope on scoped packages and drops deep paths', () => {
    expect(packageNameFromImport('@tanstack/react-query/build')).toBe('@tanstack/react-query');
    expect(packageNameFromImport('lucide-react/dist/esm/icons/x')).toBe('lucide-react');
    expect(packageNameFromImport('zod')).toBe('zod');
  });
});
