/**
 * Where every file in the locked starter kit came from, and under what licence.
 *
 * This exists because of what `withStarterFiles` (lib/stacks/starter.ts) is: the
 * one merge point feeding the browser preview, the served preview build, the
 * validator's compile, the ZIP export *and* `buildRepoFiles`. That last one is
 * the reason a licence is not a formality here — a starter file is pushed into
 * a repository the client owns and deployed by Coolify as a network service, so
 * vendoring a component is redistribution plus public performance, on someone
 * else's property. A copyleft licence reaches the client's site, not ours.
 *
 * The trap is real rather than theoretical. Origin UI is described as MIT by
 * every list that mentions it; its repository root is AGPL-3.0 with MIT
 * carve-outs limited to two sub-directories, and AGPL section 13 triggers on
 * exactly the deploy shape above. A README is not a licence and a blog post is
 * not provenance, so the answer has to be a fact the build checks.
 *
 * `starter-kit.ts`'s header has always claimed the primitives are "upstream
 * shadcn/ui for Tailwind v3, unmodified beyond the import path". That claim was
 * true and checked by nobody. This module makes it a typed entry per merged
 * path, `tests/unit/starter-kit-provenance.test.ts` fails when a path has no
 * entry or an entry falls outside the allowlist, and `renderStarterCredits`
 * emits the attribution MIT actually requires into the published repo — so the
 * notice travels with the code instead of living in a comment here.
 *
 * Add the entry *before* the file. A missing entry is a failing test, which is
 * the point: it makes vendoring deliberately slower than copy-paste.
 */

/**
 * Licences a starter file may carry.
 *
 * Permissive and attribution-only, all of them. Nothing reciprocal: a starter
 * file lands in a repository the client owns, and neither we nor they can honour
 * a source-disclosure obligation on a site whose source is the product. Adding
 * to this list is a legal decision, not a formatting one.
 */
export const ALLOWED_STARTER_LICENSES = [
  'MIT',
  'Apache-2.0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
] as const;

export type StarterLicense = (typeof ALLOWED_STARTER_LICENSES)[number];

/** The `origin` of code written for this repository rather than vendored. */
export const FIRST_PARTY_ORIGIN = 'Navroop';

export type StarterProvenance = {
  /** Upstream project name, or `FIRST_PARTY_ORIGIN` for code written here. */
  origin: string;
  license: StarterLicense;
  /** Upstream copyright line. Required for third-party code — it is the notice. */
  copyright?: string;
  /** Where the source can be read. */
  url?: string;
  /** Version, tag or commit the source was taken at. */
  taken?: string;
  /** What was changed after copying, when anything was. */
  modifications?: string;
};

const SHADCN_UI = {
  origin: 'shadcn/ui',
  license: 'MIT',
  copyright: 'Copyright (c) 2023 shadcn',
  url: 'https://github.com/shadcn-ui/ui',
  taken: 'Tailwind v3 integration guide',
} as const satisfies StarterProvenance;

const NAVROOP = { origin: FIRST_PARTY_ORIGIN, license: 'MIT' } as const satisfies StarterProvenance;

/**
 * Keyed by the path a stack merges, with the REACT layout's `src/` prefix
 * removed — the two layouts ship the same component under two paths, and one
 * entry describing one file is the only version of this that cannot disagree
 * with itself. `starterProvenanceForPath` does the stripping.
 */
export const STARTER_PROVENANCE: Record<string, StarterProvenance> = {
  // Generated per design direction by `renderGlobalCss`. The `@layer base`
  // block inside it — the border-colour rule and the body pair — is shadcn/ui's
  // base layer, so the attribution follows the derivation, not the generator.
  'app/globals.css': {
    ...SHADCN_UI,
    modifications:
      'Generated per design direction; base layer derived from shadcn/ui, border selector widened to `html *`.',
  },
  'index.css': {
    ...SHADCN_UI,
    modifications:
      'Generated per design direction; base layer derived from shadcn/ui, border selector widened to `html *`.',
  },
  // Written by `renderTailwindConfig` from this repo's own token list.
  'tailwind.config.js': NAVROOP,
  'lib/utils.ts': SHADCN_UI,
  'components/ui/button.tsx': {
    ...SHADCN_UI,
    modifications: 'Two added variants beyond stock shadcn/ui.',
  },
  'components/ui/card.tsx': SHADCN_UI,
  'components/ui/input.tsx': SHADCN_UI,
  'components/ui/label.tsx': SHADCN_UI,
  'components/ui/badge.tsx': SHADCN_UI,
  'components/ui/skeleton.tsx': SHADCN_UI,
  'components/ui/dialog.tsx': SHADCN_UI,
  'components/ui/tabs.tsx': SHADCN_UI,
  // Not shadcn/ui components — written here, for reasons their own headers give.
  'components/ui/reveal.tsx': NAVROOP,
  'components/ui/section-header.tsx': NAVROOP,
  // The section layer. Written here rather than vendored from a block library:
  // every candidate ships `next/image` and framer-motion, and this directory is
  // merged into REACT projects too, where neither resolves.
  'components/sections/hero.tsx': NAVROOP,
  'components/sections/feature-grid.tsx': NAVROOP,
  'components/sections/pricing-tiers.tsx': NAVROOP,
  'components/sections/testimonials.tsx': NAVROOP,
  'components/sections/logo-cloud.tsx': NAVROOP,
  'components/sections/stats-band.tsx': NAVROOP,
  'components/sections/faq.tsx': NAVROOP,
  'components/sections/cta-band.tsx': NAVROOP,
  'components/sections/contact-form.tsx': NAVROOP,
  'components/sections/site-footer.tsx': NAVROOP,
};

/** The REACT layout's prefix, stripped so one entry covers both layouts. */
function logicalPath(path: string): string {
  return path.replace(/^src\//, '');
}

export function starterProvenanceForPath(path: string): StarterProvenance | undefined {
  return STARTER_PROVENANCE[logicalPath(path)];
}

export function isThirdParty(entry: StarterProvenance): boolean {
  return entry.origin !== FIRST_PARTY_ORIGIN;
}

/**
 * The attribution block for a file set, or `null` when it carries no
 * third-party code.
 *
 * Deduped by origin: MIT asks for the notice to be included, once, not once per
 * file. Paths are listed so a reader can see what the notice covers.
 */
export function renderStarterCredits(paths: readonly string[]): string | null {
  const byOrigin = new Map<string, { entry: StarterProvenance; paths: string[] }>();
  for (const path of [...paths].sort()) {
    const entry = starterProvenanceForPath(path);
    if (!entry || !isThirdParty(entry)) continue;
    const bucket = byOrigin.get(entry.origin);
    if (bucket) bucket.paths.push(path);
    else byOrigin.set(entry.origin, { entry, paths: [path] });
  }
  if (byOrigin.size === 0) return null;

  const sections = [...byOrigin.values()].map(({ entry, paths: covered }) => {
    const lines = [`## ${entry.origin}`, ''];
    if (entry.copyright) lines.push(entry.copyright, '');
    lines.push(`Licence: ${entry.license}`);
    if (entry.url) lines.push(`Source: ${entry.url}`);
    if (entry.taken) lines.push(`Taken at: ${entry.taken}`);
    if (entry.modifications) lines.push(`Modifications: ${entry.modifications}`);
    lines.push('', 'Files:', ...covered.map((path) => `- \`${path}\``));
    return lines.join('\n');
  });

  return [
    '# Third-party notices',
    '',
    'Parts of this project were generated from vetted open-source components.',
    'The notices below are reproduced as their licences require.',
    '',
    ...sections,
  ].join('\n');
}
