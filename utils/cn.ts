import { type ClassNameValue, extendTailwindMerge } from 'tailwind-merge';

/**
 * The design-system font-size scale from `theme.extend.fontSize` in
 * tailwind.config.ts. It has to be spelled out here because tailwind-merge
 * classifies any unrecognised `text-*` class as a text COLOUR, and would
 * therefore treat `text-label-medium` and `text-heat-100` as a conflict and drop
 * the typography half. `tests/unit/cn-semantics.test.ts` fails if this list and
 * the Tailwind config drift apart.
 */
export const DESIGN_SYSTEM_FONT_SIZES = [
  'title-h1',
  'title-h2',
  'title-h3',
  'title-h4',
  'title-h5',
  'title-blog',
  'body-x-large',
  'body-large',
  'body-medium',
  'body-small',
  'body-input',
  'label-x-large',
  'label-large',
  'label-medium',
  'label-small',
  'label-x-small',
  'mono-medium',
  'mono-small',
  'mono-x-small',
] as const;

const twMerge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: [...DESIGN_SYSTEM_FONT_SIZES] }] } },
});

/**
 * The one class-name helper. Two used to exist under the same name (F-637):
 * `utils/cn.ts` wrapped `classnames`, which only concatenates, so a caller's
 * `className` never overrode a variant class — stylesheet order decided the
 * winner and the standard shadcn override idiom silently did not work.
 * `lib/utils.ts` wrapped `twMerge(clsx(...))` and did resolve conflicts; it is
 * gone and its importers point here.
 *
 * `twMerge` accepts the same argument shapes `classnames` did (strings, falsy
 * values, nested arrays); object syntax was never used anywhere in the tree.
 */
export function cn(...classes: ClassNameValue[]) {
  return twMerge(classes);
}
