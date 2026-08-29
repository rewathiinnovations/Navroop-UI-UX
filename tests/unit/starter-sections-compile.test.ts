import { describe, expect, it } from 'vitest';
import { checkBuild } from '@/lib/validation/build-check';
import { withStarterFiles } from '@/lib/stacks/starter';
import { SECTION_COMPONENT_NAMES } from '@/lib/stacks/templates/starter-kit';
import { lockedStackRule } from '@/lib/stack-prompts/locked-stack';
import { checkGeneratedQuality } from '@/lib/validation/quality-check';

/**
 * The section layer, proved by compiling a page that uses all of it.
 *
 * A section component is only worth shipping if the same file bundles for both
 * layouts: `components/` is merged into NEXTJS and REACT alike, so a section
 * that reaches for `next/image` or framer-motion previews correctly in one
 * stack and fails `resolveBareSpecifier` — or, worse, passes the preview and
 * then fails `next build` inside the client's own repository after publish.
 * Compiling is the only check that cannot pass while that is true.
 */

/** A page that mounts every section, so no component can rot unnoticed. */
const PAGE = `import { HeroSection } from '@/components/sections/hero';
import { FeatureGrid } from '@/components/sections/feature-grid';
import { PricingTiers } from '@/components/sections/pricing-tiers';
import { Testimonials } from '@/components/sections/testimonials';
import { LogoCloud } from '@/components/sections/logo-cloud';
import { StatsBand } from '@/components/sections/stats-band';
import { Faq } from '@/components/sections/faq';
import { CtaBand } from '@/components/sections/cta-band';
import { ContactForm } from '@/components/sections/contact-form';
import { SiteFooter } from '@/components/sections/site-footer';
import { Button } from '@/components/ui/button';

export default function Page() {
  return (
    <main>
      <HeroSection
        eyebrow="Ferry bookings"
        title="Every crossing, one timetable"
        lede="Compare sailings across nine operators and book in a single step."
        primaryAction={<Button variant="premium">Find a sailing</Button>}
        secondaryAction={<Button variant="outline">See routes</Button>}
      />
      <LogoCloud label="Operators on board" items={['Caledonian', 'NorthLink']} />
      <FeatureGrid
        title="Why crews switch"
        items={[{ title: 'Live berths', body: 'Availability straight from the operator.' }]}
      />
      <StatsBand inverted items={[{ value: '9', label: 'Operators' }]} />
      <PricingTiers
        title="Plans"
        tiers={[
          {
            name: 'Crew',
            price: '£29',
            period: 'per month',
            features: ['Live berths'],
            featured: true,
            action: <Button className="w-full">Choose Crew</Button>,
          },
        ]}
      />
      <Testimonials
        title="From the bridge"
        items={[{ quote: 'Cut our booking time in half.', name: 'A. Reid', role: 'Ops lead' }]}
      />
      <Faq title="Questions" items={[{ question: 'Can I change a booking?', answer: 'Yes.' }]} />
      <ContactForm
        title="Talk to us"
        fields={[
          { name: 'email', label: 'Email', type: 'email', required: true },
          { name: 'message', label: 'Message', multiline: true },
        ]}
      />
      <CtaBand title="Start free" action={<Button variant="hero">Create an account</Button>} />
      <SiteFooter
        brand="Crossings"
        blurb="Ferry bookings without the phone calls."
        columns={[{ title: 'Product', links: [<a key="routes" href="/routes">Routes</a>] }]}
        legal="© 2026 Crossings"
      />
    </main>
  );
}
`;

const ENTRY: Record<string, Record<string, string>> = {
  NEXTJS: { 'app/page.tsx': PAGE },
  REACT: {
    'src/App.tsx': PAGE.replace('export default function Page()', 'export default function App()'),
  },
};

describe('the section layer compiles on both layouts', () => {
  for (const stack of ['NEXTJS', 'REACT'] as const) {
    it(`${stack}: a page composing every section builds`, async () => {
      const result = await checkBuild({
        stack,
        files: withStarterFiles(stack, ENTRY[stack], 'editorial'),
        designDirection: 'editorial',
      });

      expect(result.errors).toEqual([]);
      expect(result.status).toBe('passed');
    });
  }
});

describe('what the sections guarantee by construction', () => {
  const source = SECTION_COMPONENT_NAMES.map(
    (name) => withStarterFiles('NEXTJS', {}, 'editorial')[`components/sections/${name}.tsx`],
  );

  it('imports nothing a REACT project cannot resolve', () => {
    // `next/image` and `next/link` are the two every block library reaches for,
    // and either one turns this shared directory into a NEXTJS-only one.
    for (const file of source) {
      expect(file).not.toMatch(/from 'next\//);
      expect(file).not.toMatch(/from 'framer-motion'/);
    }
  });

  it('pins no colour, so a section inherits the project direction', () => {
    // The `raw-color` advisory exists because a model reaching for `text-gray-600`
    // is reaching for something the token set did not offer. The kit must not be
    // the thing teaching it that habit.
    for (const file of source) {
      expect(file).not.toMatch(/\b(bg|text|border)-(gray|slate|zinc|neutral|stone)-\d{2,3}\b/);
      expect(file).not.toMatch(/#[0-9a-fA-F]{6}\b/);
    }
  });

  it('carries its own entrance motion, which is the whole reason it exists', () => {
    // Three measured generations produced zero entrance animations. Machinery,
    // not prose: the section carries the observer so the page cannot skip it.
    // The footer is the deliberate exception — it sits below the fold at the end
    // of every page, where a reveal fires on arrival and reads as a glitch.
    const files = withStarterFiles('NEXTJS', {}, 'editorial');
    for (const name of SECTION_COMPONENT_NAMES) {
      if (name === 'site-footer') continue;
      expect(files[`components/sections/${name}.tsx`], name).toContain('<Reveal');
    }
  });

  it('does not satisfy no-motion or flat-rhythm by accident on a page that uses them', () => {
    const files = withStarterFiles('NEXTJS', ENTRY.NEXTJS, 'editorial');
    const kinds = checkGeneratedQuality({
      stack: 'NEXTJS',
      files,
      changedPaths: Object.keys(files),
    }).advisory.map((finding) => finding.kind);

    expect(kinds).not.toContain('no-motion');
    expect(kinds).not.toContain('flat-rhythm');
  });
});

describe('the prompt is generated from the same list', () => {
  it('names every section it ships, so the model cannot import one that is absent', () => {
    const rule = lockedStackRule('');
    for (const name of SECTION_COMPONENT_NAMES) {
      expect(rule).toContain(name);
    }
  });

  it('tells the model sections take rendered elements rather than URLs', () => {
    // The slot design only works if the prompt explains it; otherwise the model
    // passes `primaryAction="/signup"` and renders a string into the layout.
    expect(lockedStackRule('')).toMatch(/slots, not URLs/i);
  });
});
