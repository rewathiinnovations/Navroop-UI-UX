import { renderTokenCss, type DirectionTokens } from '@/lib/design/directions';
import { renderTailwindConfigBody } from '@/lib/design/tailwind-theme';
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

/** The eight primitives, keyed by their file name under `components/ui/`. */
const UI_COMPONENTS: Record<string, string> = {
  button: BUTTON_SOURCE,
  card: CARD_SOURCE,
  input: INPUT_SOURCE,
  label: LABEL_SOURCE,
  badge: BADGE_SOURCE,
  skeleton: SKELETON_SOURCE,
  dialog: DIALOG_SOURCE,
  tabs: TABS_SOURCE,
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
  return files;
}

/** The primitive names, for the prompt bullet that tells the model they exist. */
export const UI_COMPONENT_NAMES = Object.keys(UI_COMPONENTS);
