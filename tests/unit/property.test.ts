import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { slugFromName, isReservedSlug } from '../../lib/publish/slug';
import { sanitizeGenerationPath } from '../../lib/generation/parse-files';
import { CREDIT_COSTS, isUnlimited } from '../../lib/plans/limits';
import { UnsafeUrlError, assertSafeUrl } from '../../lib/security/url-guard';

describe('property-based: slugs', () => {
  it('slugFromName is lowercase, hyphenated, and non-empty', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (name) => {
        const slug = slugFromName(name);
        expect(slug.length).toBeGreaterThan(0);
        expect(slug).toBe(slug.toLowerCase());
        expect(slug).toMatch(/^[a-z0-9-]+$/);
        expect(slug.startsWith('-')).toBe(false);
        expect(slug.endsWith('-')).toBe(false);
      }),
      { numRuns: 50 },
    );
  });

  it('reserved slugs stay reserved', () => {
    expect(isReservedSlug('www')).toBe(true);
    expect(isReservedSlug('preview-acme')).toBe(true);
    expect(isReservedSlug('acme')).toBe(false);
  });
});

describe('property-based: url guard', () => {
  it('file/ftp/javascript protocols are always rejected', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('file:', 'ftp:', 'javascript:', 'data:'),
        async (protocol) => {
          await expect(assertSafeUrl(`${protocol}//example`)).rejects.toBeInstanceOf(
            UnsafeUrlError,
          );
        },
      ),
      { numRuns: 8 },
    );
  });
});

describe('property-based: generation paths', () => {
  it('traversal is rejected, unicode nesting survives', () => {
    expect(sanitizeGenerationPath('../etc/passwd').ok).toBe(false);
    expect(sanitizeGenerationPath('src/ok.ts').ok).toBe(true);
    expect(sanitizeGenerationPath('src/组件/App.tsx').ok).toBe(true);
    expect(sanitizeGenerationPath('src/nested/deep/file.ts').ok).toBe(true);
  });
});

describe('property-based: credit arithmetic', () => {
  it('costs are positive integers and unlimited is only -1', () => {
    for (const cost of Object.values(CREDIT_COSTS)) {
      expect(Number.isInteger(cost)).toBe(true);
      expect(cost).toBeGreaterThan(0);
    }
    fc.assert(
      fc.property(fc.integer({ min: -5, max: 50 }), (n) => {
        expect(isUnlimited(n)).toBe(n === -1);
      }),
      { numRuns: 30 },
    );
  });
});
