import { describe, expect, it } from 'vitest';
import { stackShapeMismatch } from '@/lib/stacks';

/**
 * Guard for initial builds whose files can't render on the project's stack —
 * the live failure was Next.js app/page.tsx generated for a REACT (Vite)
 * project, which settled SUCCEEDED and then killed the sandbox boot.
 */
describe('stackShapeMismatch', () => {
  it('flags Next.js output on a REACT project', () => {
    const reason = stackShapeMismatch('REACT', ['app/page.tsx']);
    expect(reason).toMatch(/React \(Vite\)/);
    expect(reason).toMatch(/src\/App\.jsx/);
  });

  it.each([
    ['REACT', ['src/App.jsx', 'src/components/Header.jsx']],
    ['REACT', ['./src/App.tsx']],
    ['NEXTJS', ['app/page.tsx', 'app/layout.tsx']],
    ['ASTRO', ['src/pages/index.astro']],
    ['STATIC_HTML', ['index.html', 'styles.css']],
    ['VUE', ['src/App.vue']],
    ['SVELTE', ['src/routes/+page.svelte']],
  ] as const)('accepts a well-formed %s build', (stack, paths) => {
    expect(stackShapeMismatch(stack, [...paths])).toBeNull();
  });

  it('flags an empty or off-layout file set for every stack', () => {
    for (const stack of ['NEXTJS', 'REACT', 'ASTRO', 'STATIC_HTML', 'VUE', 'SVELTE']) {
      expect(stackShapeMismatch(stack, ['README.md'])).toBeTruthy();
    }
  });
});
