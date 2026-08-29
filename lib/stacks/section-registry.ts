import { z } from 'zod';

/**
 * What each section in the starter kit accepts, as a schema rather than as prose.
 *
 * The section components landed with the prompt naming them and nothing describing their
 * props, so the model had to infer a shape from the component's name. It gets that wrong in
 * a way nothing downstream catches: a misspelt or invented prop is not a type error to
 * esbuild — it bundles, previews and publishes clean, and only `next build` inside the
 * client's own repository ever objects. This is the contract that makes the wrong shape a
 * refusal the model reads back on the same step, at the earliest point anything can know.
 *
 * Deliberately a separate module from `templates/sections.ts`, which holds the source
 * strings. That file is on the browser graph — `BrowserPreview` reaches it through
 * `assemblePreview` — and `tests/unit/preview-client-graph.test.ts` pins that graph as an
 * upper bound. Putting zod there would ship a schema validator into every preview tab for
 * no reason. The two are kept honest by a guard test asserting the key sets match exactly,
 * which is the same trick `starterFilePaths` and `lockedStackRule` already use.
 *
 * Props are split in two because React props are not JSON:
 *
 * - `props` are content — strings, numbers, arrays of plain objects. A model can produce
 *   these as tool arguments and zod can check them.
 * - `slots` are `ReactNode`: a button, a link, an image. They cannot come from a JSON tool
 *   call, so the registry describes them and `renderSectionUsage` emits a real, compiling
 *   element the model edits in place. That is the difference between an example and a
 *   snippet that works: a placeholder like `action={/* a button *\/}` is a syntax error, and
 *   handing the model one is worse than handing it nothing.
 */

export type SectionSlot = {
  /** The prop name on the component. */
  name: string;
  /** Whether the component needs it — a required slot must be in the emitted snippet. */
  required: boolean;
  /** What belongs there, for the prompt and the tool's reply. */
  hint: string;
  /** A real element to emit, which must compile against the locked stack. */
  example: string;
  /** Imports `example` needs, beyond the section's own. */
  imports?: string[];
};

export type SectionEntry = {
  /** The exported component name, for the import line. */
  component: string;
  /** One line: what this section is for. Feeds the prompt and the plan's section list. */
  description: string;
  /** Content props, as data. */
  props: z.ZodObject<z.ZodRawShape>;
  slots: SectionSlot[];
};

/** Reused across sections: the heading trio `SectionHeader` renders. */
const HEADING_PROPS = {
  eyebrow: z.string().min(1).max(60).optional(),
  title: z.string().min(1).max(160),
  lede: z.string().min(1).max(400).optional(),
};

/**
 * A call to action, as data.
 *
 * The sections render the Button themselves and choose its variant, so a page — or a tool
 * call carrying nothing but JSON — can describe a CTA without constructing an element. That
 * is also what lets `renderSectionUsage` emit a section that compiles with no slot left to
 * fill, which is the whole point of the registry.
 */
const CTA = z.object({
  label: z.string().min(1).max(40),
  /** Omit for a button a parent wires up, e.g. one that opens a dialog. */
  href: z.string().min(1).max(300).optional(),
});

export const SECTION_REGISTRY: Record<string, SectionEntry> = {
  hero: {
    component: 'HeroSection',
    description:
      'The opening statement of a page: eyebrow, headline, lede and up to two calls to action.',
    props: z.object({
      ...HEADING_PROPS,
      align: z.enum(['left', 'center']).optional(),
      primaryCta: CTA.optional(),
      secondaryCta: CTA.optional(),
    }),
    slots: [
      {
        name: 'media',
        required: false,
        hint: 'A screenshot or illustration. Only the page knows how to load one.',
        example: '<img src="/hero.webp" alt="" className="w-full rounded-xl" />',
      },
    ],
  },

  'feature-grid': {
    component: 'FeatureGrid',
    description: 'Two to four columns of capability cards, each a title and a sentence.',
    props: z.object({
      ...HEADING_PROPS,
      columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
      items: z
        .array(
          z.object({
            title: z.string().min(1).max(80),
            body: z.string().min(1).max(300),
          }),
        )
        .min(2)
        .max(12),
    }),
    slots: [],
  },

  'pricing-tiers': {
    component: 'PricingTiers',
    description: 'Side-by-side plans, each with a price, a feature list and one action.',
    props: z.object({
      ...HEADING_PROPS,
      tiers: z
        .array(
          z.object({
            name: z.string().min(1).max(40),
            price: z.string().min(1).max(24),
            period: z.string().min(1).max(40).optional(),
            description: z.string().min(1).max(200).optional(),
            features: z.array(z.string().min(1).max(120)).min(1).max(12),
            featured: z.boolean().optional(),
            actionLabel: z.string().min(1).max(40),
            actionHref: z.string().min(1).max(300).optional(),
          }),
        )
        .min(2)
        .max(4),
    }),
    slots: [],
  },

  testimonials: {
    component: 'Testimonials',
    description: 'Quotes from named people, with their role.',
    props: z.object({
      ...HEADING_PROPS,
      items: z
        .array(
          z.object({
            quote: z.string().min(1).max(400),
            name: z.string().min(1).max(60),
            role: z.string().min(1).max(80).optional(),
          }),
        )
        .min(1)
        .max(9),
    }),
    slots: [],
  },

  'logo-cloud': {
    component: 'LogoCloud',
    description: 'A quiet row of customer or partner names, under one line of context.',
    props: z.object({
      label: z.string().min(1).max(80).optional(),
      // The component's prop is `items: React.ReactNode[]`, and a plain string is a valid
      // ReactNode — so a list of names renders as written with no wrapper element.
      items: z.array(z.string().min(1).max(40)).min(2).max(10),
    }),
    slots: [],
  },

  'stats-band': {
    component: 'StatsBand',
    description: 'Two to four headline numbers. Use `inverted` once per page, for contrast.',
    props: z.object({
      inverted: z.boolean().optional(),
      items: z
        .array(
          z.object({
            value: z.string().min(1).max(16),
            label: z.string().min(1).max(60),
          }),
        )
        .min(2)
        .max(4),
    }),
    slots: [],
  },

  faq: {
    component: 'Faq',
    description: 'Questions and answers, expandable, using native details/summary.',
    props: z.object({
      ...HEADING_PROPS,
      items: z
        .array(
          z.object({
            question: z.string().min(1).max(160),
            answer: z.string().min(1).max(600),
          }),
        )
        .min(2)
        .max(12),
    }),
    slots: [],
  },

  'cta-band': {
    component: 'CtaBand',
    description: "The page's closing ask, on the primary colour.",
    props: z.object({
      title: z.string().min(1).max(120),
      lede: z.string().min(1).max(300).optional(),
      cta: CTA,
      secondaryCta: CTA.optional(),
    }),
    slots: [],
  },

  'contact-form': {
    component: 'ContactForm',
    description: 'A short form built from the kit’s Input and Label primitives.',
    props: z.object({
      ...HEADING_PROPS,
      submitLabel: z.string().min(1).max(40).optional(),
      fields: z
        .array(
          z.object({
            name: z
              .string()
              .min(1)
              .max(40)
              // It becomes an id and a form field name, so it has to be one token.
              .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, 'must be a valid field name'),
            label: z.string().min(1).max(60),
            type: z.string().min(1).max(20).optional(),
            placeholder: z.string().min(1).max(120).optional(),
            required: z.boolean().optional(),
            multiline: z.boolean().optional(),
          }),
        )
        .min(1)
        .max(8),
    }),
    slots: [],
  },

  'site-footer': {
    component: 'SiteFooter',
    description: 'The page footer: brand, a blurb, link columns and a legal line.',
    props: z.object({
      brand: z.string().min(1).max(60),
      blurb: z.string().min(1).max(240).optional(),
      legal: z.string().min(1).max(160).optional(),
      columns: z
        .array(
          z.object({
            title: z.string().min(1).max(40),
            links: z
              .array(
                z.object({
                  label: z.string().min(1).max(40),
                  href: z.string().min(1).max(200),
                }),
              )
              .min(1)
              .max(8),
          }),
        )
        .max(4)
        .optional(),
    }),
    slots: [],
  },
};

export const SECTION_REGISTRY_NAMES = Object.keys(SECTION_REGISTRY);

export function sectionEntry(name: string): SectionEntry | undefined {
  return SECTION_REGISTRY[name];
}

/** The catalogue as one prompt line, generated so it cannot disagree with the registry. */
export function sectionCatalogueRule(): string {
  return SECTION_REGISTRY_NAMES.map(
    (name) => `  - ${name}: ${SECTION_REGISTRY[name].description}`,
  ).join('\n');
}

/* ------------------------------------------------------------------ rendering */

/** JSX string attributes are HTML-ish: the quote and the brace are what break out. */
function jsxAttrString(value: string): string {
  return `"${value.replace(/"/g, '&quot;').replace(/[{}]/g, (c) => (c === '{' ? '&#123;' : '&#125;'))}"`;
}

/** A JS literal for anything that is not a bare string attribute. */
function jsExpression(value: unknown, indent: string): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const inner = value
      .map((item) => `${indent}  ${jsExpression(item, `${indent}  `)}`)
      .join(',\n');
    return `[\n${inner},\n${indent}]`;
  }
  if (value && typeof value === 'object') {
    const inner = Object.entries(value)
      .map(([key, val]) => `${indent}  ${key}: ${jsExpression(val, `${indent}  `)}`)
      .join(',\n');
    return `{\n${inner},\n${indent}}`;
  }
  return 'null';
}

export type SectionUsage = {
  /** Import lines the snippet needs, deduplicated and sorted. */
  imports: string[];
  /** The JSX element, ready to paste into a page. */
  jsx: string;
};

/**
 * A section, filled in with validated content and compiling as written.
 *
 * Required slots are emitted with a real example element rather than a placeholder: the
 * model is meant to edit the label, not to repair the syntax. Optional slots are emitted
 * only when the caller asked for them, so a text-only hero does not arrive carrying an
 * `<img>` nobody wanted.
 */
export function renderSectionUsage(
  name: string,
  props: Record<string, unknown>,
  options: { includeOptionalSlots?: readonly string[] } = {},
): SectionUsage {
  const entry = SECTION_REGISTRY[name];
  if (!entry) throw new Error(`No section named ${name}`);

  const wanted = new Set(options.includeOptionalSlots ?? []);
  const imports = new Set<string>([
    `import { ${entry.component} } from '@/components/sections/${name}';`,
  ]);

  const attrs: string[] = [];
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    attrs.push(
      typeof value === 'string'
        ? `  ${key}=${jsxAttrString(value)}`
        : `  ${key}={${jsExpression(value, '  ')}}`,
    );
  }
  for (const slot of entry.slots) {
    if (!slot.required && !wanted.has(slot.name)) continue;
    attrs.push(`  ${slot.name}={${slot.example}}`);
    for (const line of slot.imports ?? []) imports.add(line);
  }

  const jsx =
    attrs.length === 0 ? `<${entry.component} />` : `<${entry.component}\n${attrs.join('\n')}\n/>`;

  return { imports: [...imports].sort(), jsx };
}
