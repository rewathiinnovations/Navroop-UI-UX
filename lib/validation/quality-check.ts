import type { StackId } from '@/lib/stacks';
import { SECTION_COMPONENT_NAMES } from '@/lib/stacks/templates/sections';

/**
 * Defects a compiler cannot see.
 *
 * The build check answers "does this bundle". Everything here is code that
 * bundles perfectly and is still broken when a person looks at it:
 *
 * - a nav that links to `/shop` when no `app/shop/page.tsx` exists — the header
 *   compiles, the click 404s,
 * - `<Button variant="outline" className="text-primary-foreground">`, where the
 *   className overrides the text colour but not the variant's background, so the
 *   label is cream on cream and the button reads as an empty white rectangle
 *   (this shipped: the "Call Us Now" CTA of a generated clinic),
 * - `href="#"` left in a nav as a placeholder,
 * - a raw `<img>` on a Next.js project, which costs the layout shift the
 *   prompt's own IMAGES section exists to prevent.
 *
 * Findings are split by what they cost. `blocking` findings are wrong output —
 * they earn a repair generation through the existing autofix loop. `advisory`
 * findings are quality notes: reported, never worth a billed retry on their own.
 *
 * Pure, synchronous and dependency-free, like `lib/generation/validate-imports.ts`,
 * for the same reason: it runs inside the generation route on every build.
 */

export type QualityFindingKind =
  | 'missing-route'
  | 'missing-planned-route'
  | 'missing-section'
  | 'placeholder-link'
  | 'invisible-control'
  | 'raw-img'
  | 'raw-color'
  | 'emoji'
  | 'no-motion'
  | 'flat-rhythm';

/** The slice of an approved plan page this module checks against. */
export type PlannedPage = {
  route?: string;
  sections?: readonly string[];
};

export type QualityFinding = {
  kind: QualityFindingKind;
  /** Repo-relative path of the file the finding is in. */
  file: string;
  /** Plain English, naming the file and what is wrong. Repair copy. */
  message: string;
};

export type QualityCheckOutcome = {
  blocking: QualityFinding[];
  advisory: QualityFinding[];
  /** One line for chat and the job step. Empty when nothing was found. */
  summary: string;
  /** The instruction a repair generation is given. Empty when nothing blocks. */
  instruction: string;
};

/** A dozen problems is readable; forty is a wall the model will skim. */
const MAX_FINDINGS = 10;

/**
 * The catalogue's names, so a plan naming a section that does not exist is ignored rather
 * than reported. Imported as a name list only: this module is pure, synchronous and
 * dependency-free because it runs inside the generation route on every build.
 */
const KNOWN_SECTION_NAMES = new Set<string>(SECTION_COMPONENT_NAMES);

const CODE_FILE = /\.(tsx|jsx)$/;

/**
 * Strip comments and string-ish noise that would otherwise produce phantom
 * matches. Deliberately crude — every gap here is a miss, never a false alarm,
 * which is the correct trade for a check that can spend a generation.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/* ------------------------------------------------------------------ routes */

/** `app/shop/page.tsx` -> `/shop`; `app/(site)/blog/[slug]/page.tsx` -> `/blog/[slug]`. */
function routesOf(files: Record<string, string>): string[] {
  const routes: string[] = [];
  for (const path of Object.keys(files)) {
    const match = /^app\/(.*\/)?page\.(tsx|jsx)$/.exec(path);
    if (!match) continue;
    const segments = (match[1] ?? '')
      .split('/')
      .filter(Boolean)
      // Route groups and parallel/intercepting segments are not URL segments.
      .filter((segment) => !/^[(@]/.test(segment));
    routes.push(`/${segments.join('/')}`.replace(/\/$/, '') || '/');
  }
  return routes;
}

/**
 * Normalise a route the way a link is normalised, or reject it.
 *
 * The plan's `route` is optional free text a model wrote, so a stored plan can
 * legitimately carry `Home` or an empty string. Anything that is not a path is
 * skipped rather than reported: a false blocking finding here spends a billed
 * repair generation rebuilding a site the user did not ask about.
 */
function normalizePlannedRoute(value: string): string | null {
  const clean = value.trim().split('?')[0].split('#')[0].replace(/\/+$/, '') || '/';
  return clean.startsWith('/') ? clean : null;
}

/**
 * A route with its dynamic parameter *names* erased.
 *
 * The plan may promise `/product/[slug]` and the model may write
 * `app/product/[id]/page.tsx`. Those are the same route — Next.js resolves both
 * identically and the param name is the implementation's business — so
 * comparing the raw strings would fail a page that exists.
 */
function routeShape(route: string): string {
  return route
    .split('/')
    .map((segment) => {
      if (/^\[\.\.\..+\]$/.test(segment)) return '[...]';
      return /^\[.+\]$/.test(segment) ? '[]' : segment;
    })
    .join('/');
}

/**
 * Routes the approved plan promised that no page file renders.
 *
 * `missing-route` scrapes hrefs out of generated JSX, so it can only see a
 * broken *link*. A page the plan approved, the user paid for and the model
 * silently never wrote is linked from nowhere, and therefore passes every gate
 * in the pipeline — the site is simply smaller than the plan the user agreed
 * to. `combineBuildContext` has always claimed "the list is a contract, not a
 * suggestion"; this is the check that makes the claim true.
 *
 * Deliberately not the mirror image: a route the model wrote that the plan did
 * not promise is fine. Building more than was asked for is not a defect.
 */
function checkPlannedRoutes(
  planned: readonly string[],
  routes: readonly string[],
  findings: QualityFinding[],
): void {
  const built = new Set(routes.map(routeShape));
  const seen = new Set<string>();
  for (const entry of planned) {
    if (typeof entry !== 'string') continue;
    const route = normalizePlannedRoute(entry);
    if (!route) continue;
    const shape = routeShape(route);
    if (seen.has(shape) || built.has(shape)) continue;
    seen.add(shape);
    const file = `app${route === '/' ? '' : route}/page.tsx`;
    findings.push({
      kind: 'missing-planned-route',
      file,
      message: `The approved plan promised the route ${route}, and no page renders it. Create ${file} with the page the plan describes. Do not satisfy this by deleting the route from the site.`,
    });
  }
}

/** `app/pricing/page.tsx` -> `/pricing`, matching `routesOf`'s own derivation. */
function routeOfPagePath(path: string): string | null {
  const match = /^app\/(.*\/)?page\.(tsx|jsx)$/.exec(path);
  if (!match) return null;
  const segments = (match[1] ?? '')
    .split('/')
    .filter(Boolean)
    .filter((segment) => !/^[(@]/.test(segment));
  return `/${segments.join('/')}`.replace(/\/$/, '') || '/';
}

/** Sections a file imports from the catalogue, by their registry name. */
function importedSections(source: string): Set<string> {
  const found = new Set<string>();
  const pattern = /from\s+['"]@\/components\/sections\/([a-z0-9-]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) found.add(match[1]);
  return found;
}

/**
 * Sections the approved plan promised a page, that the page does not import.
 *
 * `missing-planned-route` catches a page that was never written at all; this catches the
 * page that was written thin. A generation that produces a hero and then stops satisfies
 * every other gate — the imports resolve, the bundle compiles, the route exists — and the
 * user gets a third of the page they approved, with the pipeline reporting success.
 *
 * Import-based rather than usage-based on purpose. A regex over JSX would have to decide
 * what counts as rendering a component and would be wrong in both directions; an import of
 * a catalogue section that is never used is dead code the model does not write, and if it
 * ever did, `knip` is the check that owns it.
 */
function checkPlannedSections(
  pages: readonly PlannedPage[],
  files: Record<string, string>,
  findings: QualityFinding[],
): void {
  const byRoute = new Map<string, { path: string; sections: Set<string> }>();
  for (const [path, raw] of Object.entries(files)) {
    if (typeof raw !== 'string') continue;
    const route = routeOfPagePath(path);
    if (route) byRoute.set(routeShape(route), { path, sections: importedSections(raw) });
  }

  for (const page of pages) {
    if (!page.sections?.length) continue;
    const route = page.route ? normalizePlannedRoute(page.route) : null;
    if (!route) continue;
    const built = byRoute.get(routeShape(route));
    // No page file at all is `missing-planned-route`'s finding, not a second report here.
    if (!built) continue;

    const promised = [...new Set(page.sections)].filter((name) => KNOWN_SECTION_NAMES.has(name));
    const absent = promised.filter((name) => !built.sections.has(name));
    if (absent.length === 0) continue;

    findings.push({
      kind: 'missing-section',
      file: built.path,
      message: `${built.path}: the approved plan gives ${route} the ${absent.join(', ')} section${absent.length === 1 ? '' : 's'}, and the page does not use ${absent.length === 1 ? 'it' : 'them'}. Call use_section for each and add ${absent.length === 1 ? 'it' : 'them'} in the order the plan lists.`,
    });
  }
}

/**
 * Segments that are an action, never an identifier.
 *
 * `/shipments/new` matches `app/shipments/[id]/page.tsx`, so a naive resolver
 * calls it fine — and Next.js agrees, which is the problem: the "Add shipment"
 * button opens the *detail* page with an id of "new", which renders "not found"
 * or throws. A dynamic segment hides a missing page rather than 404ing it, and
 * this shipped: a generated logistics dashboard's primary CTA went nowhere.
 */
const ACTION_SEGMENTS = new Set(['new', 'create', 'add', 'edit', 'compose', 'signup', 'login']);

type RouteVerdict = 'ok' | 'missing' | 'action-under-dynamic';

function routeVerdict(href: string, routes: readonly string[]): RouteVerdict {
  const clean = href.split('?')[0].split('#')[0].replace(/\/$/, '') || '/';
  const parts = clean.split('/').filter(Boolean);

  let viaDynamicAction = false;
  for (const route of routes) {
    const routeParts = route.split('/').filter(Boolean);
    // A catch-all swallows everything below it.
    const catchAll = routeParts.some((segment) => segment.startsWith('[...'));
    if (!catchAll && routeParts.length !== parts.length) continue;

    let matched = true;
    let action = false;
    for (let i = 0; i < routeParts.length; i += 1) {
      const segment = routeParts[i];
      if (segment.startsWith('[')) {
        if (ACTION_SEGMENTS.has((parts[i] ?? '').toLowerCase())) action = true;
        continue;
      }
      if (segment !== parts[i]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    if (!action) return 'ok';
    viaDynamicAction = true;
  }
  return viaDynamicAction ? 'action-under-dynamic' : 'missing';
}

/**
 * Both spellings a link uses.
 *
 * `href="/about"` is the JSX attribute; `href: '/about'` is the object literal a
 * nav array is built from, which is how most generated headers are written. A
 * scanner that only knew the first read a header with five dead links as clean.
 */
const INTERNAL_HREF = /href\s*[=:]\s*(?:"([^"]*)"|'([^']*)'|\{?`([^`]*)`\}?)/g;

function checkRoutes(
  path: string,
  source: string,
  routes: readonly string[],
  findings: QualityFinding[],
) {
  const seen = new Set<string>();
  for (const match of source.matchAll(INTERNAL_HREF)) {
    const href = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!href || seen.has(href)) continue;
    seen.add(href);

    if (href === '#') {
      findings.push({
        kind: 'placeholder-link',
        file: path,
        message: `${path}: a link points at href="#". Point it at the real route or section id, or make it a button.`,
      });
      continue;
    }
    // Only in-app paths. Anchors, mail, tel, protocol-relative and absolute URLs
    // are somebody else's problem.
    if (!href.startsWith('/') || href.startsWith('//')) continue;
    // A templated href resolves at runtime; the route it lands on is unknowable
    // here, and guessing would fail a correct dynamic link.
    if (href.includes('${')) continue;

    const verdict = routeVerdict(href, routes);
    if (verdict === 'ok') continue;

    findings.push({
      kind: 'missing-route',
      file: path,
      message:
        verdict === 'action-under-dynamic'
          ? `${path}: links to ${href}, which has no page of its own and is swallowed by the dynamic route beside it — so the button opens a detail page for an item called "${href.split('/').pop()}". Create app${href}/page.tsx, or remove the link.`
          : `${path}: links to ${href}, but no page file renders that route. Create app${href === '/' ? '' : href}/page.tsx, or link somewhere that exists.`,
    });
  }
}

/* ---------------------------------------------------------------- contrast */

/**
 * A shadcn variant whose background the call site does not also set.
 *
 * `outline`, `ghost` and `link` all render on the page background. Overriding
 * only the foreground at the call site is how a cream label ended up on a cream
 * surface. The rule the prompt already states — put it in a cva variant — is
 * unenforced prose until something checks it.
 */
const TRANSPARENT_VARIANTS = ['outline', 'ghost', 'link'];
const LIGHT_TEXT_CLASSES = [
  'text-primary-foreground',
  'text-background',
  'text-white',
  'text-card',
];

const ELEMENT = /<([A-Z][\w.]*)\b([^>]*)>/g;

function attributeValue(attributes: string, name: string): string | null {
  const quoted = new RegExp(`${name}=(?:"([^"]*)"|'([^']*)')`).exec(attributes);
  if (quoted) return quoted[1] ?? quoted[2] ?? null;
  // className={cn("…", …)} — the literal parts are what matter here.
  const braced = new RegExp(`${name}=\\{([^}]*)\\}`).exec(attributes);
  if (!braced) return null;
  return [...braced[1].matchAll(/["'`]([^"'`]*)["'`]/g)].map((match) => match[1]).join(' ');
}

function checkInvisibleControls(path: string, source: string, findings: QualityFinding[]) {
  for (const match of source.matchAll(ELEMENT)) {
    const attributes = match[2] ?? '';
    const variant = attributeValue(attributes, 'variant');
    if (!variant || !TRANSPARENT_VARIANTS.includes(variant)) continue;
    const className = attributeValue(attributes, 'className');
    if (!className) continue;
    const setsLightText = LIGHT_TEXT_CLASSES.some((token) =>
      new RegExp(`(^|\\s)${token}(\\s|$)`).test(className),
    );
    if (!setsLightText) continue;
    // A background on the same element makes the pair deliberate.
    if (/(^|\s)(bg-|hover:bg-)/.test(className) && /(^|\s)bg-[\w[]/.test(className)) continue;

    findings.push({
      kind: 'invisible-control',
      file: path,
      message: `${path}: <${match[1]} variant="${variant}"> sets a light foreground (${className.trim().slice(0, 60)}) but no background. That variant is transparent, so the label disappears into the page. Add a cva variant with its own background and foreground in components/ui, and use it by name.`,
    });
  }
}

/* -------------------------------------------------------------- advisories */

const RAW_COLOR =
  /\b(?:bg|text|border)-\[#[0-9a-fA-F]{3,8}\]|\b(?:bg-black|bg-white|text-white|text-black|bg-gray-\d{2,3}|text-gray-\d{2,3})\b|style=\{\{/;

// Pictographs only. Punctuation, arrows and symbols are legitimate in copy.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;

function checkAdvisories(stack: StackId, path: string, source: string, findings: QualityFinding[]) {
  if (stack === 'NEXTJS' && /<img\b/.test(source)) {
    findings.push({
      kind: 'raw-img',
      file: path,
      message: `${path}: uses a raw <img>. On this stack that is next/image, with width and height set, and priority on an above-the-fold hero.`,
    });
  }
  if (RAW_COLOR.test(source)) {
    findings.push({
      kind: 'raw-color',
      file: path,
      message: `${path}: uses a raw colour or an inline style instead of the project's semantic token classes.`,
    });
  }
  if (EMOJI.test(source)) {
    findings.push({
      kind: 'emoji',
      file: path,
      message: `${path}: contains an emoji. Icons come from lucide-react.`,
    });
  }
}

/* ------------------------------------------------------------------ public */

export function checkGeneratedQuality(input: {
  stack: StackId;
  /** The whole project as it will exist: stored files merged with new ones. */
  files: Record<string, string>;
  /** Paths this run wrote. A defect in an untouched file is pre-existing. */
  changedPaths?: string[];
  /**
   * Routes the approved plan promised, for a first build only.
   *
   * The caller passes these solely when the run is not an edit: a follow-up
   * edit legitimately does not rebuild every planned page, and firing there
   * would spend a repair generation reconstructing pages nobody asked about.
   */
  plannedRoutes?: readonly string[];
  /**
   * The approved plan's pages, for the section half of the same contract. Passed on a first
   * build only, for the reason `plannedRoutes` gives.
   */
  plannedPages?: readonly PlannedPage[];
}): QualityCheckOutcome {
  const { stack, files } = input;
  const scope = input.changedPaths ? new Set(input.changedPaths) : null;
  const routes = routesOf(files);

  const blocking: QualityFinding[] = [];
  const advisory: QualityFinding[] = [];

  // First, so that a whole missing page leads the repair instruction rather
  // than being cut by MAX_FINDINGS behind a list of contrast notes. NEXTJS only:
  // `routesOf` reads `app/**/page.tsx`, a convention the other stacks do not
  // have, so anywhere else every planned route would report as missing.
  if (stack === 'NEXTJS' && input.plannedRoutes?.length) {
    checkPlannedRoutes(input.plannedRoutes, routes, blocking);
  }
  if (stack === 'NEXTJS' && input.plannedPages?.length) {
    checkPlannedSections(input.plannedPages, files, blocking);
  }

  for (const [path, raw] of Object.entries(files)) {
    if (typeof raw !== 'string') continue;
    if (!CODE_FILE.test(path)) continue;
    if (scope && !scope.has(path)) continue;

    const source = stripComments(raw);
    // A project with no page files at all is mid-edit or a different stack:
    // every href would be reported, and every report would be wrong.
    if (routes.length > 0) checkRoutes(path, source, routes, blocking);
    checkInvisibleControls(path, source, blocking);
    checkAdvisories(stack, path, source, advisory);
  }

  // Whole-page craft, judged across the build rather than per file. Advisory
  // only: taste is not worth a billed repair, but a page with zero motion and
  // every section on the same background is the measured signature of the
  // template-default output this pipeline exists to beat (three full runs, zero
  // animations, zero surface changes). Only on builds big enough to be a page,
  // so a one-file edit is never nagged about the whole site's craft.
  const scopedSources = Object.entries(files)
    .filter(([path]) => CODE_FILE.test(path) && (!scope || scope.has(path)))
    .map(([, raw]) => raw);
  if (scopedSources.length >= 5) {
    const joined = scopedSources.join('\n');
    const sectionCount = (joined.match(/<section\b/g) ?? []).length;
    const hasMotion = /<Reveal\b|animate-(fade|scale)/.test(joined);
    if (sectionCount >= 3 && !hasMotion) {
      advisory.push({
        kind: 'no-motion',
        file: 'app/page.tsx',
        message:
          'No entrance motion anywhere: wrap section containers in <Reveal> from components/ui/reveal and give the hero animate-fade-up, as the design rules require.',
      });
    }
    const altSurfaces = (
      joined.match(
        /<section[^>]*(bg-secondary|bg-muted|bg-card|bg-primary|bg-foreground|bg-gradient)/g,
      ) ?? []
    ).length;
    if (sectionCount >= 3 && altSurfaces === 0) {
      advisory.push({
        kind: 'flat-rhythm',
        file: 'app/page.tsx',
        message:
          'Every section sits on the same background. Alternate section surfaces (bg-secondary/50, bg-muted/40, bg-card, one inverted band) so the page has rhythm.',
      });
    }
  }

  const capped = blocking.slice(0, MAX_FINDINGS);
  const summary =
    capped.length > 0
      ? `Found ${blocking.length} issue${blocking.length === 1 ? '' : 's'} the compiler cannot see: ${[
          ...new Set(capped.map((finding) => finding.kind)),
        ].join(', ')}.`
      : '';

  const instruction =
    capped.length > 0
      ? [
          'The generated site compiles, but these defects would be visible to a person using it. Fix every one, changing only the files named:',
          ...capped.map((finding) => `- ${finding.message}`),
          'Return the complete corrected files. Do not restyle anything else.',
        ].join('\n')
      : '';

  return { blocking, advisory, summary, instruction };
}
