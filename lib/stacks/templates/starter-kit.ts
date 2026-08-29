import { renderTokenCss, type DirectionTokens } from '@/lib/design/directions';
import { renderTailwindConfigBody } from '@/lib/design/tailwind-theme';
import { SECTION_COMPONENTS } from './sections';
import type { ScaffoldFile } from './shared';

/**
 * The locked stack every NEXTJS and REACT project is generated against.
 *
 * Before this existed the prompts *banned* `bg-background` and `text-foreground`
 * in three places, because a generated project shipped no CSS variables and the
 * preview frame never read its `tailwind.config.js` — so a semantic class was a
 * class that resolved to nothing. The ban was correct for the stack as it was
 * and wrong for the stack a model wants to write: shadcn/ui is what its training
 * data is full of, and forbidding it meant fighting the model on every request.
 *
 * So the stack becomes real: CSS variables written from the chosen design
 * direction, a Tailwind theme that maps the semantic classes onto them, `cn()`,
 * and the eight shadcn/ui primitives the integration guide names. The same
 * files reach the browser preview, the served preview build, the validator's
 * compile, the published site and the exported repo — one definition, one
 * merge point (lib/stacks/starter.ts).
 *
 * The component sources are upstream shadcn/ui for Tailwind v3, unmodified
 * beyond the import path. Do not invent variants: a model that has seen
 * thousands of real ones will write `variant="ghost"` and expect it to mean
 * what it means everywhere else.
 */

/** Where the starter files live per stack. NEXTJS is flat, REACT is under src/. */
export type StarterLayout = {
  /** Directory prefix for runtime source, `''` for NEXTJS or `'src/'` for REACT. */
  srcPrefix: string;
  /** Path of the global stylesheet this stack imports. */
  globalCssPath: string;
  /** Globs Tailwind scans for class names. */
  contentGlobs: readonly string[];
  /** `module.exports = ` for CommonJS, `export default ` for an ESM package. */
  configExport: 'commonjs' | 'esm';
};

export const NEXTJS_STARTER_LAYOUT: StarterLayout = {
  srcPrefix: '',
  globalCssPath: 'app/globals.css',
  // `./lib/**` is in the list because `cn` lives there and Tailwind v3 refuses
  // to emit a class it cannot find in a scanned file.
  contentGlobs: [
    './app/**/*.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx}',
    './lib/**/*.{js,ts,jsx,tsx}',
  ],
  configExport: 'commonjs',
};

export const REACT_STARTER_LAYOUT: StarterLayout = {
  srcPrefix: 'src/',
  globalCssPath: 'src/index.css',
  contentGlobs: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  configExport: 'esm',
};

/**
 * The dependency versions the starter kit needs, as npm ranges.
 *
 * These must equal the preview's pins in `lib/preview/deps.ts` — a caret range
 * here against a pinned version there is how a preview and a deployed site
 * quietly become different sites. `tests/unit/starter-kit-renders.test.ts`
 * compares the two maps.
 */
export const STARTER_DEPENDENCIES: Record<string, string> = {
  clsx: '^2.1.1',
  'tailwind-merge': '^3.4.0',
  'class-variance-authority': '^0.7.1',
  'lucide-react': '^0.548.0',
  '@radix-ui/react-slot': '^1.2.3',
  '@radix-ui/react-dialog': '^1.1.15',
  '@radix-ui/react-label': '^2.1.7',
  '@radix-ui/react-tabs': '^1.1.13',
};

/**
 * The global stylesheet: Tailwind's layers, then the direction's tokens.
 *
 * The border-colour rule and the `body` pair are shadcn/ui's own base layer.
 * They are what make an unstyled element inherit the palette instead of falling
 * back to a browser default that fights it.
 *
 * The border rule's selector is `html *` where shadcn/ui writes `*`, and that
 * one extra element name is load-bearing. Tailwind's preflight sets
 * `border-color` on `*, ::before, ::after` — the same (0,0,0) specificity — so a
 * bare `*` here only wins on source order, and the two builds order it
 * differently: PostCSS emits this after preflight inside the base layer, while
 * the preview frame gets preflight from the Play CDN at an unpinned
 * `cdn.tailwindcss.com` whose injection point is that script's business, not
 * ours. `html *` is (0,0,1), so it beats preflight wherever either lands, and it
 * is still below the (0,1,0) of `border-primary`, so a utility keeps overriding
 * it. Without it a `className="border rounded-lg"` card renders preflight
 * gray-200 in one place and the direction's `--border` in the other, and the
 * user approves one and ships the other.
 *
 * The `@layer base` wrapper stays, because for the *repo* it is correct: it
 * hoists these into the base layer, ahead of components and utilities. The
 * preview has no PostCSS to strip it, so `flattenTailwindLayers`
 * (`lib/preview/assemble.ts`) does what PostCSS would — the wrapper must not be
 * removed here to compensate, or the exported repo loses the hoist.
 */
export function renderGlobalCss(tokens: DirectionTokens): string {
  return `@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
${renderTokenCss(tokens)}
  }

  html * {
    border-color: hsl(var(--border));
  }

  body {
    font-family: var(--font-body);
    background-color: hsl(var(--background));
    color: hsl(var(--foreground));
  }
}
`;
}

export function renderTailwindConfig(layout: StarterLayout): string {
  const body = renderTailwindConfigBody(layout.contentGlobs);
  if (layout.configExport === 'esm') {
    return `/** @type {import('tailwindcss').Config} */
export default {
${body}
};
`;
  }
  return `/** @type {import('tailwindcss').Config} */
module.exports = {
${body}
};
`;
}

/**
 * `cn` — deliberately not the host app's `utils/cn.ts`, which is
 * `extendTailwindMerge` over Navroop's own private font-size scale and has no
 * `clsx`. This is upstream shadcn/ui's, because that is what every component
 * source below expects.
 */
const UTILS_SOURCE = `import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
`;

const BUTTON_SOURCE = `import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
        // Two crafted variants beyond stock shadcn. premium is the page's one
        // standout CTA: the gradient and both shadows are the direction's own
        // tokens, so it degrades to a flat primary where the direction says
        // "no shadows". hero is a button over imagery or an inverted band; the
        // translucent white is deliberate and literal, because over a
        // photograph no palette token is the right answer - and this variant
        // existing is what stops a call-site outline + text-primary-foreground
        // override, the exact combination that ships an invisible button.
        premium:
          'bg-gradient-primary text-primary-foreground shadow-elegant transition-[box-shadow,transform] duration-smooth ease-smooth hover:-translate-y-0.5 hover:shadow-glow motion-reduce:transition-none motion-reduce:hover:translate-y-0',
        hero: 'border border-white/25 bg-white/10 text-white backdrop-blur-sm hover:bg-white/20',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-md px-3',
        lg: 'h-11 rounded-md px-8',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
`;

const CARD_SOURCE = `import * as React from 'react';

import { cn } from '@/lib/utils';

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('rounded-lg border bg-card text-card-foreground shadow-sm', className)}
      {...props}
    />
  ),
);
Card.displayName = 'Card';

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-col space-y-1.5 p-6', className)} {...props} />
  ),
);
CardHeader.displayName = 'CardHeader';

const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('text-2xl font-semibold leading-none tracking-tight', className)}
      {...props}
    />
  ),
);
CardTitle.displayName = 'CardTitle';

const CardDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />
  ),
);
CardDescription.displayName = 'CardDescription';

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('p-6 pt-0', className)} {...props} />
  ),
);
CardContent.displayName = 'CardContent';

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex items-center p-6 pt-0', className)} {...props} />
  ),
);
CardFooter.displayName = 'CardFooter';

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
`;

const INPUT_SOURCE = `import * as React from 'react';

import { cn } from '@/lib/utils';

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';

export { Input };
`;

const LABEL_SOURCE = `'use client';

import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const labelVariants = cva(
  'text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
);

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> & VariantProps<typeof labelVariants>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root ref={ref} className={cn(labelVariants(), className)} {...props} />
));
Label.displayName = LabelPrimitive.Root.displayName;

export { Label };
`;

const BADGE_SOURCE = `import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground hover:bg-primary/80',
        secondary:
          'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
        destructive:
          'border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80',
        outline: 'text-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
`;

const SKELETON_SOURCE = `import { cn } from '@/lib/utils';

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}

export { Skeleton };
`;

const DIALOG_SOURCE = `'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

import { cn } from '@/lib/utils';

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn('fixed inset-0 z-50 bg-black/80', className)}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed left-1/2 top-1/2 z-50 grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 border bg-background p-6 shadow-lg sm:rounded-lg',
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex flex-col space-y-1.5 text-center sm:text-left', className)} {...props} />
  );
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)}
      {...props}
    />
  );
}

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold leading-none tracking-tight', className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
`;

const TABS_SOURCE = `'use client';

import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';

import { cn } from '@/lib/utils';

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      'inline-flex h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground',
      className,
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm',
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      'mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
`;

/**
 * Scroll entrance, as a primitive.
 *
 * BASE_RULES has asked for section reveals (IntersectionObserver, opacity +
 * translate <=16px, reduced-motion honoured) for as long as the DESIGN section
 * has existed, and across three measured full generations the model wrote zero
 * of them — an observer is a dozen lines of boilerplate per section, so it is
 * the first corner cut. The rule survives only as machinery: wrapping a section
 * in `<Reveal>` is one line, so it actually happens. Same reasoning as the cn()
 * helper and the icon repair — provide the mechanism, don't restate the rule.
 *
 * Content is visible by default and the effect is opt-out safe: reduced motion,
 * a missing IntersectionObserver, or JS never hydrating all leave the page
 * readable, because the hidden state is only entered when the observer is
 * confirmed available.
 */
const REVEAL_SOURCE = `'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';

type RevealProps = React.HTMLAttributes<HTMLDivElement> & {
  /** Stagger, in ms. Siblings typically step by 80. */
  delay?: number;
};

/**
 * Fades and lifts its children in the first time they scroll into view.
 * Honors prefers-reduced-motion (content renders immediately, no animation).
 */
const Reveal = React.forwardRef<HTMLDivElement, RevealProps>(
  ({ className, delay = 0, style, children, ...props }, ref) => {
    const localRef = React.useRef<HTMLDivElement>(null);
    React.useImperativeHandle(ref, () => localRef.current as HTMLDivElement);
    // Starts visible: the hidden state is only entered once the observer is
    // confirmed available, so no-JS, reduced-motion and old browsers all read.
    const [state, setState] = React.useState<'visible' | 'hidden' | 'shown'>('visible');

    React.useEffect(() => {
      const node = localRef.current;
      if (!node) return;
      if (typeof IntersectionObserver === 'undefined') return;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      // Existing is not working: in a locked-down preview frame the observer
      // constructs fine and then never delivers a single callback - not even
      // the initial notification a live observer always sends for a new
      // target. Hiding content on construction alone left every section
      // invisible there. So the hide is provisional: if no callback arrives
      // shortly, the observer is presumed dead and everything shows.
      let delivered = false;
      const observer = new IntersectionObserver(
        (entries) => {
          delivered = true;
          for (const entry of entries) {
            if (entry.isIntersecting) {
              setState('shown');
              observer.disconnect();
            }
          }
        },
        { threshold: 0.15, rootMargin: '0px 0px -10% 0px' },
      );
      setState((current) => (current === 'visible' ? 'hidden' : current));
      observer.observe(node);
      const fallback = window.setTimeout(() => {
        if (!delivered) {
          observer.disconnect();
          setState('shown');
        }
      }, 1200);
      return () => {
        observer.disconnect();
        window.clearTimeout(fallback);
      };
    }, []);

    return (
      <div
        ref={localRef}
        className={cn(
          'transition-[opacity,transform] duration-500 ease-smooth motion-reduce:transition-none',
          state === 'hidden' ? 'translate-y-4 opacity-0' : 'translate-y-0 opacity-100',
          className,
        )}
        style={delay ? { transitionDelay: state === 'hidden' ? undefined : \`\${delay}ms\`, ...style } : style}
        {...props}
      >
        {children}
      </div>
    );
  },
);
Reveal.displayName = 'Reveal';

// Both import styles resolve: the first live generation wrote
// \`import SectionHeader from ...\` against a named-only export and spent an
// automatic repair on it. A single-component file supporting default import
// costs nothing and removes the whole failure class.
export { Reveal };
export default Reveal;
`;

/**
 * The eyebrow / title / lede opening every content section repeats.
 *
 * One component instead of a prose rule, so the pattern is consistent across
 * sections and pages by construction: same tracking on the eyebrow, same scale
 * step on the title, same measure on the lede. The eyebrow is optional because
 * the editorial direction forbids decorative section markers.
 */
const SECTION_HEADER_SOURCE = `import * as React from 'react';

import { cn } from '@/lib/utils';

type SectionHeaderProps = React.HTMLAttributes<HTMLDivElement> & {
  /** Small uppercase kicker above the title. Omit where the direction says so. */
  eyebrow?: string;
  title: string;
  /** One or two supporting sentences under the title. */
  lede?: string;
  align?: 'left' | 'center';
};

const SectionHeader = React.forwardRef<HTMLDivElement, SectionHeaderProps>(
  ({ className, eyebrow, title, lede, align = 'center', ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'max-w-2xl',
        align === 'center' ? 'mx-auto text-center' : 'text-left',
        className,
      )}
      {...props}
    >
      {eyebrow ? (
        <p className="mb-3 text-sm font-medium uppercase tracking-widest text-primary">
          {eyebrow}
        </p>
      ) : null}
      <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
        {title}
      </h2>
      {lede ? <p className="mt-4 text-lg leading-relaxed text-muted-foreground">{lede}</p> : null}
    </div>
  ),
);
SectionHeader.displayName = 'SectionHeader';

// See Reveal: both import styles resolve on purpose.
export { SectionHeader };
export default SectionHeader;
`;

/** The primitives, keyed by their file name under `components/ui/`. */
const UI_COMPONENTS: Record<string, string> = {
  button: BUTTON_SOURCE,
  card: CARD_SOURCE,
  input: INPUT_SOURCE,
  label: LABEL_SOURCE,
  badge: BADGE_SOURCE,
  skeleton: SKELETON_SOURCE,
  dialog: DIALOG_SOURCE,
  tabs: TABS_SOURCE,
  reveal: REVEAL_SOURCE,
  'section-header': SECTION_HEADER_SOURCE,
};

/**
 * The starter files for a stack, in scaffold shape.
 *
 * `tailwind.config.js` sits alongside them because it is what makes the
 * semantic classes resolve; `lib/starter.ts` is what separates the runtime
 * files from the build config when merging into a live project.
 */
export function starterKitFiles(layout: StarterLayout, tokens: DirectionTokens): ScaffoldFile[] {
  const files: ScaffoldFile[] = [
    { path: layout.globalCssPath, content: renderGlobalCss(tokens) },
    { path: 'tailwind.config.js', content: renderTailwindConfig(layout) },
    { path: `${layout.srcPrefix}lib/utils.ts`, content: UTILS_SOURCE },
  ];
  for (const [name, content] of Object.entries(UI_COMPONENTS)) {
    files.push({ path: `${layout.srcPrefix}components/ui/${name}.tsx`, content });
  }
  // The sections sit beside the primitives rather than inside them: a page
  // composes sections, a section composes primitives, and keeping the two
  // directories apart is what stops the model reaching for `components/ui/hero`
  // and finding nothing.
  for (const [name, content] of Object.entries(SECTION_COMPONENTS)) {
    files.push({ path: `${layout.srcPrefix}components/sections/${name}.tsx`, content });
  }
  return files;
}

/** The primitive names, for the prompt bullet that tells the model they exist. */
export const UI_COMPONENT_NAMES = Object.keys(UI_COMPONENTS);

export { SECTION_COMPONENT_NAMES } from './sections';
