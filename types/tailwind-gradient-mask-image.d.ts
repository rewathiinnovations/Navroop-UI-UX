// `tailwind-gradient-mask-image` ships no types and has no `@types/` package, so this is the
// only way to reference it from `tailwind.config.ts` without a `require()` (which
// `@typescript-eslint/no-require-imports` rejects) or a blanket file-level disable.
// It is a precise declaration, not an `any` escape hatch: the module's single default export
// is the result of `tailwindcss/plugin(handler)` — see node_modules/tailwind-gradient-mask-image/index.js:65.
declare module 'tailwind-gradient-mask-image' {
  import type { PluginCreator } from 'tailwindcss/types/config';

  const gradientMaskImage: { handler: PluginCreator; config?: undefined };

  export default gradientMaskImage;
}
