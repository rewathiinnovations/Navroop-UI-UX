import { describe, expect, it } from 'vitest';
import { ParseFilesError } from '../../lib/generation/parse-files';
import { assertWritableGenerationFile } from '../../lib/generation/write-guard';

/**
 * Verbatim prefix from the Modal npm EJSONPARSE on Vaidya
 * (`cmsy8x2mg001fvka054t1ippr`). The file on disk started with a literal
 * backslash-n after `{`, not a newline — JSON.parse fails at position 1.
 */
const CAPTURED_CORRUPT_PACKAGE_JSON = '{\\n  "name": "sandbox-app"';

describe('generation write guard', () => {
  it('rejects the captured corrupt package.json before npm install would see it', () => {
    expect(() =>
      assertWritableGenerationFile({
        path: 'package.json',
        content: CAPTURED_CORRUPT_PACKAGE_JSON,
      }),
    ).toThrow(ParseFilesError);
    try {
      assertWritableGenerationFile({
        path: 'package.json',
        content: CAPTURED_CORRUPT_PACKAGE_JSON,
      });
      expect.fail('expected ParseFilesError');
    } catch (error) {
      expect(error).toBeInstanceOf(ParseFilesError);
      expect((error as ParseFilesError).code).toBe('invalid_json');
      expect((error as ParseFilesError).path).toBe('package.json');
      expect((error as Error).message).toMatch(/package\.json is not valid JSON/i);
    }
  });

  it('rejects an empty or doubled-slash path so it never reaches the sandbox', () => {
    expect(() => assertWritableGenerationFile({ path: '', content: '{}' })).toThrow(
      /Unsafe file path/,
    );
    expect(() => assertWritableGenerationFile({ path: '//package.json', content: '{}' })).toThrow(
      /Unsafe file path/,
    );
  });

  it('rejects a binary payload and a file over the per-file cap — F-028 put this gate on the persist path', () => {
    expect(() =>
      assertWritableGenerationFile({ path: 'public/logo.png', content: '\u0000'.repeat(16) }),
    ).toThrow(/Binary content is not allowed: public\/logo\.png/);
    expect(() =>
      assertWritableGenerationFile({ path: 'assets/big.css', content: 'x'.repeat(2_000_001) }),
    ).toThrow(/File is too large: assets\/big\.css/);
  });

  it('accepts a real package.json object', () => {
    const file = assertWritableGenerationFile({
      path: 'package.json',
      content: JSON.stringify({ name: 'sandbox-app', version: '1.0.0' }, null, 2),
    });
    expect(file.path).toBe('package.json');
  });
});
