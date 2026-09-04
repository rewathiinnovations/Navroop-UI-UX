import { describe, expect, it } from 'vitest';
import {
  describeIconSubstitutions,
  fixLucideImports,
  nearestIconName,
} from '@/lib/generation/fix-icon-imports';
import { isLucideIcon } from '@/lib/generation/lucide-icon-names';
import { createGenerationFileStore } from '@/lib/generation/tools/file-store';

/**
 * The incident: a generated dental clinic imported `{ Implant }` from
 * `lucide-react`. The static import scan skips bare specifiers by design and the
 * esbuild check treats the package as external, so the pipeline reported
 * "imports resolve and the build compiles" and the preview then died with
 *
 *   SyntaxError: The requested module 'lucide-react' does not provide an export
 *   named 'Implant'
 *
 * as the first thing the user saw after a build that had just claimed success.
 */

describe('the vendored icon list', () => {
  it('knows the names lucide actually ships', () => {
    for (const name of ['Smile', 'Stethoscope', 'ShoppingCart', 'LayoutDashboard', 'Sparkles']) {
      expect(isLucideIcon(name), name).toBe(true);
    }
  });

  it('rejects the names models invent for domain vocabulary', () => {
    // Every one of these is a plausible icon that has never existed.
    for (const name of ['Implant', 'Tooth', 'Molar', 'Dental', 'Toothbrush']) {
      expect(isLucideIcon(name), name).toBe(false);
    }
  });
});

describe('nearestIconName', () => {
  it('answers domain vocabulary with a curated synonym, not a spelling guess', () => {
    // `Tooth` is one edit from `Booth` and two from `Youth`; neither is about teeth.
    expect(nearestIconName('Tooth')).toBe('Smile');
    expect(nearestIconName('Implant')).toBe('Smile');
    expect(nearestIconName('Wishlist')).toBe('Heart');
    expect(nearestIconName('Dashboard')).toBe('LayoutDashboard');
  });

  it('reaches a synonym through a plural', () => {
    expect(nearestIconName('Dashboards')).toBe('LayoutDashboard');
    expect(nearestIconName('Notifications')).toBe('Bell');
  });

  it('corrects an ordinary misspelling', () => {
    expect(nearestIconName('Stethescope')).toBe('Stethoscope');
  });

  it('falls back to a neutral icon rather than a coincidence', () => {
    // Nothing within two edits and no synonym: a wrong-but-confident icon is
    // worse than an obviously neutral one.
    expect(nearestIconName('Xyzzy')).toBe('Circle');
  });

  it('only ever returns a name lucide exports', () => {
    for (const invalid of ['Implant', 'Tooth', 'Dashboards', 'Xyzzy', 'Cheveron', 'Wishlist']) {
      expect(isLucideIcon(nearestIconName(invalid)), invalid).toBe(true);
    }
  });
});

describe('fixLucideImports', () => {
  it('aliases the replacement to the local name, leaving the rest of the file alone', () => {
    const source = [
      'import { Implant, Sparkles } from "lucide-react";',
      'export default function Services() {',
      '  return <Implant className="size-5" />;',
      '}',
    ].join('\n');
    const result = fixLucideImports({ 'components/services.tsx': source });

    const fixed = result.files['components/services.tsx'];
    expect(fixed).toContain('Smile as Implant');
    // The usage site is untouched: that is the whole point of aliasing rather
    // than renaming, since a regex rename is where the next bug comes from.
    expect(fixed).toContain('<Implant className="size-5" />');
    expect(result.substitutions).toEqual([
      { file: 'components/services.tsx', from: 'Implant', to: 'Smile' },
    ]);
  });

  it('keeps valid names exactly as written', () => {
    const source = 'import { Star, ShoppingCart } from "lucide-react";';
    const result = fixLucideImports({ 'a.tsx': source });
    expect(result.files['a.tsx']).toBe(source);
    expect(result.substitutions).toEqual([]);
  });

  it('preserves an existing alias', () => {
    const result = fixLucideImports({
      'a.tsx': "import { Tooth as ToothIcon } from 'lucide-react';",
    });
    expect(result.files['a.tsx']).toContain('Smile as ToothIcon');
  });

  it('leaves a type-only import alone', () => {
    // It never reaches the runtime, so an unknown name there is tsc's problem
    // and rewriting it would change a type into a value.
    const source = "import type { LucideIcon } from 'lucide-react';";
    expect(fixLucideImports({ 'a.tsx': source }).files['a.tsx']).toBe(source);
  });

  it('ignores files that never mention the package', () => {
    const files = { 'a.ts': 'export const x = 1;' };
    expect(fixLucideImports(files).files).toEqual(files);
  });
});

describe('the tool write path', () => {
  it('repairs an icon on the way into the store, so nothing broken is ever persisted', () => {
    const store = createGenerationFileStore({ base: {}, stack: 'NEXTJS' });
    store.write(
      'components/hero.tsx',
      'import { Implant } from "lucide-react";\nexport default () => null;',
    );

    expect(store.writtenFiles()['components/hero.tsx']).toContain('Smile as Implant');
    expect(store.repairs().iconSubstitutions).toEqual([
      { file: 'components/hero.tsx', from: 'Implant', to: 'Smile' },
    ]);
    // `snapshot` is what the model is told the project looks like; it must agree
    // with what was stored, or the next turn edits a file that does not exist.
    expect(store.snapshot()['components/hero.tsx']).toContain('Smile as Implant');
  });
});

describe('describeIconSubstitutions', () => {
  it('says nothing when nothing was swapped', () => {
    expect(describeIconSubstitutions([])).toBeNull();
  });

  it('names every distinct swap once', () => {
    const notice = describeIconSubstitutions([
      { file: 'a.tsx', from: 'Implant', to: 'Smile' },
      { file: 'b.tsx', from: 'Implant', to: 'Smile' },
      { file: 'b.tsx', from: 'Wishlist', to: 'Heart' },
    ]);
    expect(notice).toContain('Implant to Smile');
    expect(notice).toContain('Wishlist to Heart');
    // Not twice: the same swap in two files is one fact about the build.
    expect(notice?.match(/Implant to Smile/g)).toHaveLength(1);
  });
});
