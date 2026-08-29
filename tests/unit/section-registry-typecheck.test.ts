import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { withStarterFiles } from '@/lib/stacks/starter';
import {
  SECTION_REGISTRY,
  SECTION_REGISTRY_NAMES,
  renderSectionUsage,
} from '@/lib/stacks/section-registry';

/**
 * The check the registry's accuracy actually rests on.
 *
 * `checkBuild` bundles with esbuild, which strips types rather than reading them, so it
 * cannot see a wrong prop — a page built from a drifted registry passes it with zero errors.
 * The registry is a hand-written claim about component props living in a second file, and the
 * stated reason that separation is safe is that something keeps the two honest. This is that
 * something.
 *
 * It runs a real `ts.createProgram` over the emitted page and the real section sources. The
 * program is rooted inside the repository so `react`, `clsx` and the Radix packages resolve
 * from the installed `node_modules` the way they do in a generated project.
 *
 * The negative control is not decoration: a checker that cannot fail is exactly the thing
 * this file replaced, so one test deliberately drifts a prop and asserts the drift is
 * reported. If that test ever passes silently, the guard is gone again.
 */

const SAMPLES: Record<string, Record<string, unknown>> = {
  hero: {
    title: 'Every crossing, one timetable',
    lede: 'Compare sailings across nine operators.',
    primaryCta: { label: 'Find a sailing', href: '/search' },
  },
  'feature-grid': {
    title: 'Why crews switch',
    items: [
      { title: 'Live berths', body: 'Availability straight from the operator.' },
      { title: 'One basket', body: 'Book several legs together.' },
    ],
  },
  'pricing-tiers': {
    title: 'Plans',
    tiers: [
      { name: 'Crew', price: '£29', features: ['Live berths'], actionLabel: 'Choose Crew' },
      { name: 'Fleet', price: '£99', features: ['Everything in Crew'], actionLabel: 'Talk to us' },
    ],
  },
  testimonials: {
    title: 'From the bridge',
    items: [{ quote: 'Cut our booking time in half.', name: 'A. Reid', role: 'Ops lead' }],
  },
  'logo-cloud': { label: 'Operators on board', items: ['Caledonian', 'NorthLink'] },
  'stats-band': {
    items: [
      { value: '9', label: 'Operators' },
      { value: '4k', label: 'Sailings' },
    ],
  },
  faq: { title: 'Questions', items: [{ question: 'Can I change a booking?', answer: 'Yes.' }] },
  'cta-band': { title: 'Start free', cta: { label: 'Create an account', href: '/signup' } },
  'contact-form': {
    title: 'Talk to us',
    fields: [{ name: 'email', label: 'Email', type: 'email', required: true }],
  },
  'site-footer': {
    brand: 'Crossings',
    columns: [{ title: 'Product', links: [{ label: 'Routes', href: '/routes' }] }],
  },
};

function pageFromRegistry(): string {
  const imports = new Set<string>();
  const bodies: string[] = [];
  for (const name of SECTION_REGISTRY_NAMES) {
    const usage = renderSectionUsage(name, SAMPLES[name]);
    usage.imports.forEach((line) => imports.add(line));
    bodies.push(usage.jsx);
  }
  return `${[...imports].sort().join('\n')}

export default function Page() {
  return (
    <main>
${bodies.join('\n')}
    </main>
  );
}
`;
}

/** A scratch project inside the repo, so module resolution finds the real node_modules. */
const scratchRoot = mkdtempSync(join(process.cwd(), 'tmp-section-typecheck-'));
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));

function semanticErrorsFor(pageSource: string): string[] {
  const files = withStarterFiles('NEXTJS', { 'app/page.tsx': pageSource }, 'editorial');
  for (const [path, content] of Object.entries(files)) {
    if (!/\.(tsx|ts)$/.test(path)) continue;
    const target = join(scratchRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }

  const entry = join(scratchRoot, 'app/page.tsx');
  const program = ts.createProgram([entry], {
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    noEmit: true,
    // The generated project's own dependencies are what these files type against; checking
    // their .d.ts files is not this test's job and costs seconds.
    skipLibCheck: true,
    esModuleInterop: true,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    baseUrl: scratchRoot,
    paths: { '@/*': ['./*'] },
  });

  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName.startsWith(scratchRoot.replace(/\\/g, '/')) || d.file)
    .map((d) => {
      const message = ts.flattenDiagnosticMessageText(d.messageText, ' ');
      const where = d.file ? d.file.fileName.slice(scratchRoot.length + 1) : '(global)';
      return `${where}: TS${d.code} ${message}`;
    });
}

describe('the registry type-checks against the components it describes', () => {
  it('emits a page with no type errors', () => {
    const errors = semanticErrorsFor(pageFromRegistry());
    expect(errors, errors.join('\n')).toEqual([]);
  }, 60_000);

  it('reports a prop the component does not have — the control that proves it can fail', () => {
    // Exactly the drift the old bundle-only check waved through.
    const drifted = pageFromRegistry().replace('<HeroSection', '<HeroSection heading="Drifted"');
    const errors = semanticErrorsFor(drifted);

    expect(errors.join('\n')).toContain('heading');
  }, 60_000);

  it('reports a required prop the registry stopped emitting', () => {
    const withoutCta = pageFromRegistry().replace(
      /<CtaBand[\s\S]*?\/>/,
      '<CtaBand title="Start free" />',
    );
    const errors = semanticErrorsFor(withoutCta);

    expect(errors.join('\n')).toContain('cta');
  }, 60_000);
});

describe('every catalogue section has a fixture', () => {
  it('covers the whole registry, so a new section cannot skip the check', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(Object.keys(SECTION_REGISTRY).sort());
  });
});
