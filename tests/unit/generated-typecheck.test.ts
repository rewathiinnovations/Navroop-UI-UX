import { describe, expect, it } from 'vitest';
import { renderSectionUsage, SECTION_REGISTRY_NAMES } from '@/lib/stacks/section-registry';
import { typecheckGenerated } from '@/lib/validation/typecheck';

/**
 * The stage that makes `BuildErrorKind: 'type'` reachable, and the false positives it must not
 * have — plus the guarantee that the section registry still describes the real components.
 *
 * `checkBuild` runs esbuild, which strips types rather than reading them, so wrong props on a
 * section, a `.map` on a possibly-undefined value and a variant a component does not define
 * all bundle clean today and fail `next build` inside the client's own repository, where
 * nothing can repair them.
 *
 * The risk of adding it is the opposite failure, and it is the one this work keeps circling:
 * a blocking finding that is wrong spends a repair generation the user paid for. So the first
 * describe is realistic *correct* output that must produce nothing. If it ever needs loosening
 * to stay green, the stage is not ready to block.
 *
 * WHY THIS FILE IS STINGY WITH PROGRAMS. `ts.createProgram` is ~1s of pure CPU even warm, and
 * vitest runs files in parallel: an earlier version made ten separate programs and starved the
 * rest of the suite badly enough to time out an unrelated 60s test. Cases are batched into one
 * file map per program, with assertions attributing each finding to its own page. It also
 * absorbs what `section-registry-typecheck.test.ts` used to prove — the registry's emitted
 * props type-check against the real section sources — because that is the same guarantee
 * through the production code path, with no temp directory to leak into the working tree.
 */

const page = (body: string, imports = '') =>
  `${imports}
export default function Page() {
  return (<main>${body}</main>);
}
`;

function check(files: Record<string, string>, changedPaths?: string[]) {
  return typecheckGenerated({
    stack: 'NEXTJS',
    files,
    changedPaths: changedPaths ?? Object.keys(files),
    designDirection: 'editorial',
  });
}

/** Every section, rendered from the registry the way `use_section` would emit it. */
function registryPage(): string {
  const SAMPLES: Record<string, Record<string, unknown>> = {
    hero: { title: 'Every crossing', primaryCta: { label: 'Book', href: '/book' } },
    'feature-grid': {
      title: 'Why',
      items: [
        { title: 'A', body: 'one' },
        { title: 'B', body: 'two' },
      ],
    },
    'pricing-tiers': {
      title: 'Plans',
      tiers: [
        { name: 'Crew', price: '£29', features: ['x'], actionLabel: 'Pick' },
        { name: 'Fleet', price: '£99', features: ['y'], actionLabel: 'Talk' },
      ],
    },
    testimonials: { title: 'Quotes', items: [{ quote: 'Good.', name: 'A. Reid' }] },
    'logo-cloud': { items: ['One', 'Two'] },
    'stats-band': {
      items: [
        { value: '9', label: 'Ops' },
        { value: '4k', label: 'Sailings' },
      ],
    },
    faq: { title: 'Q', items: [{ question: 'How?', answer: 'Yes.' }] },
    'cta-band': { title: 'Start', cta: { label: 'Go', href: '/go' } },
    'contact-form': { title: 'Talk', fields: [{ name: 'email', label: 'Email' }] },
    'site-footer': {
      brand: 'Crossings',
      columns: [{ title: 'Product', links: [{ label: 'Routes', href: '/routes' }] }],
    },
  };
  const imports = new Set<string>();
  const bodies: string[] = [];
  for (const name of SECTION_REGISTRY_NAMES) {
    const usage = renderSectionUsage(name, SAMPLES[name]);
    usage.imports.forEach((line) => imports.add(line));
    bodies.push(usage.jsx);
  }
  return page(bodies.join('\n'), [...imports].join('\n'));
}

describe('correct generated code produces nothing', () => {
  // One program for every case that must be clean: the registry's own output, ordinary
  // primitive use, and the framework imports a real Next page carries.
  const clean = check({
    'app/page.tsx': registryPage(),
    'app/primitives/page.tsx': page(
      '<Button variant="premium">Go</Button><SectionHeader title="Hi" />',
      "import { Button } from '@/components/ui/button';\nimport { SectionHeader } from '@/components/ui/section-header';",
    ),
    'app/framework/page.tsx': page(
      '<Image src="/a.png" alt="" width={10} height={10} /><Link href="/x">x</Link><Zap />',
      "import Image from 'next/image';\nimport Link from 'next/link';\nimport { Zap } from 'lucide-react';",
    ),
  });

  it('accepts the registry’s own output, which is what keeps it honest', () => {
    // The Phase 2 guarantee, through the production stage: a props schema that drifted from
    // its component would show up here as a type error on the emitted page.
    expect(
      clean.errors.map((e) => `${e.file}: ${e.message}`),
      'no false positives',
    ).toEqual([]);
    expect(clean.status).toBe('passed');
  }, 60_000);

  it('accepts ordinary primitive use and the framework imports a Next page carries', () => {
    // next/image, next/link and lucide-react are the generated project's dependencies, not
    // this repository's; a stage that reported them would fail every real page.
    expect(clean.errors.filter((e) => e.file !== 'app/page.tsx')).toEqual([]);
  });

  it('says skipped, never passed, when there is nothing it can check', () => {
    const empty = typecheckGenerated({ stack: 'STATIC_HTML', files: { 'index.html': '<h1/>' } });
    expect(empty.status).toBe('skipped');
    expect(empty.skipReason).toBe('unsupported-stack');
  });
});

describe('the defects esbuild cannot see', () => {
  // One program, several broken pages, each finding attributed to its own file.
  const broken = check({
    'app/drift/page.tsx': page(
      '<HeroSection title="T" heading="drifted" />',
      "import { HeroSection } from '@/components/sections/hero';",
    ),
    'app/missing/page.tsx': page(
      '<CtaBand title="Start free" />',
      "import { CtaBand } from '@/components/sections/cta-band';",
    ),
    'app/undefined-name/page.tsx': page('<div>{missingThing}</div>'),
  });
  const messagesFor = (file: string) =>
    broken.errors
      .filter((e) => e.file === file)
      .map((e) => e.message)
      .join('\n');

  it('reports a prop the section does not have', () => {
    expect(broken.status).toBe('failed');
    expect(messagesFor('app/drift/page.tsx')).toContain('heading');
  }, 60_000);

  it('reports required props a section was given none of', () => {
    expect(messagesFor('app/missing/page.tsx')).toContain('cta');
  });

  it('reports a name that was never defined', () => {
    expect(messagesFor('app/undefined-name/page.tsx')).toMatch(/missingThing/);
  });

  it('names the file and the line, because the repair has to open something', () => {
    const [error] = broken.errors;
    expect(error.kind).toBe('type');
    expect(error.file).toBeTruthy();
    expect(error.line).toBeGreaterThan(0);
  });
});

describe('what it refuses to blame this run for', () => {
  it('ignores a defect in a file this run did not touch, and never blames the kit', () => {
    const files = {
      'app/page.tsx': page('<div>fine</div>'),
      'app/old/page.tsx': page(
        '<HeroSection title="T" heading="x" />',
        "import { HeroSection } from '@/components/sections/hero';",
      ),
    };
    // The pre-existing file is in the map, because the compile needs the whole project — but
    // a run that edited one page must not be billed for a page it never opened, and the
    // starter kit is not the user's code in either case.
    const result = check(files, ['app/page.tsx']);
    expect(result.errors).toEqual([]);
  }, 60_000);
});
