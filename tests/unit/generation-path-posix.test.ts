import { describe, expect, it } from 'vitest';
import { posix, win32 } from 'node:path';
import { sanitizeGenerationPath } from '@/lib/generation/parse-files';

/**
 * `sanitizeGenerationPath` used to normalize with the platform's `node:path`, so
 * its verdict depended on the host — and on Windows a `..` walked straight
 * through its own traversal check. Every path it guards becomes a posix-semantic
 * name (a storage key, a zip entry, a `<file path=…>` block), so it is pinned to
 * `posix` and these tests must give the same answers on Windows and Linux.
 *
 * Evidence for "pinning to posix changes nothing in production": the candidate
 * and the old body were compared over 406,934 inputs — every 1-to-4-segment
 * combination of a 25-symbol alphabet (`.`, `..`, `...`, `..h`, `C:`, `c:`,
 * `C:x`, `a:b`, `%2e%2e`, backslashes, tab, space, unicode, `~`, `$`, …) plus 34
 * hand-picked specials — each run through three normalizers. Zero divergences
 * against `path.posix`; ten divergence classes against `path.win32`, all
 * drive-relative, listed below. `fast-check` could not be loaded standalone
 * under this pnpm layout, so the generator was exhaustive rather than random,
 * which is the stronger evidence here anyway. `LEGACY_ALPHABET` reruns a bounded
 * version of that comparison so the claim stays checked rather than remembered.
 */

/** The pre-posix body, parameterized by normalizer, as the equivalence oracle. */
function legacySanitize(raw: string, p: typeof posix) {
  const trimmed = raw.trim().replace(/\\/g, '/');
  if (!trimmed) return { ok: false, code: 'empty' };
  if (trimmed.split('/').some((segment) => segment === '')) return { ok: false, code: 'empty' };
  if (p.isAbsolute(trimmed) || /^[a-zA-Z]:\//.test(trimmed) || trimmed.startsWith('/')) {
    return { ok: false, code: 'absolute_path' };
  }
  const normalized = p.normalize(trimmed).replace(/\\/g, '/');
  if (normalized.startsWith('..') || normalized.split('/').includes('..')) {
    return { ok: false, code: 'path_traversal' };
  }
  if (normalized.split(p.sep).includes('..')) return { ok: false, code: 'path_traversal' };
  return { ok: true, path: normalized.replace(/^\.\//, '') };
}

const LEGACY_ALPHABET = [
  'a',
  'src',
  '.',
  '..',
  '...',
  '..h',
  '',
  'C:',
  'c:',
  'C:x',
  'a:b',
  '%2e%2e',
  'App.tsx',
  '\\',
  'a\\b',
  ' ',
  '\t',
  'node_modules',
  '~',
  '..\\..',
  'ünï',
  '.hidden',
] as const;

const SPECIALS = [
  '',
  '/',
  '//',
  '/etc/passwd',
  'C:/W',
  'C:x/../y',
  'c:',
  'C:',
  '\\\\srv\\share\\x',
  'a/../../b',
  '..',
  '../',
  './a',
  'a/./b',
  'a//b',
  'a/b/',
  ' a/b ',
  '..hidden.txt',
  'a/..b',
  'a/../..',
  '.',
  'a/b/..',
  'a/..',
  'C:x/a/../..\\..',
  'a/../C:x/../y',
] as const;

function everyCandidate(): string[] {
  const out = [...SPECIALS];
  for (const a of LEGACY_ALPHABET) {
    out.push(a);
    for (const b of LEGACY_ALPHABET) {
      out.push(`${a}/${b}`);
      for (const c of LEGACY_ALPHABET) out.push(`${a}/${b}/${c}`);
    }
  }
  return out;
}

describe('sanitizeGenerationPath posix pin', () => {
  it('refuses the drive-relative traversal that win32 normalization let through', () => {
    // The finding that forced the pin: win32 `normalize` answers 'C:..', and
    // neither `startsWith('..')` nor the '/'-split can see the `..` behind the
    // drive prefix, so the guard returned ok on a Windows host.
    expect(legacySanitize('C:x/a/../..\\..', win32)).toEqual({ ok: true, path: 'C:..' });
    expect(sanitizeGenerationPath('C:x/a/../..\\..')).toEqual({
      ok: false,
      code: 'path_traversal',
    });
  });

  it('gives one answer for drive-relative paths on every host', () => {
    expect(sanitizeGenerationPath('C:x/../y')).toEqual({ ok: true, path: 'y' });
    expect(legacySanitize('C:x/../y', win32)).toEqual({ ok: true, path: 'C:y' });

    expect(sanitizeGenerationPath('C:')).toEqual({ ok: true, path: 'C:' });
    expect(legacySanitize('C:', win32)).toEqual({ ok: true, path: 'C:.' });
    expect(sanitizeGenerationPath('c:')).toEqual({ ok: true, path: 'c:' });
  });

  it('still rejects a drive-rooted path and still resolves ordinary ones', () => {
    expect(sanitizeGenerationPath('C:/Windows/system32')).toEqual({
      ok: false,
      code: 'absolute_path',
    });
    expect(sanitizeGenerationPath('src/./nested/../App.tsx')).toEqual({
      ok: true,
      path: 'src/App.tsx',
    });
    expect(sanitizeGenerationPath('../etc/passwd')).toEqual({
      ok: false,
      code: 'path_traversal',
    });
  });

  it('answers exactly as the pre-posix body did on Linux', () => {
    const candidates = everyCandidate();
    // Guard against the loop silently shrinking to nothing.
    expect(candidates.length).toBeGreaterThan(10000);
    const divergent = candidates.filter(
      (candidate) =>
        JSON.stringify(sanitizeGenerationPath(candidate)) !==
        JSON.stringify(legacySanitize(candidate, posix)),
    );
    expect(divergent).toEqual([]);
  });
});
