import { describe, expect, it, vi } from 'vitest';

/**
 * A snapshot from a partial first build carries only generated app files — no
 * package.json, no config. Restoring just those and running `npm install`
 * planned against container root and died with npm's "Tracker idealTree
 * already exists" on every boot of that project. The boot now lays the stack
 * scaffold under the restore; the snapshot always wins on conflicts.
 */

vi.mock('@/lib/db', () => ({ prisma: {} }));

describe('withScaffoldUnderlay', () => {
  it('adds the NEXTJS scaffold beneath app-only restores, snapshot winning on conflict', async () => {
    const { withScaffoldUnderlay } = await import('@/lib/sandbox/manager');
    const restored = [
      { path: 'app/page.tsx', content: 'generated page' },
      { path: 'package.json', content: '{"name":"user-owned"}' },
    ];
    const merged = withScaffoldUnderlay('NEXTJS', restored);
    const byPath = new Map(merged.map((file) => [file.path.replace(/^\.?\//, ''), file.content]));

    // The snapshot's own files are untouched and win over the scaffold.
    expect(byPath.get('package.json')).toBe('{"name":"user-owned"}');
    expect(byPath.get('app/page.tsx')).toBe('generated page');
    // The scaffold contributes what the snapshot lacks.
    expect(merged.length).toBeGreaterThan(restored.length);
  });

  it('guarantees package.json for a snapshot that has none', async () => {
    const { withScaffoldUnderlay } = await import('@/lib/sandbox/manager');
    const merged = withScaffoldUnderlay('NEXTJS', [
      { path: 'app/page.tsx', content: 'only file' },
    ]);
    const paths = merged.map((file) => file.path.replace(/^\.?\//, ''));
    expect(paths).toContain('package.json');
  });

  it('passes REACT restores through unchanged (scaffold owned by setupViteApp)', async () => {
    const { withScaffoldUnderlay } = await import('@/lib/sandbox/manager');
    const restored = [{ path: 'src/App.jsx', content: 'x' }];
    expect(withScaffoldUnderlay('REACT', restored)).toEqual(restored);
  });
});
