/**
 * Section-level components, the layer above the primitives.
 *
 * The starter kit gave the model eight shadcn/ui primitives and then asked it,
 * in prose, for section rhythm, entrance motion and alternating surfaces. Three
 * measured full generations later the advisories in `quality-check.ts` were
 * still firing on every run: zero `<Reveal>` wrappers, every section on the same
 * background. The lesson `Reveal` and `SectionHeader` already record applies one
 * level up — provide the mechanism, do not restate the rule — so the shapes a
 * marketing site is actually made of become code the model composes rather than
 * boilerplate it re-derives and cuts corners on.
 *
 * Three constraints shaped every component here, and each of them is a bug that
 * would otherwise ship:
 *
 * 1. Stack-neutral. `components/` is merged into NEXTJS *and* REACT projects, so nothing
 *    here may import `next/image` or `next/link` — `resolveBareSpecifier` rejects them in a
 *    Vite project and the section would fail to bundle. Two different escape hatches, and
 *    the difference matters:
 *
 *    - An image is a `React.ReactNode` slot the page fills, so `next/image` stays available
 *      to the page that wants it and the `raw-img` advisory points at the page, not the kit.
 *    - A *link* cannot be a slot, because a CTA is data now — that is what lets a section be
 *      described by a JSON tool call at all. So each section that renders one takes
 *      `linkComponent`, defaulting to `'a'`. A Next page passes `next/link` and gets client
 *      routing; a Vite project passes nothing. The conversion to data props briefly removed
 *      this, and every in-app navigation from a hero, a tier, a CTA band or a footer became
 *      a full document load on the default stack.
 * 2. No new dependency. Entrance motion is `Reveal` (IntersectionObserver,
 *    already in the kit) rather than framer-motion, which is pinned in
 *    `PREVIEW_DEPS` but absent from `STARTER_DEPENDENCIES` — a section importing
 *    it would preview correctly and then fail `next build` in the client's own
 *    repository after publish.
 * 3. Tokens only. Every colour is a semantic class, so a section inherits the
 *    project's design direction instead of pinning a palette, and the
 *    `raw-color` advisory has nothing to find in the code the model composes.
 *
 * Content is props, never hardcoded copy: these are shapes, not a template. A
 * section with its words baked in is the "template default" output this pipeline
 * exists to beat.
 */

const HERO_SOURCE = `import * as React from 'react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Reveal } from '@/components/ui/reveal';

export type SectionCta = {
  label: string;
  /** Omit for a button that a parent wires up, e.g. one that opens a dialog. */
  href?: string;
};

export type HeroSectionProps = React.HTMLAttributes<HTMLElement> & {
  eyebrow?: string;
  title: React.ReactNode;
  lede?: React.ReactNode;
  /**
   * The page's one standout CTA, as data rather than an element.
   *
   * A ReactNode slot reads well in hand-written code and badly everywhere else: it cannot
   * come from a JSON tool call, so a section described as data could never carry its own
   * button. The section renders the Button and picks the variant, which is also how the
   * "one standout CTA per page" rule stops being prose.
   */
  primaryCta?: SectionCta;
  secondaryCta?: SectionCta;
  /** Screenshot or illustration. Still an element: only the page knows how to load one. */
  media?: React.ReactNode;
  align?: 'left' | 'center';
  /**
   * Renders in-app links. Pass \`next/link\` on a Next project for client-side routing;
   * the default anchor keeps this file resolvable in a Vite project.
   */
  linkComponent?: React.ElementType;
};

/**
 * One button, linked or not. Repeated per file on purpose: each section stands alone.
 *
 * \`linkComponent\` is how a Next page gets client-side routing out of a stack-neutral file.
 * The anchor is the default because \`components/\` is merged into REACT projects too, where
 * \`next/link\` does not resolve — but leaving it as the only option meant every in-app
 * navigation from a hero, a tier or a footer was a full document load on the default stack.
 */
function CtaButton({
  cta,
  variant,
  linkComponent: Link = 'a',
}: {
  cta: SectionCta;
  variant?: 'premium' | 'hero' | 'outline' | 'default';
  linkComponent?: React.ElementType;
}) {
  if (cta.href) {
    return (
      <Button asChild variant={variant}>
        <Link href={cta.href}>{cta.label}</Link>
      </Button>
    );
  }
  return <Button variant={variant}>{cta.label}</Button>;
}

export function HeroSection({
  className,
  eyebrow,
  title,
  lede,
  primaryCta,
  secondaryCta,
  media,
  align,
  linkComponent,
  ...props
}: HeroSectionProps) {
  const resolvedAlign = align ?? (media ? 'left' : 'center');
  const centred = resolvedAlign === 'center' && !media;
  return (
    <section className={cn('relative overflow-hidden py-20 sm:py-28', className)} {...props}>
      <div
        className={cn(
          'container mx-auto grid items-center gap-12 px-4',
          media ? 'lg:grid-cols-2' : 'max-w-3xl',
        )}
      >
        <Reveal>
          <div className={centred ? 'text-center' : 'text-left'}>
            {eyebrow ? (
              <p className="mb-4 text-sm font-medium uppercase tracking-widest text-primary">
                {eyebrow}
              </p>
            ) : null}
            <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl lg:text-6xl">
              {title}
            </h1>
            {lede ? (
              <p className="mt-6 text-lg leading-relaxed text-muted-foreground">{lede}</p>
            ) : null}
            {primaryCta || secondaryCta ? (
              <div
                className={cn(
                  'mt-10 flex flex-wrap items-center gap-4',
                  centred ? 'justify-center' : 'justify-start',
                )}
              >
                {primaryCta ? (
                  <CtaButton cta={primaryCta} variant="premium" linkComponent={linkComponent} />
                ) : null}
                {secondaryCta ? (
                  <CtaButton cta={secondaryCta} variant="outline" linkComponent={linkComponent} />
                ) : null}
              </div>
            ) : null}
          </div>
        </Reveal>
        {media ? (
          <Reveal delay={160}>
            <div className="relative">{media}</div>
          </Reveal>
        ) : null}
      </div>
    </section>
  );
}

export default HeroSection;
`;

const FEATURE_GRID_SOURCE = `import * as React from 'react';

import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Reveal } from '@/components/ui/reveal';
import { SectionHeader } from '@/components/ui/section-header';

export type Feature = {
  /** A lucide-react icon element, e.g. <Zap className="h-5 w-5" />. */
  icon?: React.ReactNode;
  title: string;
  body: string;
};

export type FeatureGridProps = React.HTMLAttributes<HTMLElement> & {
  eyebrow?: string;
  title: string;
  lede?: string;
  items: Feature[];
  columns?: 2 | 3 | 4;
};

export function FeatureGrid({
  className,
  eyebrow,
  title,
  lede,
  items,
  columns = 3,
  ...props
}: FeatureGridProps) {
  return (
    <section className={cn('bg-muted/40 py-20 sm:py-24', className)} {...props}>
      <div className="container mx-auto px-4">
        <Reveal>
          <SectionHeader eyebrow={eyebrow} title={title} lede={lede} />
        </Reveal>
        <div
          className={cn(
            'mt-14 grid gap-6 sm:grid-cols-2',
            columns === 3 && 'lg:grid-cols-3',
            columns === 4 && 'lg:grid-cols-4',
          )}
        >
          {items.map((item, index) => (
            <Reveal key={item.title} delay={index * 80}>
              <Card className="h-full border-border/60 bg-card transition-shadow hover:shadow-md">
                <CardContent className="p-6">
                  {item.icon ? (
                    <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      {item.icon}
                    </div>
                  ) : null}
                  <h3 className="text-lg font-semibold text-foreground">{item.title}</h3>
                  <p className="mt-2 leading-relaxed text-muted-foreground">{item.body}</p>
                </CardContent>
              </Card>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

export default FeatureGrid;
`;

const PRICING_TIERS_SOURCE = `import * as React from 'react';

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Reveal } from '@/components/ui/reveal';
import { SectionHeader } from '@/components/ui/section-header';

export type PricingTier = {
  name: string;
  price: string;
  /** "per month", "one-off", "per seat". Omitted for a bare price. */
  period?: string;
  description?: string;
  features: string[];
  /** Exactly one tier should set this: it is the page's recommendation. */
  featured?: boolean;
  actionLabel: string;
  actionHref?: string;
};

export type PricingTiersProps = React.HTMLAttributes<HTMLElement> & {
  eyebrow?: string;
  title: string;
  lede?: string;
  tiers: PricingTier[];
  /**
   * Renders in-app links. Pass \`next/link\` on a Next project for client-side routing;
   * the default anchor keeps this file resolvable in a Vite project.
   */
  linkComponent?: React.ElementType;
};

export function PricingTiers({
  className,
  eyebrow,
  title,
  lede,
  tiers,
  linkComponent: Link = 'a',
  ...props
}: PricingTiersProps) {
  return (
    <section className={cn('py-20 sm:py-24', className)} {...props}>
      <div className="container mx-auto px-4">
        <Reveal>
          <SectionHeader eyebrow={eyebrow} title={title} lede={lede} />
        </Reveal>
        <div className="mx-auto mt-14 grid max-w-5xl gap-6 md:grid-cols-3">
          {tiers.map((tier, index) => (
            <Reveal key={tier.name} delay={index * 80}>
              <Card
                className={cn(
                  'flex h-full flex-col',
                  tier.featured ? 'border-primary shadow-lg' : 'border-border/60',
                )}
              >
                <CardContent className="flex flex-1 flex-col p-6">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-lg font-semibold text-foreground">{tier.name}</h3>
                    {tier.featured ? <Badge>Recommended</Badge> : null}
                  </div>
                  {tier.description ? (
                    <p className="mt-2 text-sm text-muted-foreground">{tier.description}</p>
                  ) : null}
                  <p className="mt-6 flex items-baseline gap-2">
                    <span className="text-4xl font-semibold tracking-tight text-foreground">
                      {tier.price}
                    </span>
                    {tier.period ? (
                      <span className="text-sm text-muted-foreground">{tier.period}</span>
                    ) : null}
                  </p>
                  <ul className="mt-6 flex-1 space-y-3 text-sm text-muted-foreground">
                    {tier.features.map((feature) => (
                      <li key={feature} className="flex gap-3">
                        <span
                          aria-hidden
                          className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                        />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-8">
                    {tier.actionHref ? (
                      <Button asChild className="w-full" variant={tier.featured ? 'premium' : 'default'}>
                        <Link href={tier.actionHref}>{tier.actionLabel}</Link>
                      </Button>
                    ) : (
                      <Button className="w-full" variant={tier.featured ? 'premium' : 'default'}>
                        {tier.actionLabel}
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

export default PricingTiers;
`;

const TESTIMONIALS_SOURCE = `import * as React from 'react';

import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Reveal } from '@/components/ui/reveal';
import { SectionHeader } from '@/components/ui/section-header';

export type Testimonial = {
  quote: string;
  name: string;
  role?: string;
  /** An image element, sized by the caller. */
  avatar?: React.ReactNode;
};

export type TestimonialsProps = React.HTMLAttributes<HTMLElement> & {
  eyebrow?: string;
  title: string;
  lede?: string;
  items: Testimonial[];
};

export function Testimonials({
  className,
  eyebrow,
  title,
  lede,
  items,
  ...props
}: TestimonialsProps) {
  return (
    <section className={cn('bg-secondary/40 py-20 sm:py-24', className)} {...props}>
      <div className="container mx-auto px-4">
        <Reveal>
          <SectionHeader eyebrow={eyebrow} title={title} lede={lede} />
        </Reveal>
        <div className="mt-14 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {items.map((item, index) => (
            <Reveal key={item.name} delay={index * 80}>
              <Card className="h-full border-border/60 bg-card">
                <CardContent className="flex h-full flex-col p-6">
                  <blockquote className="flex-1 text-base leading-relaxed text-foreground">
                    {item.quote}
                  </blockquote>
                  <figcaption className="mt-6 flex items-center gap-3">
                    {item.avatar ? (
                      <span className="h-10 w-10 overflow-hidden rounded-full bg-muted">
                        {item.avatar}
                      </span>
                    ) : null}
                    <span>
                      <span className="block text-sm font-medium text-foreground">{item.name}</span>
                      {item.role ? (
                        <span className="block text-sm text-muted-foreground">{item.role}</span>
                      ) : null}
                    </span>
                  </figcaption>
                </CardContent>
              </Card>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

export default Testimonials;
`;

const LOGO_CLOUD_SOURCE = `import * as React from 'react';

import { cn } from '@/lib/utils';
import { Reveal } from '@/components/ui/reveal';

export type LogoCloudProps = React.HTMLAttributes<HTMLElement> & {
  /** One line of context, e.g. "Trusted by teams at". Omit for a bare row. */
  label?: string;
  /** Wordmarks or image elements. Text reads better than a missing image. */
  items: React.ReactNode[];
};

export function LogoCloud({ className, label, items, ...props }: LogoCloudProps) {
  return (
    <section className={cn('border-y border-border/60 bg-card py-12', className)} {...props}>
      <div className="container mx-auto px-4">
        <Reveal>
          {label ? (
            <p className="text-center text-sm uppercase tracking-widest text-muted-foreground">
              {label}
            </p>
          ) : null}
          <div className="mt-8 flex flex-wrap items-center justify-center gap-x-12 gap-y-6 opacity-70">
            {items.map((item, index) => (
              <div
                key={index}
                className="flex h-8 items-center text-lg font-medium text-foreground"
              >
                {item}
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

export default LogoCloud;
`;

const STATS_BAND_SOURCE = `import * as React from 'react';

import { cn } from '@/lib/utils';
import { Reveal } from '@/components/ui/reveal';

export type Stat = {
  value: string;
  label: string;
};

export type StatsBandProps = React.HTMLAttributes<HTMLElement> & {
  items: Stat[];
  /** The page's one inverted band. Use it once, for contrast against the rest. */
  inverted?: boolean;
};

export function StatsBand({ className, items, inverted = false, ...props }: StatsBandProps) {
  return (
    <section
      className={cn(
        'py-16 sm:py-20',
        inverted ? 'bg-foreground text-background' : 'bg-muted/40',
        className,
      )}
      {...props}
    >
      <div className="container mx-auto grid gap-10 px-4 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((item, index) => (
          <Reveal key={item.label} delay={index * 80}>
            <div className="text-center">
              <p className="text-4xl font-semibold tracking-tight sm:text-5xl">{item.value}</p>
              <p
                className={cn(
                  'mt-2 text-sm',
                  inverted ? 'text-background/70' : 'text-muted-foreground',
                )}
              >
                {item.label}
              </p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

export default StatsBand;
`;

const FAQ_SOURCE = `import * as React from 'react';

import { cn } from '@/lib/utils';
import { Reveal } from '@/components/ui/reveal';
import { SectionHeader } from '@/components/ui/section-header';

export type FaqItem = {
  question: string;
  answer: React.ReactNode;
};

export type FaqProps = React.HTMLAttributes<HTMLElement> & {
  eyebrow?: string;
  title: string;
  lede?: string;
  items: FaqItem[];
};

/**
 * Native details/summary rather than a Radix accordion: keyboard accessible and
 * findable with the browser's own search, with no dependency and no client
 * component — and the kit ships no accordion primitive to build one against.
 */
export function Faq({ className, eyebrow, title, lede, items, ...props }: FaqProps) {
  return (
    <section className={cn('py-20 sm:py-24', className)} {...props}>
      <div className="container mx-auto max-w-3xl px-4">
        <Reveal>
          <SectionHeader eyebrow={eyebrow} title={title} lede={lede} />
        </Reveal>
        <div className="mt-12 divide-y divide-border rounded-lg border border-border/60 bg-card">
          {items.map((item, index) => (
            <Reveal key={item.question} delay={index * 60}>
              <details className="group px-6 py-5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-base font-medium text-foreground">
                  {item.question}
                  <span
                    aria-hidden
                    className="text-muted-foreground transition-transform group-open:rotate-45"
                  >
                    +
                  </span>
                </summary>
                <div className="mt-3 leading-relaxed text-muted-foreground">{item.answer}</div>
              </details>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

export default Faq;
`;

const CTA_BAND_SOURCE = `import * as React from 'react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Reveal } from '@/components/ui/reveal';

export type CtaBandProps = React.HTMLAttributes<HTMLElement> & {
  title: React.ReactNode;
  lede?: React.ReactNode;
  /** Data, not an element, for the reason HeroSection's props give. */
  cta: { label: string; href?: string };
  secondaryCta?: { label: string; href?: string };
  /**
   * Renders in-app links. Pass \`next/link\` on a Next project for client-side routing;
   * the default anchor keeps this file resolvable in a Vite project.
   */
  linkComponent?: React.ElementType;
};

export function CtaBand({
  className,
  title,
  lede,
  cta,
  secondaryCta,
  linkComponent: Link = 'a',
  ...props
}: CtaBandProps) {
  return (
    <section
      className={cn('bg-primary py-16 text-primary-foreground sm:py-20', className)}
      {...props}
    >
      <div className="container mx-auto px-4">
        <Reveal>
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h2>
            {lede ? <p className="mt-4 text-lg opacity-90">{lede}</p> : null}
            <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
              {cta.href ? (
                <Button asChild variant="hero">
                  <Link href={cta.href}>{cta.label}</Link>
                </Button>
              ) : (
                <Button variant="hero">{cta.label}</Button>
              )}
              {secondaryCta ? (
                secondaryCta.href ? (
                  <Button asChild variant="outline">
                    <Link href={secondaryCta.href}>{secondaryCta.label}</Link>
                  </Button>
                ) : (
                  <Button variant="outline">{secondaryCta.label}</Button>
                )
              ) : null}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

export default CtaBand;
`;

const CONTACT_FORM_SOURCE = `import * as React from 'react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Reveal } from '@/components/ui/reveal';
import { SectionHeader } from '@/components/ui/section-header';

export type ContactField = {
  name: string;
  label: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
  /** Renders a textarea instead of an input. */
  multiline?: boolean;
};

export type ContactFormProps = Omit<React.HTMLAttributes<HTMLElement>, 'onSubmit'> & {
  eyebrow?: string;
  title: string;
  lede?: string;
  fields: ContactField[];
  submitLabel?: string;
  onSubmit?: React.FormEventHandler<HTMLFormElement>;
};

export function ContactForm({
  className,
  eyebrow,
  title,
  lede,
  fields,
  submitLabel = 'Send message',
  onSubmit,
  ...props
}: ContactFormProps) {
  return (
    <section className={cn('bg-muted/40 py-20 sm:py-24', className)} {...props}>
      <div className="container mx-auto max-w-xl px-4">
        <Reveal>
          <SectionHeader eyebrow={eyebrow} title={title} lede={lede} />
          <form className="mt-10 space-y-5" onSubmit={onSubmit}>
            {fields.map((field) => (
              <div key={field.name} className="space-y-2">
                <Label htmlFor={field.name}>{field.label}</Label>
                {field.multiline ? (
                  <textarea
                    id={field.name}
                    name={field.name}
                    rows={4}
                    required={field.required}
                    placeholder={field.placeholder}
                    className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  />
                ) : (
                  <Input
                    id={field.name}
                    name={field.name}
                    type={field.type ?? 'text'}
                    required={field.required}
                    placeholder={field.placeholder}
                  />
                )}
              </div>
            ))}
            <Button type="submit" className="w-full">
              {submitLabel}
            </Button>
          </form>
        </Reveal>
      </div>
    </section>
  );
}

export default ContactForm;
`;

const SITE_FOOTER_SOURCE = `import * as React from 'react';

import { cn } from '@/lib/utils';

export type FooterLink = {
  label: string;
  href: string;
};

export type FooterColumn = {
  title: string;
  /**
   * Data, not elements. The column renders its own anchors: this file is stack-neutral so
   * next/link is not importable here anyway, and taking {label, href} means a page — or a
   * tool call — can describe a footer without constructing JSX.
   */
  links: FooterLink[];
};

export type SiteFooterProps = React.HTMLAttributes<HTMLElement> & {
  brand: React.ReactNode;
  blurb?: string;
  columns?: FooterColumn[];
  legal?: React.ReactNode;
  /**
   * Renders in-app links. Pass \`next/link\` on a Next project for client-side routing;
   * the default anchor keeps this file resolvable in a Vite project.
   */
  linkComponent?: React.ElementType;
};

export function SiteFooter({
  className,
  brand,
  blurb,
  columns = [],
  legal,
  linkComponent: Link = 'a',
  ...props
}: SiteFooterProps) {
  return (
    <footer className={cn('border-t border-border bg-card', className)} {...props}>
      <div className="container mx-auto grid gap-10 px-4 py-14 md:grid-cols-4">
        <div className="md:col-span-1">
          <div className="text-lg font-semibold text-foreground">{brand}</div>
          {blurb ? (
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{blurb}</p>
          ) : null}
        </div>
        {columns.map((column) => (
          <div key={column.title}>
            <h3 className="text-sm font-medium text-foreground">{column.title}</h3>
            <ul className="mt-4 space-y-3 text-sm text-muted-foreground">
              {column.links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="transition-colors hover:text-foreground">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {legal ? (
        <div className="border-t border-border/60">
          <div className="container mx-auto px-4 py-6 text-sm text-muted-foreground">{legal}</div>
        </div>
      ) : null}
    </footer>
  );
}

export default SiteFooter;
`;

/**
 * Keyed by their file name under `components/sections/`.
 *
 * `lockedStackRule` and `starterFilesRule` are generated from these keys, so a
 * section added here is named to the model, merged into the preview, compiled by
 * the validator and shipped by publish in the same commit — the one-source
 * discipline `UI_COMPONENTS` already follows, for the same reason: a prompt that
 * names a file the project does not have is worse than saying nothing.
 */
export const SECTION_COMPONENTS: Record<string, string> = {
  hero: HERO_SOURCE,
  'feature-grid': FEATURE_GRID_SOURCE,
  'pricing-tiers': PRICING_TIERS_SOURCE,
  testimonials: TESTIMONIALS_SOURCE,
  'logo-cloud': LOGO_CLOUD_SOURCE,
  'stats-band': STATS_BAND_SOURCE,
  faq: FAQ_SOURCE,
  'cta-band': CTA_BAND_SOURCE,
  'contact-form': CONTACT_FORM_SOURCE,
  'site-footer': SITE_FOOTER_SOURCE,
};

/** The section names, for the prompt bullet that tells the model they exist. */
export const SECTION_COMPONENT_NAMES = Object.keys(SECTION_COMPONENTS);
