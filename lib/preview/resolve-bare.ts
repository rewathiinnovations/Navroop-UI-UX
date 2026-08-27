import { packageNameOf } from './deps';

/**
 * One answer to "may this bare import be left external?", for both bundlers.
 *
 * Until this existed, `lib/preview/bundle.ts` and `lib/preview/server-bundle.ts`
 * each ended their resolve hook with `if (isBare(path)) return { external: true }`
 * — no allowlist at all. So an import of a package the import map does not serve
 * compiled cleanly, `checkBuild` reported `passed`, the user was told the build
 * succeeded, and the failure landed in the iframe as "The preview could not load
 * one of its packages". It also made `decideAutoFix`'s `action: 'install'` branch
 * unreachable: nothing ever produced a `missing-package` error for it to repair.
 *
 * The two `isBare` predicates had already drifted (one guarded the `vfs:` scheme,
 * the other did not), which is the second reason this is one function: change the
 * rule in one bundler only and the preview and the validator disagree about
 * whether a build is broken.
 *
 * The error text is worded to match a `MISSING_PACKAGE_PATTERNS` entry in
 * `lib/validation/build-check.ts`, so `extractMissingPackages` populates from it
 * and `kind: 'missing-package'` starts being produced with no change to the
 * autofix policy.
 *
 * Client-safe: `lib/preview/bundle.ts` reaches this from `BrowserPreview.tsx`, so
 * it may not import Prisma, the logger, the settings resolver or any `node:*`
 * builtin — not even type-only, because Turbopack would put the value in the
 * browser graph and the route would 500 on a cold compile
 * (tests/unit/client-import-boundary.test.ts).
 */

export type BareResolution = { external: true } | { error: string };

/**
 * The one scheme in the URL grammar below that names a *module* rather than a
 * resource, and the reason the shape test is not the whole answer.
 *
 * `node:fs` satisfies `scheme:` exactly as `https:` does, and a browser resolves
 * neither it nor any other Node builtin — the frame's import map has no entry for
 * one and never will. Left external it compiles clean, `checkBuild` reports
 * `passed`, the user is told the build succeeded, and the frame throws
 * `Failed to resolve module specifier "node:fs"`: precisely the
 * clean-compile-then-die failure this module was written to end. Reported by
 * name it reaches `extractMissingPackages` (`lib/validation/build-check.ts`)
 * like any other unavailable module, so the build fails where someone can see
 * it. Unprefixed `fs` was never at risk — it carries no scheme to be mistaken
 * for a URL — which is what made this half of the pair easy to miss.
 */
const NODE_BUILTIN_SCHEME = /^node:/i;

/**
 * A specifier the browser resolves for itself, which is therefore not a package.
 *
 * esbuild treats the target of a CSS `url()` and an `@import` as a specifier and
 * asks the resolve hook about it, so these arrive here routinely: a Google Fonts
 * `@import url("https://fonts.googleapis.com/…")`, a CDN image, a `data:` URI, a
 * project image rewritten to an absolute URL by `previewAssetOrigin`, and
 * esbuild's own `vfs:` namespace.
 *
 * The blanket `external: true` this function replaced covered all of them by
 * accident. Without this test `packageNameOf('https://app.example/hero.webp')` is
 * `'https:'`, which is in no dependency map — so every generated site carrying a
 * project image, a web font or a CDN asset would fail to build with
 * `Cannot find module "https:"`. That is the opposite of what this function is
 * for: it exists to make a genuinely missing *package* loud, not to invent a
 * failure for a URL that was always fine.
 *
 * Protocol-relative `//host/path` is excluded upstream — both callers treat a
 * leading `/` as a local path — and is matched here anyway, so the rule holds
 * wherever this is called from.
 *
 * `node:` is the exception the scheme test alone gets wrong, so it is subtracted
 * by name first.
 */
function isBrowserResolvableUrl(specifier: string): boolean {
  if (NODE_BUILTIN_SCHEME.test(specifier)) return false;
  return specifier.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(specifier);
}

/**
 * Bare specifiers the frame resolves without an import-map entry.
 *
 * `next/*` modules have no browser build; the ones a generated app actually uses
 * are aliased to shims in `assemblePreview`, and that alias branch runs before
 * this function. A `next/…` path that reaches here therefore has no shim, so it
 * is reported rather than left external — external would only move the same
 * failure into the frame, where it arrives without a file or a package name.
 */
export function resolveBareSpecifier(
  specifier: string,
  deps: Record<string, string>,
): BareResolution {
  if (isBrowserResolvableUrl(specifier)) return { external: true };
  const name = packageNameOf(specifier);
  if (name in deps) return { external: true };
  return { error: `Cannot find module "${name}"` };
}
