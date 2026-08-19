import { describe, expect, it } from 'vitest';
import {
  describeImportProblems,
  scanImports,
  stripCommentsAndStrings,
  validateGeneratedImports,
} from '@/lib/generation/validate-imports';

/**
 * The failure these cover reached a real user: a build shipped
 * `import { site } from '@/lib/data'` against a `lib/data.ts` that exported
 * `siteConfig`, and the first sign of trouble was the preview bundler's own
 * `No matching export in "vfs:lib/data.ts" for import "site"` in a blank iframe.
 *
 * The other half of the suite is the false-positive guard. A wrong "invalid"
 * verdict blocks a working build and spends a generation rewriting correct code,
 * so a legitimately-correct app must produce exactly zero findings.
 */

/** A correct 15-file Next.js app, of the shape the model actually emits. */
const GOOD_APP: Record<string, string> = {
  'app/layout.tsx': [
    "import type { Metadata } from 'next';",
    "import './globals.css';",
    "import { Header } from '@/components/Header';",
    "import { Footer } from '@/components/Footer';",
    '',
    "export const metadata: Metadata = { title: 'Nordlys', description: 'Oslo bakery' };",
    '',
    'export default function RootLayout({ children }: { children: React.ReactNode }) {',
    '  return (',
    '    <html lang="nb">',
    '      <body>',
    '        <Header />',
    '        {children}',
    '        <Footer />',
    '      </body>',
    '    </html>',
    '  );',
    '}',
  ].join('\n'),
  'app/page.tsx': [
    "import Image from 'next/image';",
    "import { Hero } from '@/components/Hero';",
    "import { Menu } from '@/components/Menu';",
    "import { Button } from '@/components/ui/button';",
    "import { siteConfig } from '@/lib/data';",
    "import { formatPrice } from '@/lib/utils';",
    "import type { MenuItem } from '@/lib/types';",
    '',
    'export default function HomePage() {',
    '  const featured: MenuItem = siteConfig.menu[0];',
    '  return (',
    '    <main>',
    '      <Hero title={siteConfig.name} />',
    '      <Image src="/hero.jpg" alt="" width={1200} height={600} />',
    '      <Menu items={siteConfig.menu} />',
    '      <p>{formatPrice(featured.price)}</p>',
    '      <Button>Bestill</Button>',
    '    </main>',
    '  );',
    '}',
  ].join('\n'),
  'app/about/page.tsx': [
    "import { siteConfig } from '@/lib/data';",
    "import { Section } from '@/components';",
    '',
    'export default function AboutPage() {',
    '  return <Section title="Om oss">{siteConfig.story}</Section>;',
    '}',
  ].join('\n'),
  'app/globals.css': '@tailwind base;\n@tailwind components;\n@tailwind utilities;',
  'components/index.ts': [
    "export * from './Section';",
    "export { Header } from './Header';",
    "export { Footer } from './Footer';",
  ].join('\n'),
  'components/Header.tsx': [
    "import Link from 'next/link';",
    "import { siteConfig } from '@/lib/data';",
    '',
    'export function Header() {',
    '  return (',
    '    <header>',
    '      <Link href="/">{siteConfig.name}</Link>',
    '      {/* import { Legacy } from "./Legacy" — removed in the redesign */}',
    '    </header>',
    '  );',
    '}',
  ].join('\n'),
  'components/Footer.tsx': [
    "import { siteConfig } from '@/lib/data';",
    '',
    'export function Footer() {',
    '  return <footer>© {new Date().getFullYear()} {siteConfig.name}</footer>;',
    '}',
  ].join('\n'),
  'components/Hero.tsx': [
    "import { motion } from 'framer-motion';",
    "import { cn } from '@/lib/utils';",
    '',
    'export type HeroProps = { title: string; className?: string };',
    '',
    'export function Hero({ title, className }: HeroProps) {',
    '  return <motion.h1 className={cn("text-5xl", className)}>{title}</motion.h1>;',
    '}',
  ].join('\n'),
  'components/Menu.tsx': [
    "import type { MenuItem } from '@/lib/types';",
    "import { formatPrice } from '@/lib/utils';",
    '',
    'export function Menu({ items }: { items: MenuItem[] }) {',
    '  return <ul>{items.map((item) => <li key={item.id}>{formatPrice(item.price)}</li>)}</ul>;',
    '}',
  ].join('\n'),
  'components/Section.tsx': [
    'export function Section({ title, children }: { title: string; children: React.ReactNode }) {',
    '  return <section><h2>{title}</h2>{children}</section>;',
    '}',
  ].join('\n'),
  'components/ui/button.tsx': [
    "import { cn } from '@/lib/utils';",
    '',
    'export const buttonVariants = { primary: "bg-black text-white" };',
    '',
    'export function Button({ className, ...props }: React.ComponentProps<"button">) {',
    '  return <button className={cn(buttonVariants.primary, className)} {...props} />;',
    '}',
  ].join('\n'),
  'lib/data.ts': [
    "import type { SiteConfig } from './types';",
    '',
    'export const siteConfig: SiteConfig = {',
    "  name: 'Nordlys',",
    "  story: 'Baking since 1998.',",
    "  menu: [{ id: '1', name: 'Kanelbolle', price: 45 }],",
    '};',
  ].join('\n'),
  'lib/types.ts': [
    'export type MenuItem = { id: string; name: string; price: number };',
    'export interface SiteConfig {',
    '  name: string;',
    '  story: string;',
    '  menu: MenuItem[];',
    '}',
  ].join('\n'),
  'lib/utils.ts': [
    "import { clsx, type ClassValue } from 'clsx';",
    "import { twMerge } from 'tailwind-merge';",
    '',
    'export function cn(...inputs: ClassValue[]) {',
    '  return twMerge(clsx(inputs));',
    '}',
    '',
    'export const formatPrice = (value: number) => `${value} kr`;',
  ].join('\n'),
  'package.json': '{ "name": "nordlys" }',
};

describe('validateGeneratedImports — the missing-export incident', () => {
  it('fails the exact lib/data.ts / import { site } case, naming the file and the symbol', () => {
    const result = validateGeneratedImports({
      files: {
        ...GOOD_APP,
        'app/page.tsx': [
          "import { site } from '@/lib/data';",
          'export default function HomePage() { return <h1>{site.name}</h1>; }',
        ].join('\n'),
      },
    });

    expect(result.problems).toHaveLength(1);
    const [problem] = result.problems;
    expect(problem.kind).toBe('missing-named-export');
    expect(problem.file).toBe('app/page.tsx');
    expect(problem.symbol).toBe('site');
    expect(problem.line).toBe(1);
    // The message has to work as chat copy and as repair copy on its own.
    expect(problem.message).toContain('app/page.tsx');
    expect(problem.message).toContain('lib/data.ts');
    expect(problem.message).toContain('site');
    expect(problem.message).toContain('siteConfig');
  });

  it('reports a relative import of a file nobody generated', () => {
    const result = validateGeneratedImports({
      files: {
        'src/App.tsx': [
          "import { Testimonials } from './Testimonials';",
          'export default () => <Testimonials />;',
        ].join('\n'),
      },
    });

    expect(result.problems).toHaveLength(1);
    expect(result.problems[0].kind).toBe('unresolved-import');
    expect(result.problems[0].message).toContain('./Testimonials');
  });

  it('reports a default import from a file with only named exports', () => {
    const result = validateGeneratedImports({
      files: {
        'src/App.tsx': ["import Hero from './Hero';", 'export default () => <Hero />;'].join('\n'),
        'src/Hero.tsx': 'export function Hero() { return <h1>Hi</h1>; }',
      },
    });

    expect(result.problems).toHaveLength(1);
    expect(result.problems[0].kind).toBe('missing-default-export');
    expect(result.problems[0].symbol).toBe('default');
  });

  it('reports a file that imports itself', () => {
    const result = validateGeneratedImports({
      files: {
        'src/App.tsx': [
          "import { helper } from './App';",
          'export function helper() { return 1; }',
          'export default () => <p>{helper()}</p>;',
        ].join('\n'),
      },
    });

    expect(result.problems.map((problem) => problem.kind)).toContain('self-import');
  });

  it('reports a name re-exported from a barrel that does not have it', () => {
    const result = validateGeneratedImports({
      files: {
        'components/index.ts': "export { Hero, Pricing } from './Hero';",
        'components/Hero.tsx': 'export function Hero() { return <h1>Hi</h1>; }',
      },
    });

    expect(result.problems).toHaveLength(1);
    expect(result.problems[0].symbol).toBe('Pricing');
    expect(result.problems[0].message).toContain('re-exports');
  });

  it('caps the copy rather than emitting a wall of findings', () => {
    const files: Record<string, string> = { 'lib/data.ts': 'export const ok = 1;' };
    for (let index = 0; index < 30; index += 1) {
      files[`components/C${index}.tsx`] =
        `import { gone } from '@/lib/data';\nexport const C${index} = gone;`;
    }
    expect(validateGeneratedImports({ files }).problems.length).toBeLessThanOrEqual(12);
  });
});

describe('validateGeneratedImports — a rewritten module breaks its consumers', () => {
  /**
   * The live incident. A follow-up rewrote `lib/site.ts`, consolidating a dozen
   * exported constants into one `SITE` object, and returned that single file. Eight
   * untouched components kept importing SITE_NAME, EMAIL, HOURS and PHONE_TEL from
   * it. Every broken importer was outside the run's scope, so the check reported
   * nothing, the build was called finished, and the preview then refused to compile
   * with fifteen missing exports.
   *
   * Reproduced against the real project's files: scope `['lib/site.ts']` reported 0
   * problems before this, 12 after.
   */
  const CONSOLIDATED = {
    'lib/site.ts': 'export const SITE = { name: "Cinder & Sage", email: "hi@example.com" };',
    'app/page.tsx':
      'import { SITE_NAME, EMAIL } from "@/lib/site";\nexport default function Page() { return <p>{SITE_NAME}{EMAIL}</p>; }',
    'components/Footer.tsx':
      'import { PHONE_TEL } from "@/lib/site";\nexport default function Footer() { return <a href={PHONE_TEL} />; }',
  };

  it('blames the run that changed the exports, not the files that still import them', () => {
    const result = validateGeneratedImports({ files: CONSOLIDATED, scope: ['lib/site.ts'] });

    const symbols = result.problems.map((problem) => problem.symbol);
    expect(symbols).toContain('SITE_NAME');
    expect(symbols).toContain('EMAIL');
    expect(symbols).toContain('PHONE_TEL');
    // The message has to name the consumer, because that is the file to edit.
    expect(result.problems.some((problem) => problem.file === 'components/Footer.tsx')).toBe(true);
  });

  it('says what the module does export, so the repair is obvious', () => {
    const result = validateGeneratedImports({ files: CONSOLIDATED, scope: ['lib/site.ts'] });

    expect(result.problems[0]?.message).toContain('lib/site.ts exports: SITE');
  });

  it('still ignores breakage in files this run had nothing to do with', () => {
    // Both ends out of scope: pre-existing, and failing a good build for it would
    // make every later edit inherit someone else's bug.
    const files = {
      ...CONSOLIDATED,
      'components/Unrelated.tsx': 'import { GONE } from "@/lib/other";\nexport default () => null;',
      'lib/other.ts': 'export const KEPT = 1;',
    };

    const result = validateGeneratedImports({ files, scope: ['lib/site.ts'] });

    expect(result.problems.some((problem) => problem.symbol === 'GONE')).toBe(false);
  });

  it('reports a consumer once per missing symbol, not once per file', () => {
    const result = validateGeneratedImports({ files: CONSOLIDATED, scope: ['lib/site.ts'] });

    const pageProblems = result.problems.filter((problem) => problem.file === 'app/page.tsx');
    expect(pageProblems).toHaveLength(2);
  });
});

describe('validateGeneratedImports — the false-positive guard', () => {
  it('finds nothing in a correct 15-file Next.js app', () => {
    const result = validateGeneratedImports({ files: GOOD_APP });
    expect(result.problems).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.checkedFiles).toBeGreaterThan(10);
  });

  it('passes bare package imports, which are a dependency question', () => {
    const result = validateGeneratedImports({
      files: {
        'app/page.tsx': [
          "import Image from 'next/image';",
          "import Link from 'next/link';",
          "import { useState } from 'react';",
          "import { ArrowRight } from 'lucide-react';",
          "import { motion } from 'framer-motion';",
          'export default function Page() {',
          '  const [open] = useState(false);',
          '  return <Link href="/"><Image src="/a.jpg" alt="" width={1} height={1} />{open}<ArrowRight /><motion.div /></Link>;',
          '}',
        ].join('\n'),
      },
    });
    expect(result.problems).toEqual([]);
  });

  it('passes a type-only import of a type that exists', () => {
    const result = validateGeneratedImports({
      files: {
        'app/page.tsx': [
          "import type { MenuItem } from '@/lib/types';",
          "import { type SiteConfig, load } from '@/lib/data';",
          'export default function Page(props: { item: MenuItem; config: SiteConfig }) {',
          '  return <p>{load(props.item.id)}{props.config.name}</p>;',
          '}',
        ].join('\n'),
        'lib/types.ts': 'export type MenuItem = { id: string };',
        'lib/data.ts': [
          'export interface SiteConfig { name: string }',
          'export function load(id: string) { return id; }',
        ].join('\n'),
      },
    });
    expect(result.problems).toEqual([]);
  });

  it('resolves names through export * re-exports, one hop and two', () => {
    const result = validateGeneratedImports({
      files: {
        'app/page.tsx': [
          "import { Hero, Pricing, Faq } from '@/components';",
          'export default () => <><Hero /><Pricing /><Faq /></>;',
        ].join('\n'),
        'components/index.ts': ["export * from './Hero';", "export * from './sections';"].join(
          '\n',
        ),
        'components/Hero.tsx': 'export function Hero() { return <h1>Hi</h1>; }',
        'components/sections/index.ts': [
          "export * from './Pricing';",
          "export { Faq } from './Faq';",
        ].join('\n'),
        'components/sections/Pricing.tsx': 'export const Pricing = () => <div />;',
        'components/sections/Faq.tsx': 'export function Faq() { return <div />; }',
      },
    });
    expect(result.problems).toEqual([]);
  });

  it('stays quiet when a barrel re-exports from somewhere it cannot read', () => {
    // An unknown export set can never contradict an import: the name might well
    // be there, and a rewrite of correct code is the worse outcome.
    const result = validateGeneratedImports({
      files: {
        'app/page.tsx':
          "import { Anything } from '@/components';\nexport default () => <Anything />;",
        'components/index.ts': "export * from 'some-ui-kit';",
      },
    });
    expect(result.problems).toEqual([]);
  });

  it('ignores a commented-out import of a deleted file', () => {
    const result = validateGeneratedImports({
      files: {
        'src/App.tsx': [
          "// import { Legacy } from './Legacy';",
          '/*',
          " * import { Older } from './Older';",
          ' */',
          'export default () => <p>Hi</p>;',
        ].join('\n'),
      },
    });
    expect(result.problems).toEqual([]);
  });

  it('ignores an import written inside a string or template literal', () => {
    const result = validateGeneratedImports({
      files: {
        'src/App.tsx': [
          'const snippet = `',
          "import { Missing } from './nowhere';",
          '`;',
          'const other = "import { AlsoMissing } from \'./nope\'";',
          'export default () => <pre>{snippet}{other}</pre>;',
        ].join('\n'),
      },
    });
    expect(result.problems).toEqual([]);
  });

  it('does not blame the model for a problem in a file it did not touch', () => {
    const files = {
      'app/page.tsx': "import { Hero } from '@/components/Hero';\nexport default () => <Hero />;",
      'components/Hero.tsx': 'export function Hero() { return <h1>Hi</h1>; }',
      'app/legacy/page.tsx': "import { Gone } from '@/lib/gone';\nexport default () => <Gone />;",
    };

    expect(validateGeneratedImports({ files }).problems).toHaveLength(1);
    expect(
      validateGeneratedImports({ files, scope: ['app/page.tsx', 'components/Hero.tsx'] }).problems,
    ).toEqual([]);
  });

  it('recognises destructured and aliased exports', () => {
    const result = validateGeneratedImports({
      files: {
        'app/page.tsx': [
          "import { primary, secondary as accent, THEME } from '@/lib/theme';",
          'export default () => <p>{primary}{accent}{THEME}</p>;',
        ].join('\n'),
        'lib/theme.ts': [
          'const palette = { primary: "#000", secondary: "#fff" };',
          'export const { primary, secondary } = palette;',
          'const theme = palette;',
          'export { theme as THEME };',
        ].join('\n'),
      },
    });
    expect(result.problems).toEqual([]);
  });

  it('stays quiet about a CommonJS module, whose exports it cannot enumerate', () => {
    const result = validateGeneratedImports({
      files: {
        'src/App.jsx': "import { anything } from './legacy';\nexport default () => anything;",
        'src/legacy.js': 'module.exports = { anything: 1 };',
      },
    });
    expect(result.problems).toEqual([]);
  });

  it('stays quiet when the name is in the target but the export form was missed', () => {
    // The suppression guard: the scanner does not understand a conditional
    // export, and `pricing` is right there in the file, so a rewrite would be
    // the wrong call.
    const result = validateGeneratedImports({
      files: {
        'app/page.tsx':
          "import { pricing } from '@/lib/data';\nexport default () => <p>{pricing}</p>;",
        'lib/data.ts': [
          'const pricing = 42;',
          'export const bundle = { pricing };',
          'Object.assign(module, {});',
        ].join('\n'),
      },
    });
    expect(result.problems).toEqual([]);
  });

  it('still checks symbols in a file whose exports come before its imports', () => {
    // Regression: a permissive clause pattern matched from an earlier `export`
    // to the next `from`, so every import in a file like this was misread as one
    // re-export and lost its symbol check.
    const result = validateGeneratedImports({
      files: {
        'lib/config.ts': [
          'export const revalidate = 3600;',
          "export const dynamic = 'force-static';",
          "import { helper } from './helper';",
          'export const value = helper();',
        ].join('\n'),
        'lib/helper.ts': 'export function other() { return 1; }',
      },
    });
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0].symbol).toBe('helper');
  });

  it('accepts a default re-exported under a name', () => {
    const result = validateGeneratedImports({
      files: {
        'app/page.tsx': "import { Hero } from '@/components';\nexport default () => <Hero />;",
        'components/index.ts': "export { default as Hero } from './Hero';",
        'components/Hero.tsx': 'export default function Hero() { return <h1>Hi</h1>; }',
      },
    });
    expect(result.problems).toEqual([]);
  });

  it('reports a named import of a declaration the target exports as default', () => {
    // The one case where the name being in the target proves the import wrong:
    // the bundler reports no matching export, and the fix is dropping the braces.
    const result = validateGeneratedImports({
      files: {
        'app/page.tsx': "import { Hero } from '@/components/Hero';\nexport default () => <Hero />;",
        'components/Hero.tsx': 'export default function Hero() { return <h1>Hi</h1>; }',
      },
    });

    expect(result.problems).toHaveLength(1);
    expect(result.problems[0].symbol).toBe('Hero');
    expect(result.problems[0].message).toContain("import Hero from '@/components/Hero'");
  });

  it('ignores declaration files, which resolve by TypeScript rules and not the bundler’s', () => {
    // Scanning these produced the only findings in a 1,270-file sweep of this
    // repo, and every one was wrong: a `.d.ts` writing `./tokens.js` means
    // `./tokens.ts`, a rewrite the preview resolver does not perform, and nothing
    // bundles a declaration file anyway.
    const result = validateGeneratedImports({
      files: {
        'types/sdk.d.ts': "export type { Token } from './tokens.js';",
        'types/tokens.ts': 'export type Token = string;',
      },
    });
    expect(result.problems).toEqual([]);
  });

  it('reports a circular import as a warning, never as something to rewrite', () => {
    const result = validateGeneratedImports({
      files: {
        'lib/a.ts': "import { b } from './b';\nexport const a = () => b();",
        'lib/b.ts': "import { a } from './a';\nexport const b = () => a();",
      },
    });
    expect(result.problems).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].kind).toBe('import-cycle');
    expect(result.warnings[0].message).toContain('lib/a.ts');
    expect(result.warnings[0].message).toContain('lib/b.ts');
  });
});

describe('scanImports and stripCommentsAndStrings', () => {
  it('reads every import form the model emits', () => {
    const statements = scanImports(
      [
        "import React, { useState, useEffect as onMount } from 'react';",
        "import * as utils from './utils';",
        "import type { Props } from './types';",
        "import './globals.css';",
        "const mod = await import('./lazy');",
        "export { Hero } from './Hero';",
        "export * from './sections';",
      ].join('\n'),
    );

    const bySpecifier = Object.fromEntries(
      statements.map((statement) => [statement.specifier, statement]),
    );
    expect(bySpecifier.react.default).toBe(true);
    expect(bySpecifier.react.named).toEqual(['useState', 'useEffect']);
    expect(bySpecifier['./utils'].named).toEqual([]);
    expect(bySpecifier['./types'].default).toBe(false);
    expect(bySpecifier['./globals.css'].named).toEqual([]);
    expect(bySpecifier['./lazy'].dynamic).toBe(true);
    expect(bySpecifier['./Hero'].reexport).toBe(true);
    expect(bySpecifier['./sections'].specifier).toBe('./sections');
  });

  it('keeps line numbers pointing at the line the user sees', () => {
    const statements = scanImports(
      ['// a comment', '', '/* another', '   one */', "import { x } from './x';"].join('\n'),
    );
    expect(statements[0].line).toBe(5);
  });

  it('blanks string bodies but keeps specifiers readable', () => {
    const stripped = stripCommentsAndStrings(
      ["const label = 'Order now, from our menu';", "import { x } from './x';"].join('\n'),
    );
    expect(stripped).not.toContain('Order now');
    expect(stripped).toContain("'./x'");
    // Offsets survive so reported lines stay honest.
    expect(stripped.split('\n')).toHaveLength(2);
  });
});

describe('describeImportProblems', () => {
  it('summarises one problem and counts the rest', () => {
    const one = validateGeneratedImports({
      files: { 'src/App.tsx': "import './missing';\nexport default () => null;" },
    });
    expect(describeImportProblems(one)).toContain('src/App.tsx');

    const clean = validateGeneratedImports({ files: GOOD_APP });
    expect(describeImportProblems(clean)).toBe('No import problems found.');
  });
});
