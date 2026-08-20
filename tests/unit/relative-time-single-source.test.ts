import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from '@/lib/format-relative-time';

/**
 * F-754 / F-241: `lib/projects/prompt.ts` carried a second relative-time
 * formatter with different thresholds and different strings ('Just now' vs
 * 'just now', '3d ago' vs '3 days ago', a 14-day cutoff vs a 30-day month), so
 * the same age read differently in two places in the same UI. Its tail called
 * `date.toLocaleDateString()` with no locale, which resolves from the runtime
 * locale — different on the server and in the browser — so React reported a
 * hydration mismatch and the date could flip after hydration.
 *
 * `formatRelativeTime` takes an explicit `now`, so SSR and hydration can share
 * one clock, and never reaches a locale-dependent branch.
 */

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

function sourceFiles() {
  return ['app', 'components', 'lib', 'hooks'].flatMap((root) => walk(root));
}

describe('one relative-time formatter', () => {
  it('nothing exports or imports a second relativeTime helper', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      if (/export\s+function\s+relativeTime\b/.test(source)) offenders.push(`${file}: exports`);
      if (/\brelativeTime\b/.test(source) && !/formatRelativeTime/.test(source)) {
        offenders.push(`${file}: references`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('formatRelativeTime never falls through to a locale-dependent string', () => {
    const now = Date.parse('2026-08-20T12:00:00.000Z');
    const at = (ms: number) => formatRelativeTime(new Date(now - ms), now);
    expect(at(10_000)).toBe('just now');
    expect(at(5 * 60_000)).toBe('5 minutes ago');
    expect(at(3 * 3_600_000)).toBe('3 hours ago');
    expect(at(3 * 86_400_000)).toBe('3 days ago');
    expect(at(45 * 86_400_000)).toBe('2 months ago');
    // The 14-day cliff in the deleted copy handed everything older to
    // `toLocaleDateString()`; every branch here is locale-free.
    expect(at(800 * 86_400_000)).toBe('2 years ago');
  });
});

describe('client components print locale-pinned absolute dates', () => {
  it("no 'use client' module calls toLocale*() without a locale", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      if (!/^\s*(['"])use client\1/m.test(source)) continue;
      for (const match of source.matchAll(/\.toLocale(?:Date|Time)?String\(\s*\)/g)) {
        offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
