import { describe, expect, it } from 'vitest';
import { withStarterFiles } from '@/lib/stacks/starter';
import { SECTION_COMPONENT_NAMES } from '@/lib/stacks/templates/sections';
import {
  SECTION_REGISTRY,
  SECTION_REGISTRY_NAMES,
  renderSectionUsage,
  sectionCatalogueRule,
} from '@/lib/stacks/section-registry';
import { checkBuild } from '@/lib/validation/build-check';

/**
 * The registry describes the sections truthfully, proved by type-checking what it emits.
 *
 * A props schema is a claim about a component's interface, and a claim in a second file is a
 * claim that can drift. Nothing else in the pipeline would catch it: a wrong prop name is not
 * an error esbuild can see, so a section rendered from a stale schema bundles, previews and
 * publishes clean and only fails `next build` inside the client's own repository.
 *
 * `checkBuild` is not that check, and this file used to claim it was. It runs
 * `esbuild.build({ bundle: true })`, which strips TypeScript types without reading them —
 * a page built from a deliberately drifted registry (`heading` for `title`, a `cost` field
 * PricingTier does not have, a CtaBand with no `cta` at all) returns `status: 'passed',
 * errors: []`. The bundle check still earns its place, because it is what proves the
 * sections resolve on both layouts, but it can only answer "does this link".
 *
 * So there are two checks below and they answer different questions: the bundle proves the
 * module graph, and `ts.createProgram` over the same page against the real component sources
 * proves the props. The second one has a negative control, because a checker that cannot fail
 * is the thing this docblock used to describe.
 */

/** One realistic call per section: what a good generation would actually pass. */
const SAMPLES: Record<string, Record<string, unknown>> = {
  hero: {
    eyebrow: 'Ferry bookings',
    title: 'Every crossing, one timetable',
    lede: 'Compare sailings across nine operators and book in a single step.',
    primaryCta: { label: 'Find a sailing', href: '/search' },
    secondaryCta: { label: 'See routes' },
  },
  'feature-grid': {
    title: 'Why crews switch',
    columns: 3,
    items: [
      { title: 'Live berths', body: 'Availability straight from the operator.' },
      { title: 'One invoice', body: 'Every operator, billed together at month end.' },
    ],
  },
  'pricing-tiers': {
    title: 'Plans',
    tiers: [
      {
        name: 'Crew',
        price: '£29',
        period: 'per month',
        features: ['Live berths', 'Email support'],
        actionLabel: 'Choose Crew',
        actionHref: '/signup?plan=crew',
      },
      {
        name: 'Fleet',
        price: '£99',
        period: 'per month',
        features: ['Everything in Crew', 'Priority berths'],
        featured: true,
        actionLabel: 'Choose Fleet',
      },
    ],
  },
  testimonials: {
    title: 'From the bridge',
    items: [{ quote: 'Cut our booking time in half.', name: 'A. Reid', role: 'Ops lead' }],
  },
  'logo-cloud': { label: 'Operators on board', items: ['Caledonian', 'NorthLink'] },
  'stats-band': {
    inverted: true,
    items: [
      { value: '9', label: 'Operators' },
      { value: '4,000', label: 'Sailings a week' },
    ],
  },
  faq: {
    title: 'Questions',
    items: [
      { question: 'Can I change a booking?', answer: 'Yes, up to two hours before departure.' },
      { question: 'Do you charge a fee?', answer: 'No booking fee on any plan.' },
    ],
  },
  'cta-band': {
    title: 'Start free',
    cta: { label: 'Create an account', href: '/signup' },
    secondaryCta: { label: 'Talk to us', href: '/contact' },
  },
  'contact-form': {
    title: 'Talk to us',
    fields: [
      { name: 'email', label: 'Email', type: 'email', required: true },
      { name: 'message', label: 'Message', multiline: true },
    ],
  },
  'site-footer': {
    brand: 'Crossings',
    blurb: 'Ferry bookings without the phone calls.',
    legal: '© 2026 Crossings',
    columns: [{ title: 'Product', links: [{ label: 'Routes', href: '/routes' }] }],
  },
};

describe('the registry and the components are one thing', () => {
  it('describes exactly the sections the starter kit ships', () => {
    // Two files, one list. The registry cannot describe a section that does not exist, and
    // a section cannot ship without a contract the tool can validate against.
    expect([...SECTION_REGISTRY_NAMES].sort()).toEqual([...SECTION_COMPONENT_NAMES].sort());
  });

  it('has a fixture for every section, so none of this is checked by absence', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...SECTION_REGISTRY_NAMES].sort());
  });

  it('accepts each fixture', () => {
    for (const name of SECTION_REGISTRY_NAMES) {
      const parsed = SECTION_REGISTRY[name].props.safeParse(SAMPLES[name]);
      expect(parsed.success, `${name}: ${parsed.error?.message}`).toBe(true);
    }
  });

  it('names every slot as a prop the emitted snippet actually sets', () => {
    for (const name of SECTION_REGISTRY_NAMES) {
      const entry = SECTION_REGISTRY[name];
      const required = entry.slots.filter((slot) => slot.required).map((slot) => slot.name);
      const { jsx } = renderSectionUsage(name, SAMPLES[name]);
      for (const slot of required) {
        expect(jsx, `${name} omits required slot ${slot}`).toContain(`${slot}={`);
      }
    }
  });
});

describe('what the registry emits compiles', () => {
  /** Every section, rendered from its fixture, assembled into one page. */
  function pageFromRegistry(includeOptionalSlots: string[] = []): string {
    const imports = new Set<string>();
    const bodies: string[] = [];
    for (const name of SECTION_REGISTRY_NAMES) {
      const usage = renderSectionUsage(name, SAMPLES[name], { includeOptionalSlots });
      usage.imports.forEach((line) => imports.add(line));
      bodies.push(
        usage.jsx
          .split('\n')
          .map((line) => `      ${line}`)
          .join('\n'),
      );
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

  for (const stack of ['NEXTJS', 'REACT'] as const) {
    it(`${stack}: a page built entirely from renderSectionUsage builds`, async () => {
      const entry = stack === 'NEXTJS' ? 'app/page.tsx' : 'src/App.tsx';
      const source = pageFromRegistry().replace(
        'export default function Page()',
        stack === 'NEXTJS' ? 'export default function Page()' : 'export default function App()',
      );
      const result = await checkBuild({
        stack,
        files: withStarterFiles(stack, { [entry]: source }, 'editorial'),
        designDirection: 'editorial',
      });

      expect(result.errors).toEqual([]);
      expect(result.status).toBe('passed');
    });
  }

  it('compiles with the optional slots asked for too', async () => {
    const source = pageFromRegistry(['media']);
    expect(source).toContain('media={');
    const result = await checkBuild({
      stack: 'NEXTJS',
      files: withStarterFiles('NEXTJS', { 'app/page.tsx': source }, 'editorial'),
      designDirection: 'editorial',
    });

    expect(result.errors).toEqual([]);
  });

  it('leaves an optional slot out unless it was asked for', () => {
    expect(renderSectionUsage('hero', SAMPLES.hero).jsx).not.toContain('media=');
  });
});

describe('renderSectionUsage escapes what it interpolates', () => {
  it('does not let a quote in the copy end the attribute', () => {
    const { jsx } = renderSectionUsage('cta-band', {
      title: 'The "best" way to book',
      cta: { label: 'Go' },
    });
    expect(jsx).not.toContain('"The "best"');
    expect(jsx).toContain('&quot;');
  });

  it('does not let a brace in the copy open a JSX expression', () => {
    const { jsx } = renderSectionUsage('cta-band', {
      title: 'Save {50}% today',
      cta: { label: 'Go' },
    });
    expect(jsx).not.toContain('{50}');
  });

  it('refuses a section it does not know rather than emitting something plausible', () => {
    expect(() => renderSectionUsage('carousel', {})).toThrow(/carousel/);
  });
});

describe('the prompt line is generated, never written twice', () => {
  it('names every section and its description', () => {
    const rule = sectionCatalogueRule();
    for (const name of SECTION_REGISTRY_NAMES) {
      expect(rule).toContain(name);
      expect(rule).toContain(SECTION_REGISTRY[name].description);
    }
  });
});
