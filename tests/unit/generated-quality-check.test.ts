import { describe, expect, it } from 'vitest';
import { checkGeneratedQuality } from '@/lib/validation/quality-check';

/**
 * Defects that compile.
 *
 * Both of the blocking classes here shipped to a user on a build the pipeline
 * called clean: a final CTA whose "Call Us Now" button was cream text on a
 * transparent variant over a cream band — an empty white rectangle — and a nav
 * that linked to routes no page file rendered.
 */

const page = (body: string) => `export default function Page() { return (${body}); }`;

describe('links that go nowhere', () => {
  it('reports a link to a route no page file renders', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: {
        'app/page.tsx': page('<a href="/shop">Shop</a>'),
      },
      changedPaths: ['app/page.tsx'],
    });
    expect(result.blocking.map((finding) => finding.kind)).toEqual(['missing-route']);
    expect(result.blocking[0].message).toContain('/shop');
    expect(result.instruction).toContain('app/shop/page.tsx');
  });

  it('accepts a link to a route that exists', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: {
        'app/page.tsx': page('<a href="/shop">Shop</a>'),
        'app/shop/page.tsx': page('<h1>Shop</h1>'),
      },
      changedPaths: ['app/page.tsx'],
    });
    expect(result.blocking).toEqual([]);
  });

  it('matches a dynamic segment', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: {
        'app/shop/page.tsx': page('<a href="/product/blue-mug">Blue mug</a>'),
        'app/product/[slug]/page.tsx': page('<h1>Product</h1>'),
      },
      changedPaths: ['app/shop/page.tsx'],
    });
    expect(result.blocking).toEqual([]);
  });

  it('sees through a route group, which is not a URL segment', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: {
        'app/(site)/page.tsx': page('<a href="/about">About</a>'),
        'app/(site)/about/page.tsx': page('<h1>About</h1>'),
      },
      changedPaths: ['app/(site)/page.tsx'],
    });
    expect(result.blocking).toEqual([]);
  });

  it('leaves external, mail, tel and anchor links alone', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: {
        'app/page.tsx': page(
          '<><a href="https://maps.google.com">Map</a><a href="mailto:hi@x.com">Mail</a><a href="tel:+910000000000">Call</a><a href="#services">Services</a></>',
        ),
      },
      changedPaths: ['app/page.tsx'],
    });
    expect(result.blocking).toEqual([]);
  });

  it('does not guess at a templated href', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: {
        'app/page.tsx': 'export default () => <a href={`/product/${slug}`}>x</a>;',
        'app/product/[slug]/page.tsx': page('<h1>x</h1>'),
      },
      changedPaths: ['app/page.tsx'],
    });
    expect(result.blocking).toEqual([]);
  });

  it('reports a placeholder href', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: { 'app/page.tsx': page('<a href="#">Book</a>') },
      changedPaths: ['app/page.tsx'],
    });
    expect(result.blocking.map((finding) => finding.kind)).toEqual(['placeholder-link']);
  });

  it('says nothing about routes when the project has no page files to compare against', () => {
    // Mid-edit, or a stack with no app directory: every href would be reported
    // and every report would be wrong.
    const result = checkGeneratedQuality({
      stack: 'REACT',
      files: { 'src/App.tsx': page('<a href="/shop">Shop</a>') },
      changedPaths: ['src/App.tsx'],
    });
    expect(result.blocking).toEqual([]);
  });
});

describe('controls that disappear', () => {
  it('reports a transparent variant given a light foreground and no background', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: {
        'app/page.tsx': page(
          '<Button variant="outline" className="border-primary-foreground/30 text-primary-foreground">Call us now</Button>',
        ),
      },
      changedPaths: ['app/page.tsx'],
    });
    expect(result.blocking.map((finding) => finding.kind)).toEqual(['invisible-control']);
    expect(result.instruction).toContain('cva variant');
  });

  it('accepts the pair when the call site sets a background too', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: {
        'app/page.tsx': page(
          '<Button variant="outline" className="bg-primary text-primary-foreground">Call us now</Button>',
        ),
      },
      changedPaths: ['app/page.tsx'],
    });
    expect(result.blocking).toEqual([]);
  });

  it('ignores a variant that brings its own background', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: {
        'app/page.tsx': page(
          '<Button variant="default" className="text-primary-foreground">Book</Button>',
        ),
      },
      changedPaths: ['app/page.tsx'],
    });
    expect(result.blocking).toEqual([]);
  });
});

describe('advisories', () => {
  it('flags a raw img on the Next.js stack without blocking the build', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: { 'app/page.tsx': page('<img src="/a.webp" alt="a" width={8} height={8} />') },
      changedPaths: ['app/page.tsx'],
    });
    expect(result.advisory.map((finding) => finding.kind)).toContain('raw-img');
    // Advisories never earn a billed repair on their own.
    expect(result.blocking).toEqual([]);
    expect(result.instruction).toBe('');
  });

  it('flags a raw colour and an inline style', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: { 'app/page.tsx': page('<div className="bg-[#2563EB] text-white" />') },
      changedPaths: ['app/page.tsx'],
    });
    expect(result.advisory.map((finding) => finding.kind)).toContain('raw-color');
  });
});

describe('scope', () => {
  it('never reports a defect in a file this run did not write', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: {
        'app/page.tsx': page('<h1>Home</h1>'),
        'components/legacy.tsx': page('<a href="/gone">Gone</a>'),
      },
      changedPaths: ['app/page.tsx'],
    });
    expect(result.blocking).toEqual([]);
  });

  it('ignores comments, so a commented-out link is not a dead link', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: { 'app/page.tsx': `// <a href="/gone">x</a>\n${page('<h1>Home</h1>')}` },
      changedPaths: ['app/page.tsx'],
    });
    expect(result.blocking).toEqual([]);
  });
});

describe('nav arrays', () => {
  it('reads the object-literal spelling a generated header uses', () => {
    // `const nav = [{ name: 'About', href: '/about' }]` is how most generated
    // headers are written. A scanner that only knew the JSX attribute read a
    // header with five dead links as clean.
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: {
        'components/header.tsx':
          "const nav = [{ name: 'About', href: '/about' }, { name: 'Shop', href: '/shop' }];\nexport default function Header() { return null; }",
        'app/page.tsx': page('<h1>Home</h1>'),
        'app/about/page.tsx': page('<h1>About</h1>'),
      },
      changedPaths: ['components/header.tsx'],
    });
    expect(result.blocking.map((finding) => finding.kind)).toEqual(['missing-route']);
    expect(result.blocking[0].message).toContain('/shop');
  });
});

describe('an action link swallowed by a dynamic route', () => {
  it('reports /shipments/new when only [id] exists', () => {
    // Next.js resolves this to the detail page with an id of "new", so it does
    // not 404 — it renders the wrong page. A generated logistics dashboard
    // shipped with its primary "Add shipment" CTA doing exactly that.
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: {
        'app/page.tsx': page('<a href="/shipments/new">Add shipment</a>'),
        'app/shipments/page.tsx': page('<h1>Shipments</h1>'),
        'app/shipments/[id]/page.tsx': page('<h1>Detail</h1>'),
      },
      changedPaths: ['app/page.tsx'],
    });
    expect(result.blocking.map((finding) => finding.kind)).toEqual(['missing-route']);
    expect(result.blocking[0].message).toContain('swallowed by the dynamic route');
  });

  it('accepts it once the page exists', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: {
        'app/page.tsx': page('<a href="/shipments/new">Add shipment</a>'),
        'app/shipments/[id]/page.tsx': page('<h1>Detail</h1>'),
        'app/shipments/new/page.tsx': page('<h1>New</h1>'),
      },
      changedPaths: ['app/page.tsx'],
    });
    expect(result.blocking).toEqual([]);
  });

  it('leaves a real identifier alone', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: {
        'app/page.tsx': page('<a href="/shipments/RW-4821">RW-4821</a>'),
        'app/shipments/[id]/page.tsx': page('<h1>Detail</h1>'),
      },
      changedPaths: ['app/page.tsx'],
    });
    expect(result.blocking).toEqual([]);
  });
});

describe('whole-page craft advisories', () => {
  const files = (page: string) => ({
    'app/page.tsx': page,
    'components/a.tsx': page,
    'components/b.tsx': page,
    'components/c.tsx': page,
    'components/d.tsx': page,
  });

  it('flags a build with sections but no motion and no surface changes', () => {
    // The measured signature of template-default output: three full generation
    // runs, zero animations, every section on the same background.
    const flat = page(
      '<><section className="py-16">a</section><section className="py-16">b</section><section className="py-16">c</section></>',
    );
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: files(flat),
      changedPaths: Object.keys(files(flat)),
    });
    const kinds = result.advisory.map((finding) => finding.kind);
    expect(kinds).toContain('no-motion');
    expect(kinds).toContain('flat-rhythm');
    // Advisory, never blocking: taste is not worth a billed repair.
    expect(result.blocking).toEqual([]);
  });

  it('stays quiet when the craft machinery is used', () => {
    const crafted = page(
      '<><section className="py-16"><Reveal>a</Reveal></section><section className="bg-secondary/50">b</section><section>c</section></>',
    );
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: files(crafted),
      changedPaths: Object.keys(files(crafted)),
    });
    const kinds = result.advisory.map((finding) => finding.kind);
    expect(kinds).not.toContain('no-motion');
    expect(kinds).not.toContain('flat-rhythm');
  });

  it('never judges whole-page craft on a small edit', () => {
    const flat = page('<><section>a</section><section>b</section><section>c</section></>');
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: files(flat),
      changedPaths: ['app/page.tsx'],
    });
    expect(result.advisory.map((finding) => finding.kind)).not.toContain('no-motion');
  });
});

/**
 * The plan as a contract.
 *
 * `missing-route` scrapes hrefs, so it only ever sees a broken *link*. A page
 * the approved plan promised, the user paid for, and the model silently never
 * wrote is linked from nowhere — it passes every gate, and the site simply
 * ships smaller than the plan the user agreed to.
 */
describe('routes the approved plan promised', () => {
  const home = { 'app/page.tsx': page('<main>home</main>') };

  it('reports a planned page nothing renders and nothing links to', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: home,
      changedPaths: Object.keys(home),
      plannedRoutes: ['/', '/pricing'],
    });
    expect(result.blocking.map((finding) => finding.kind)).toEqual(['missing-planned-route']);
    expect(result.blocking[0].file).toBe('app/pricing/page.tsx');
    expect(result.instruction).toContain('/pricing');
  });

  it('leads the repair instruction, ahead of per-file findings', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: { 'app/page.tsx': page('<a href="#">nowhere</a>') },
      changedPaths: ['app/page.tsx'],
      plannedRoutes: ['/pricing'],
    });
    expect(result.blocking[0].kind).toBe('missing-planned-route');
  });

  it('accepts a planned route the build rendered', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: { ...home, 'app/pricing/page.tsx': page('<main>pricing</main>') },
      changedPaths: ['app/page.tsx', 'app/pricing/page.tsx'],
      plannedRoutes: ['/', '/pricing'],
    });
    expect(result.blocking).toEqual([]);
  });

  it('treats a dynamic route as built whatever the model named the parameter', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: { ...home, 'app/product/[id]/page.tsx': page('<main>product</main>') },
      changedPaths: ['app/product/[id]/page.tsx'],
      plannedRoutes: ['/product/[slug]'],
    });
    expect(result.blocking).toEqual([]);
  });

  it('normalises a trailing slash, a query and a hash before comparing', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: { ...home, 'app/pricing/page.tsx': page('<main>pricing</main>') },
      changedPaths: ['app/pricing/page.tsx'],
      plannedRoutes: ['/pricing/', '/pricing?from=nav', '/pricing#tiers'],
    });
    expect(result.blocking).toEqual([]);
  });

  it('skips a plan entry that is a page name rather than a path', () => {
    // `route` is optional free text a model wrote; older stored plans predate
    // the field. A false blocking finding here spends a billed repair.
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: home,
      changedPaths: Object.keys(home),
      plannedRoutes: ['Home', '', 'about us'],
    });
    expect(result.blocking).toEqual([]);
  });

  it('does not mind a page the model built that the plan never promised', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: { ...home, 'app/blog/page.tsx': page('<main>blog</main>') },
      changedPaths: ['app/blog/page.tsx'],
      plannedRoutes: ['/'],
    });
    expect(result.blocking).toEqual([]);
  });

  it('checks nothing when the caller passes no plan, which is what an edit does', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: home,
      changedPaths: Object.keys(home),
    });
    expect(result.blocking).toEqual([]);
  });

  it('stays out of stacks with no app/ route convention', () => {
    const result = checkGeneratedQuality({
      stack: 'REACT',
      files: { 'src/App.tsx': page('<main>home</main>') },
      changedPaths: ['src/App.tsx'],
      plannedRoutes: ['/', '/pricing'],
    });
    expect(result.blocking.map((finding) => finding.kind)).not.toContain('missing-planned-route');
  });

  it('reports each missing route once, however many times the plan lists it', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: home,
      changedPaths: Object.keys(home),
      plannedRoutes: ['/pricing', '/pricing/', '/pricing?ref=nav'],
    });
    expect(result.blocking).toHaveLength(1);
  });
});

/**
 * The page that was written thin.
 *
 * `missing-planned-route` catches a page nobody wrote. This catches the one that exists and
 * stops after the hero: every other gate passes — the imports resolve, the bundle compiles,
 * the route is there — and the user gets a third of the page they approved while the
 * pipeline reports success.
 */
describe('sections the approved plan promised', () => {
  const uses = (...names: string[]) =>
    page(`<main>${names.map((n) => `<X${n} />`).join('')}</main>`).replace(
      'export default',
      `${names.map((n) => `import { X${n} } from '@/components/sections/${n}';`).join('\n')}\nexport default`,
    );

  it('reports a promised section the page does not use', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: { 'app/page.tsx': uses('hero') },
      changedPaths: ['app/page.tsx'],
      plannedPages: [{ route: '/', sections: ['hero', 'pricing-tiers', 'faq'] }],
    });

    expect(result.blocking.map((f) => f.kind)).toEqual(['missing-section']);
    expect(result.blocking[0].message).toContain('pricing-tiers');
    expect(result.blocking[0].message).toContain('faq');
    expect(result.blocking[0].message).not.toContain('hero');
  });

  it('accepts a page that uses every section it promised', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: { 'app/page.tsx': uses('hero', 'faq') },
      changedPaths: ['app/page.tsx'],
      plannedPages: [{ route: '/', sections: ['hero', 'faq'] }],
    });
    expect(result.blocking).toEqual([]);
  });

  it('does not mind extra sections the plan never mentioned', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: { 'app/page.tsx': uses('hero', 'faq', 'cta-band') },
      changedPaths: ['app/page.tsx'],
      plannedPages: [{ route: '/', sections: ['hero'] }],
    });
    expect(result.blocking).toEqual([]);
  });

  it('ignores a section name the catalogue does not have', () => {
    // The plan field is free text a model wrote; an invented name must not bill a repair.
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: { 'app/page.tsx': uses('hero') },
      changedPaths: ['app/page.tsx'],
      plannedPages: [{ route: '/', sections: ['hero', 'carousel', 'parallax-thing'] }],
    });
    expect(result.blocking).toEqual([]);
  });

  it('stays quiet about a page that does not exist, which is the other finding', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: { 'app/page.tsx': uses('hero') },
      changedPaths: ['app/page.tsx'],
      plannedPages: [{ route: '/pricing', sections: ['pricing-tiers'] }],
    });
    expect(result.blocking.map((f) => f.kind)).not.toContain('missing-section');
  });

  it('matches a dynamic route whatever the model named the parameter', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: { 'app/product/[id]/page.tsx': uses('hero') },
      changedPaths: ['app/product/[id]/page.tsx'],
      plannedPages: [{ route: '/product/[slug]', sections: ['hero', 'faq'] }],
    });
    expect(result.blocking.map((f) => f.kind)).toEqual(['missing-section']);
  });

  it('checks nothing when the plan named no sections', () => {
    const result = checkGeneratedQuality({
      stack: 'NEXTJS',
      files: { 'app/page.tsx': uses('hero') },
      changedPaths: ['app/page.tsx'],
      plannedPages: [{ route: '/' }],
    });
    expect(result.blocking).toEqual([]);
  });

  it('stays out of stacks with no app/ route convention', () => {
    const result = checkGeneratedQuality({
      stack: 'REACT',
      files: { 'src/App.tsx': uses('hero') },
      changedPaths: ['src/App.tsx'],
      plannedPages: [{ route: '/', sections: ['hero', 'faq'] }],
    });
    expect(result.blocking.map((f) => f.kind)).not.toContain('missing-section');
  });
});
