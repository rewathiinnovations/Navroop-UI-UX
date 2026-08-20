import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sanitizeGenerationPath } from '@/lib/generation/parse-files';
import { getCurrentProjectFiles } from '@/lib/github/current-files';
import { safeGeneratedFiles } from '@/lib/jobs/settle-generation';
import { toLastCode } from '@/lib/projects/last-code';

/**
 * `Project.lastCode` is written by `toLastCode` as `<file path="p">…</file>`
 * blocks and read back by `getCurrentProjectFiles`. That round-trip had two
 * holes (F-052), both silent:
 *
 * - a path containing `"` closed the attribute early, so the reader took a
 *   truncated key and swallowed the rest of the block;
 * - content containing the literal `</file>` — a file documenting this very
 *   format — ended the block early, so that file came back truncated.
 *
 * Goes red if the quote rejection is dropped from `sanitizeGenerationPath`, if
 * the reader goes back to stopping at the first closing tag, or if the reader
 * starts swallowing trailing prose into the last file.
 */

/** The reader as it was before F-052, as the regression oracle. */
function legacyFilesFromLastCode(lastCode: string): Record<string, string> {
  const tagged: Record<string, string> = {};
  const fileRegex = /<file path="([^"]+)">([\s\S]*?)(?:<\/file>|$)/g;
  let match: RegExpExecArray | null;
  while ((match = fileRegex.exec(lastCode)) !== null) {
    tagged[match[1].replace(/^\.?\//, '')] = match[2].trim();
  }
  return tagged;
}

describe('sanitizeGenerationPath refuses a quote in the path', () => {
  it('rejects a quote-bearing path with its own code', () => {
    expect(sanitizeGenerationPath('src/a"b.tsx')).toEqual({
      ok: false,
      code: 'invalid_path',
    });
    expect(sanitizeGenerationPath('"')).toEqual({ ok: false, code: 'invalid_path' });
    // A quote after an escaping backslash is still a quote once the path is
    // slash-normalized, which is what reaches the attribute.
    expect(sanitizeGenerationPath('src/x\\".tsx')).toEqual({
      ok: false,
      code: 'invalid_path',
    });
  });

  it('still accepts every ordinary path', () => {
    expect(sanitizeGenerationPath('src/App.tsx')).toEqual({ ok: true, path: 'src/App.tsx' });
    expect(sanitizeGenerationPath("app/[id]/page's.tsx")).toEqual({
      ok: true,
      path: "app/[id]/page's.tsx",
    });
  });

  it('drops a quote-bearing path at the persist gate rather than storing it', () => {
    const { safe, rejected } = safeGeneratedFiles({
      'src/App.tsx': 'export default function App() {}',
      'src/a"b.tsx': 'export const b = 1;',
    });
    expect(Object.keys(safe)).toEqual(['src/App.tsx']);
    expect(rejected.map((file) => [file.path, file.code])).toEqual([
      ['src/a"b.tsx', 'invalid_path'],
    ]);
  });

  it('shows the file a quote-bearing path used to lose outright', () => {
    // Why the rejection above matters: this is what used to be stored. The
    // opener needs `">` right after the path, so a quoted path matches no
    // opener at all and its whole block vanishes — the reader cannot recover
    // it, which is why the gate has to refuse the name.
    const blob =
      '<file path="src/a"b.tsx">\nfirst\n</file>\n\n<file path="src/App.tsx">\nsecond\n</file>';
    expect(legacyFilesFromLastCode(blob)).toEqual({ 'src/App.tsx': 'second' });
    expect(getCurrentProjectFiles({ lastCode: blob })).toEqual({ 'src/App.tsx': 'second' });
  });
});

describe('lastCode round-trips content containing the closing tag', () => {
  it('returns a file whose own text contains </file> whole', () => {
    const files = {
      'docs/format.md': 'Each file is wrapped in an open tag and a </file> tag.',
      'src/App.tsx': 'export default function App() {}',
    };
    expect(getCurrentProjectFiles({ lastCode: toLastCode(files) })).toEqual(files);
  });

  it('is the case the legacy reader truncated', () => {
    const files = { 'docs/format.md': 'a </file> b' };
    const blob = toLastCode(files);
    expect(legacyFilesFromLastCode(blob)).toEqual({ 'docs/format.md': 'a' });
    expect(getCurrentProjectFiles({ lastCode: blob })).toEqual(files);
  });

  it('round-trips a whole tree, sentinel-bearing file first', () => {
    const files = {
      'a.md': 'one </file> two\n</file>',
      'b.tsx': 'export const b = 1;',
      'c.css': '.x { color: red }',
    };
    expect(getCurrentProjectFiles({ lastCode: toLastCode(files) })).toEqual(files);
  });
});

describe('lastCode reader keeps its older shapes', () => {
  it('leaves prose after the last block out of the file', () => {
    const blob = '<file path="src/App.tsx">\nexport const a = 1;\n</file>\n\nDone — enjoy!';
    expect(getCurrentProjectFiles({ lastCode: blob })).toEqual({
      'src/App.tsx': 'export const a = 1;',
    });
  });

  it('still closes an unterminated final block at the end of the blob', () => {
    const blob = '<file path="src/App.tsx">\nexport const a = 1;';
    expect(getCurrentProjectFiles({ lastCode: blob })).toEqual({
      'src/App.tsx': 'export const a = 1;',
    });
  });

  it('agrees with the legacy reader on every blob without a nested tag', () => {
    const blobs = [
      toLastCode({ 'a.tsx': 'one' }),
      toLastCode({ 'a.tsx': 'one', 'b.tsx': 'two' }),
      toLastCode({ 'a.tsx': '' }),
      '<file path="./a.tsx">\nleading dot slash\n</file>',
      '<file path="a.tsx">\nunterminated',
      '<file path="a.tsx">\nx\n</file>\nprose',
      '<file path="a.tsx">\nx\n</file>\n<file path="b.tsx">\ny\n</file>',
    ];
    for (const blob of blobs) {
      expect(getCurrentProjectFiles({ lastCode: blob })).toEqual(legacyFilesFromLastCode(blob));
    }
  });

  it('keeps the non-block fallbacks', () => {
    expect(getCurrentProjectFiles({ lastCode: '{"a.tsx":"one"}' })).toEqual({ 'a.tsx': 'one' });
    expect(getCurrentProjectFiles({ lastCode: 'just prose' })).toEqual({
      'src/App.jsx': 'just prose',
    });
    expect(getCurrentProjectFiles({ lastCode: null })).toEqual({});
  });
});

describe('the unescaped duplicate serializer is gone', () => {
  it('no longer exists in lib/jobs/types.ts', () => {
    const source = readFileSync('lib/jobs/types.ts', 'utf8');
    expect(source).not.toMatch(/filesToLastCode/);
    // The one remaining writer of the stored shape.
    expect(readFileSync('lib/projects/last-code.ts', 'utf8')).toMatch(/export function toLastCode/);
  });
});
