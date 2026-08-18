import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ParseFilesError, parseGenerationFiles, sanitizeGenerationPath } from '../../lib/generation/parse-files';

describe('generation file parser', () => {
  it('parses a well-formed file block', () => {
    const files = parseGenerationFiles('<file path="src/App.tsx">export const n = 1</file>');
    expect(files).toEqual([{ path: 'src/App.tsx', content: 'export const n = 1' }]);
  });

  it('rejects truncated / unterminated fences without crashing', () => {
    expect(() => parseGenerationFiles('<file path="src/App.tsx">export const n = 1')).toThrow(ParseFilesError);
    try {
      parseGenerationFiles('<file path="src/App.tsx">export const n = 1');
    } catch (error) {
      expect(error).toBeInstanceOf(ParseFilesError);
      expect((error as ParseFilesError).code).toBe('unterminated');
    }
  });

  it('rejects duplicate paths, absolute paths, and traversal', () => {
    expect(() =>
      parseGenerationFiles(
        '<file path="a.ts">1</file><file path="a.ts">2</file>',
      ),
    ).toThrow(/Duplicate/);
    expect(() => parseGenerationFiles('<file path="/etc/passwd">x</file>')).toThrow(ParseFilesError);
    expect(() => parseGenerationFiles('<file path="../secret">x</file>')).toThrow(ParseFilesError);
    expect(sanitizeGenerationPath('C:/Windows/system32').ok).toBe(false);
  });

  it('rejects enormous and binary payloads', () => {
    expect(() => parseGenerationFiles(`<file path="big.ts">${'x'.repeat(2_000_001)}</file>`)).toThrow(
      /too large/i,
    );
    expect(() => parseGenerationFiles(`<file path="bin.dat">${'\u0000'.repeat(8)}</file>`)).toThrow(/Binary/);
  });

  it('never writes outside the project root (paths stay relative)', () => {
    const files = parseGenerationFiles('<file path="./src/nested/Page.tsx">ok</file>');
    expect(files[0]?.path.startsWith('..')).toBe(false);
    expect(files[0]?.path.startsWith('/')).toBe(false);
  });

  it('rejects an empty path, a doubled slash, and the captured Modal package.json', () => {
    expect(() => parseGenerationFiles('<file path="">{"name":"x"}</file>')).toThrow(/Unsafe file path/);
    expect(() => parseGenerationFiles('<file path="//package.json">{"name":"x"}</file>')).toThrow(
      /Unsafe file path/,
    );
    expect(sanitizeGenerationPath('').ok).toBe(false);
    expect(sanitizeGenerationPath('//package.json').ok).toBe(false);
    expect(sanitizeGenerationPath('src//package.json').ok).toBe(false);
  });
});

describe('generation parser property fuzz', () => {
  it('never crashes on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (raw) => {
        try {
          const files = parseGenerationFiles(raw);
          for (const file of files) {
            expect(file.path.includes('..')).toBe(false);
            expect(file.path.startsWith('/')).toBe(false);
          }
        } catch (error) {
          expect(error).toBeInstanceOf(ParseFilesError);
        }
      }),
      { numRuns: 40 },
    );
  });
});
