import { describe, expect, it } from 'vitest';
import { previewFilesKey } from '@/lib/preview/assemble';

/**
 * The preview used to derive its rebuild key with `JSON.stringify(assembly)` — a
 * full serialisation of every byte of the project, allocated and thrown away on
 * every streamed file (F-642). `previewFilesKey` is the cheap replacement: it
 * reads the same bytes but allocates nothing per call and stays stable across
 * re-renders that do not change the code.
 */
describe('previewFilesKey', () => {
  const files = {
    'app/page.tsx': 'export default function Page() { return null; }',
    'app/layout.tsx': 'export default function Layout() {}',
  };

  it('is stable for the same files (a re-render must not rebuild)', () => {
    expect(previewFilesKey(files)).toBe(previewFilesKey({ ...files }));
  });

  it('does not depend on key insertion order', () => {
    const reordered = {
      'app/layout.tsx': files['app/layout.tsx'],
      'app/page.tsx': files['app/page.tsx'],
    };
    expect(previewFilesKey(reordered)).toBe(previewFilesKey(files));
  });

  it('changes when a file body changes', () => {
    const edited = { ...files, 'app/page.tsx': `${files['app/page.tsx']} // edit` };
    expect(previewFilesKey(edited)).not.toBe(previewFilesKey(files));
  });

  it('changes for a same-length one-character edit — the case a length hash would miss', () => {
    // The whole point of not keying on `path + content.length`: an edit that
    // preserves the length is exactly the change a rebuild exists for.
    const a = { 'a.tsx': 'const value = 1;' };
    const b = { 'a.tsx': 'const value = 2;' };
    expect(a['a.tsx'].length).toBe(b['a.tsx'].length);
    expect(previewFilesKey(a)).not.toBe(previewFilesKey(b));
  });

  it('changes when a file is added or removed', () => {
    const withExtra = { ...files, 'app/globals.css': 'body{}' };
    expect(previewFilesKey(withExtra)).not.toBe(previewFilesKey(files));
    const { 'app/layout.tsx': _removed, ...fewer } = files;
    void _removed;
    expect(previewFilesKey(fewer)).not.toBe(previewFilesKey(files));
  });

  it('does not confuse a path/content boundary shift', () => {
    // Without a separator between path and content, {"ab":"c"} and {"a":"bc"}
    // would hash identically; the delimiters keep them distinct.
    expect(previewFilesKey({ ab: 'c' })).not.toBe(previewFilesKey({ a: 'bc' }));
  });

  it('returns a compact fixed-width hex key', () => {
    expect(previewFilesKey(files)).toMatch(/^[0-9a-f]{16}$/);
    expect(previewFilesKey({})).toMatch(/^[0-9a-f]{16}$/);
  });
});
