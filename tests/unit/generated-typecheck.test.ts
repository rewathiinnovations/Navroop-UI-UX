import { describe, expect, it } from 'vitest';
import { renderSectionUsage, SECTION_REGISTRY_NAMES } from '@/lib/stacks/section-registry';
import { typecheckGenerated } from '@/lib/validation/typecheck';

/**
 * The stage that makes `BuildErrorKind: 'type'` reachable, and the false positives it must not have.
 *
 * `checkBuild` runs esbuild, which strips types rather than reading them, so wrong props on a
 * section, a `.map` on a possibly-undefined value and a variant a component does not define
 * all bundle clean today and fail `next build` inside the client's own repository — where
 * nothing can repair them.
 *
 * The risk of adding it is the opposite failure, and it is the one this whole session has
 * been about: a blocking finding that is wrong spends a repair generation the user paid for.
 * So the first half of this file is realistic *correct* output that must produce nothing, and
 * only the second half is defects. If the passing half ever needs loosening to stay green,
 * the stage is not ready to block.
 */

const page = (body: string, imports = '') =>
  `${imports}
export default function Page() {
  return (
    <main>
${body}
    </main>
  );
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

describe('correct generated code produces nothing', () => {
  it('accepts a page built from every section the registry emits', () => {
    const imports = new Set<string>();
    const bodies: string[] = [];
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
    for (const name of SECTION_REGISTRY_NAMES) {
      const usage = renderSectionUsage(name, SAMPLES[name]);
      usage.imports.forEach((line) => imports.add(line));
      bodies.push(usage.jsx);
    }

    const result = check({ 'app/page.tsx': page(bodies.join('\n'), [...imports].join('\n')) });
    expect(
      result.errors.map((e) => `${e.file}: ${e.message}`),
      'no false positives',
    ).toEqual([]);
    expect(result.status).toBe('passed');
  }, 60_000);

  it('accepts ordinary hand-written page code using the primitives', () => {
    const source = page(
      '      <Button variant="premium">Go</Button>\n      <SectionHeader title="Hi" />',
      "import { Button } from '@/components/ui/button';\nimport { SectionHeader } from '@/components/ui/section-header';",
    );
    expect(check({ 'app/page.tsx': source }).errors).toEqual([]);
  }, 60_000);

  it('accepts the framework imports a generated Next page actually uses', () => {
    // next/image, next/link and next/navigation are not installed in this repository for the
    // *generated* project, and a stage that reported them would fail every real page.
    const source = page(
      '      <Image src="/a.png" alt="" width={10} height={10} />\n      <Link href="/x">x</Link>',
      "import Image from 'next/image';\nimport Link from 'next/link';\nimport { Zap } from 'lucide-react';",
    );
    expect(check({ 'app/page.tsx': source }).errors).toEqual([]);
  }, 60_000);

  it('says skipped, never passed, when there is nothing it can check', () => {
    const empty = typecheckGenerated({ stack: 'STATIC_HTML', files: { 'index.html': '<h1/>' } });
    expect(empty.status).toBe('skipped');
    expect(empty.skipReason).toBe('unsupported-stack');
  });
});

describe('the defects esbuild cannot see', () => {
  it('reports a prop the section does not have', () => {
    const source = page(
      '      <HeroSection title="T" heading="drifted" />',
      "import { HeroSection } from '@/components/sections/hero';",
    );
    const result = check({ 'app/page.tsx': source });

    expect(result.status).toBe('failed');
    expect(result.errors[0].kind).toBe('type');
    expect(result.errors.map((e) => e.message).join('\n')).toContain('heading');
  }, 60_000);

  it('reports required props a section was given none of', () => {
    const source = page(
      '      <CtaBand title="Start free" />',
      "import { CtaBand } from '@/components/sections/cta-band';",
    );
    const result = check({ 'app/page.tsx': source });

    expect(result.status).toBe('failed');
    expect(result.errors.map((e) => e.message).join('\n')).toContain('cta');
  }, 60_000);

  it('names the file and the line, because the repair has to open something', () => {
    const source = page(
      '      <HeroSection title="T" heading="x" />',
      "import { HeroSection } from '@/components/sections/hero';",
    );
    const [error] = check({ 'app/page.tsx': source }).errors;

    expect(error.file).toBe('app/page.tsx');
    expect(error.line).toBeGreaterThan(0);
  }, 60_000);

  it('reports a name that was never defined', () => {
    const result = check({ 'app/page.tsx': page('      <div>{missingThing}</div>') });
    expect(result.errors.map((e) => e.message).join('\n')).toMatch(/missingThing/);
  }, 60_000);
});

describe('what it refuses to blame this run for', () => {
  it('ignores a defect in a file this run did not touch', () => {
    const files = {
      'app/page.tsx': page('      <div>fine</div>'),
      'app/old/page.tsx': page(
        '      <HeroSection title="T" heading="x" />',
        "import { HeroSection } from '@/components/sections/hero';",
      ),
    };
    // The pre-existing file is in the map, because the compile needs the whole project —
    // but a run that edited one page must not be billed for a page it never opened.
    expect(check(files, ['app/page.tsx']).errors).toEqual([]);
  }, 60_000);

  it('never blames the starter kit, which the user did not write', () => {
    const result = check({ 'app/page.tsx': page('      <div>fine</div>') });
    expect(result.errors.filter((e) => e.file?.startsWith('components/'))).toEqual([]);
  }, 60_000);
});
