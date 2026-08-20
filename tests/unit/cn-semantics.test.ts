import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESIGN_SYSTEM_FONT_SIZES, cn } from '@/utils/cn';

/**
 * F-637: two helpers called `cn` existed. `utils/cn.ts` (243 importers) wrapped
 * `classnames` and only concatenated, so a caller's `className` never overrode a
 * variant class — the winner was decided by stylesheet order. `lib/utils.ts`
 * (8 importers) wrapped `twMerge(clsx(...))` and did resolve conflicts.
 *
 * The audit's suggested one-line fix — point `utils/cn.ts` at the `twMerge`
 * version — is not safe here, and that is why this file asserts both directions.
 * A stock `twMerge` classifies any unrecognised `text-*` as a colour, so it
 * DELETES this design system's typography ramp: `twMerge('text-label-medium
 * text-heat-100')` returns `'text-heat-100'`. That would have silently stripped
 * a class from 13 `cn()` call sites (alert-dialog, dialog, card, tooltip,
 * fire-action-link, BrandKit, SectionHead) with a green build.
 */

const CONFLICT_CASES: [string[], string][] = [
  // Stock Tailwind conflicts: the later class wins, which is the whole point of
  // the shadcn `cn(base, className)` idiom.
  [['px-4', 'px-2'], 'px-2'],
  [['bg-white', 'bg-black'], 'bg-black'],
  [['text-left', 'text-center'], 'text-center'],
];

function sourceFiles() {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name)) out.push(path);
    }
  };
  for (const root of ['app', 'components', 'hooks', 'lib', 'utils']) walk(root);
  return out;
}

describe('cn is the single class helper', () => {
  it('nothing imports a second cn implementation', () => {
    const offenders = sourceFiles().filter((file) =>
      /import\s*\{[^}]*\bcn\b[^}]*\}\s*from\s*['"](?!@\/utils\/cn)[^'"]*['"]/.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('no module other than utils/cn.ts exports a function named cn', () => {
    const offenders = sourceFiles().filter(
      (file) =>
        file !== join('utils', 'cn.ts') &&
        /export\s+(?:function\s+cn\b|const\s+cn\b)/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});

describe('cn semantics', () => {
  it('resolves conflicting stock Tailwind utilities in favour of the last one', () => {
    for (const [input, expected] of CONFLICT_CASES) {
      expect(cn(...input), input.join(' ')).toBe(expected);
    }
  });

  it('never drops a design-system typography class for a colour class', () => {
    expect(cn('text-label-medium', 'text-heat-100')).toBe('text-label-medium text-heat-100');
    expect(cn('text-title-h5', 'text-accent-black')).toBe('text-title-h5 text-accent-black');
    expect(cn('text-body-medium', 'text-black-alpha-72')).toBe(
      'text-body-medium text-black-alpha-72',
    );
    // Two typography classes still conflict with each other.
    expect(cn('text-body-medium', 'text-title-h1')).toBe('text-title-h1');
  });

  it('accepts the classnames-era argument shapes the 243 call sites use', () => {
    expect(cn('a', false && 'b', undefined, null, ['c', 'd'])).toBe('a c d');
    expect(cn()).toBe('');
  });

  it('the registered font sizes are exactly the ones tailwind.config.ts defines', () => {
    const config = readFileSync('tailwind.config.ts', 'utf8');
    const block = config.slice(config.indexOf('fontSize: {'));
    const declared = [
      ...block.slice(0, block.indexOf('\n      },')).matchAll(/"([a-z0-9-]+)": \[/g),
    ].map((match) => match[1]);
    expect(declared.length).toBeGreaterThan(10);
    expect([...DESIGN_SYSTEM_FONT_SIZES].sort()).toEqual([...declared].sort());
  });
});
