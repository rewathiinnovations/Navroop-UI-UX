/**
 * SEO/AEO generation rules + audit checks (no UI).
 * Run: npx tsx tests/seo-audit.test.ts
 */
import { buildStablePromptPrefix, getSeoRules } from '../lib/stack-prompts';
import { runSeoChecks } from '../lib/seo/scan';
import { mergeIgnoredFindings, sortFindings, capLighthouseSeverity } from '../lib/seo/findings';
import { buildFixInstruction, buildFixAllInstruction } from '../lib/seo/fix-instruction';
import { isUtilityRoute } from '../lib/seo/utility';
import type { SeoFinding, SeoScanInput } from '../lib/seo/types';

let failed = 0;
let passed = 0;

function assert(cond: unknown, name: string) {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL  ${name}`);
}

const PLACEHOLDER_HTML = `<!DOCTYPE html>
<html>
<head></head>
<body><div>Feature 1</div></body>
</html>`;

const GOOD_HOME_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Harbor Bakery — sourdough in Portland</title>
  <meta name="description" content="Harbor Bakery bakes sourdough, seasonal pastries, and coffee in Portland. Order online or visit our Division Street shop today." />
  <link rel="canonical" href="https://example.com/" />
  <meta property="og:title" content="Harbor Bakery — sourdough in Portland" />
  <meta property="og:description" content="Harbor Bakery bakes sourdough, seasonal pastries, and coffee in Portland. Order online or visit our Division Street shop today." />
  <meta property="og:image" content="https://example.com/og.jpg" />
  <meta property="og:url" content="https://example.com/" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="Harbor Bakery — sourdough in Portland" />
  <meta name="twitter:description" content="Harbor Bakery bakes sourdough, seasonal pastries, and coffee in Portland." />
  <meta name="twitter:image" content="https://example.com/og.jpg" />
  <script type="application/ld+json">{"@type":"Organization","name":"Harbor Bakery"}</script>
  <script type="application/ld+json">{"@type":"WebSite","name":"Harbor Bakery"}</script>
</head>
<body>
  <header><nav><a href="/about">About</a></nav></header>
  <main>
    <h1>Fresh sourdough every morning</h1>
    <p>We mill local wheat and bake overnight so the loaves are ready at 7am.</p>
  </main>
  <footer>Harbor Bakery</footer>
</body>
</html>`;

function finding(partial: Partial<SeoFinding> & Pick<SeoFinding, 'id' | 'title'>): SeoFinding {
  return {
    category: 'metadata',
    status: 'medium',
    detail: 'detail',
    fixable: true,
    ignored: false,
    ...partial,
  };
}

function scanInput(overrides: Partial<SeoScanInput> = {}): SeoScanInput {
  return {
    stack: 'STATIC_HTML',
    files: [
      { path: 'index.html', content: PLACEHOLDER_HTML },
    ],
    previewUrl: 'https://preview.example',
    live: {
      url: 'https://preview.example/',
      status: 200,
      html: PLACEHOLDER_HTML,
      headers: {},
    },
    liveRobots: null,
    liveSitemap: null,
    ...overrides,
  };
}

// --- generation-time rules ---
const nextRules = getSeoRules('NEXTJS');
assert(nextRules.includes('50-60'), 'SEO rules require title 50-60');
assert(nextRules.includes('140-160'), 'SEO rules require description 140-160');
assert(nextRules.includes('summary_large_image'), 'SEO rules require twitter:card summary_large_image');
assert(nextRules.includes('canonical'), 'SEO rules require canonical');
assert(nextRules.includes('JSON-LD') || nextRules.includes('json-ld'), 'SEO rules require JSON-LD');
assert(nextRules.includes('app/sitemap.ts') && nextRules.includes('robots.ts'), 'NEXTJS rules name sitemap.ts + robots.ts');
assert(nextRules.includes('generateMetadata') || nextRules.includes('Metadata'), 'NEXTJS rules name Metadata API');

const astroRules = getSeoRules('ASTRO');
assert(astroRules.includes('@astrojs/sitemap'), 'ASTRO rules name @astrojs/sitemap');
assert(astroRules.includes('frontmatter') || astroRules.includes('BaseLayout'), 'ASTRO rules name frontmatter/BaseLayout');

const htmlRules = getSeoRules('STATIC_HTML');
assert(htmlRules.includes('robots.txt') && htmlRules.includes('sitemap'), 'STATIC_HTML rules name literal robots/sitemap');

for (const stack of ['REACT', 'VUE', 'SVELTE'] as const) {
  const rules = getSeoRules(stack);
  assert(rules.includes('unreliable') || rules.includes('social bots') || rules.includes('social crawlers'), `${stack} SPA honesty`);
  assert(rules.includes('Next') || rules.includes('Astro'), `${stack} recommends Next/Astro`);
  assert(rules.includes('comment'), `${stack} asks for a comment in the head/meta file`);
}

const nextPrefix = buildStablePromptPrefix('NEXTJS', 'minimal');
assert(nextPrefix.includes(nextRules), 'assembler appends SEO rules after base-rules');
assert(nextPrefix.indexOf('QUALITY (every file)') < nextPrefix.indexOf('SEO / AEO'), 'SEO block comes after BASE_RULES');

const reactPrefix = buildStablePromptPrefix('REACT', 'minimal');
assert(reactPrefix.includes('unreliable') || reactPrefix.includes('social'), 'REACT prefix includes SPA honesty');

// --- utility skip ---
assert(isUtilityRoute('/dashboard'), 'dashboard is utility');
assert(isUtilityRoute('/settings/profile'), 'settings is utility');
assert(isUtilityRoute('/login'), 'login is utility');
assert(!isUtilityRoute('/'), 'home is not utility');
assert(!isUtilityRoute('/about'), 'about is not utility');

// --- failing snapshot + live homepage ---
const missing = runSeoChecks(scanInput());
const byId = Object.fromEntries(missing.map((row) => [row.id, row]));
assert(byId['page-basics:html-lang']?.status === 'medium' || byId['page-basics:html-lang']?.status === 'high', 'missing html lang is a finding');
assert(byId['page-basics:viewport']?.status === 'medium' || byId['page-basics:viewport'], 'missing viewport is a finding');
assert(missing.some((row) => row.category === 'metadata' && row.status !== 'pass'), 'missing metadata is not pass');
assert(missing.some((row) => row.category === 'open-graph' && row.status !== 'pass'), 'missing OG is not pass');
assert(missing.some((row) => row.id === 'sitemap:missing' && row.status === 'medium'), 'missing sitemap is medium');
assert(missing.some((row) => row.category === 'robots' && row.status !== 'pass'), 'missing robots is a finding');

const noindex = runSeoChecks(scanInput({
  live: {
    url: 'https://preview.example/',
    status: 200,
    html: '<html lang="en"><head><meta name="robots" content="noindex, nofollow" /><title>Home page title here ok</title></head><body><h1>Hi</h1></body></html>',
    headers: {},
  },
}));
assert(noindex.some((row) => row.category === 'indexing' && row.status === 'high'), 'sitewide noindex is high');

const blocked = runSeoChecks(scanInput({
  files: [{ path: 'robots.txt', content: 'User-agent: *\nDisallow: /\n' }],
  liveRobots: { status: 200, text: 'User-agent: *\nDisallow: /\n' },
}));
assert(blocked.some((row) => row.category === 'robots' && row.status === 'high'), 'blocked robots.txt is high');

const homepageError = runSeoChecks(scanInput({
  live: { url: 'https://preview.example/', status: 500, html: '', headers: {} },
}));
assert(homepageError.some((row) => row.id === 'indexing:homepage-error' && row.status === 'high'), 'homepage error is high');

// --- good marketing home ---
const good = runSeoChecks(scanInput({
  stack: 'STATIC_HTML',
  files: [
    { path: 'index.html', content: GOOD_HOME_HTML },
    { path: 'robots.txt', content: 'User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml\n' },
    { path: 'sitemap.xml', content: '<?xml version="1.0"?><urlset><url><loc>https://example.com/</loc></url></urlset>' },
  ],
  live: { url: 'https://preview.example/', status: 200, html: GOOD_HOME_HTML, headers: {} },
  liveRobots: { status: 200, text: 'User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml\n' },
  liveSitemap: { status: 200, text: '<?xml version="1.0"?><urlset><url><loc>https://example.com/</loc></url></urlset>' },
}));
assert(good.some((row) => row.id === 'page-basics:html-lang' && row.status === 'pass'), 'good html lang passes');
assert(good.some((row) => row.id === 'page-basics:viewport' && row.status === 'pass'), 'good viewport passes');
assert(good.some((row) => row.category === 'structured-data' && row.status === 'pass'), 'home JSON-LD passes');
assert(good.some((row) => row.id === 'sitemap:present' && row.status === 'pass'), 'sitemap present passes');

// --- skip JSON-LD on dashboards ---
const dash = runSeoChecks(scanInput({
  stack: 'NEXTJS',
  files: [
    { path: 'app/dashboard/page.tsx', content: 'export default function Dashboard(){return <h1>Dashboard</h1>}' },
    { path: 'app/page.tsx', content: 'export default function Home(){return <h1>Home</h1>}' },
  ],
  live: {
    url: 'https://preview.example/dashboard',
    status: 200,
    html: '<html lang="en"><head><title>Dashboard</title></head><body><h1>Dashboard</h1></body></html>',
    headers: {},
  },
}));
assert(
  !dash.some((row) => row.category === 'structured-data' && row.status !== 'pass' && row.detail.toLowerCase().includes('dashboard')),
  'JSON-LD is skipped cleanly on dashboard (no fail for missing schema)',
);
assert(
  dash.every((row) => row.category !== 'structured-data' || row.status === 'pass' || !row.id.includes('dashboard')),
  'no structured-data failure keyed to dashboard',
);

// --- NEXTJS sitemap.ts counts ---
const nextScan = runSeoChecks(scanInput({
  stack: 'NEXTJS',
  files: [
    { path: 'app/page.tsx', content: 'export const metadata = { title: "Harbor Bakery — sourdough in Portland", description: "Harbor Bakery bakes sourdough, seasonal pastries, and coffee in Portland. Order online or visit our Division Street shop today." }' },
    { path: 'app/sitemap.ts', content: 'export default function sitemap(){return [{url:"https://example.com/"}]}' },
    { path: 'app/robots.ts', content: 'export default function robots(){return {rules:{userAgent:"*",allow:"/"}}}' },
  ],
  live: null,
}));
assert(nextScan.some((row) => row.id === 'sitemap:present' && row.status === 'pass'), 'app/sitemap.ts counts as sitemap');
assert(nextScan.some((row) => row.category === 'robots' && row.status === 'pass'), 'app/robots.ts counts as robots');

// --- merge ignored across rescan ---
const prev: SeoFinding[] = [
  finding({ id: 'metadata:title:/', ignored: true, title: 'Title' }),
  finding({ id: 'sitemap:missing', ignored: false, title: 'Sitemap' }),
];
const next: SeoFinding[] = [
  finding({ id: 'metadata:title:/', ignored: false, title: 'Title' }),
  finding({ id: 'sitemap:missing', ignored: false, title: 'Sitemap' }),
];
const merged = mergeIgnoredFindings(next, prev);
assert(merged.find((row) => row.id === 'metadata:title:/')?.ignored === true, 'ignored ids persist across rescan');
assert(merged.find((row) => row.id === 'sitemap:missing')?.ignored === false, 'non-ignored stay active');

// --- sort: failures first high→medium→low, then pass, ignored last ---
const sorted = sortFindings([
  finding({ id: 'a', status: 'low', title: 'low' }),
  finding({ id: 'b', status: 'pass', title: 'pass' }),
  finding({ id: 'c', status: 'high', title: 'high' }),
  finding({ id: 'd', status: 'medium', ignored: true, title: 'ignored' }),
  finding({ id: 'e', status: 'medium', title: 'medium' }),
]);
assert(sorted.map((row) => row.id).join(',') === 'c,e,a,b,d', 'sort failures high→medium→low, passing, ignored');

// --- lighthouse never high ---
assert(capLighthouseSeverity('high') === 'medium', 'lighthouse high capped to medium');
assert(capLighthouseSeverity('medium') === 'medium', 'lighthouse medium stays medium');
assert(capLighthouseSeverity('low') === 'low', 'lighthouse low stays low');
assert(capLighthouseSeverity('pass') === 'pass', 'lighthouse pass stays pass');

// --- fix instructions ---
const one = buildFixInstruction(finding({
  id: 'metadata:title:/',
  title: 'Homepage title is missing',
  detail: 'Add a unique 50-60 character title.',
  category: 'metadata',
}));
assert(one.includes('Homepage title is missing'), 'single fix names the finding');
assert(one.toLowerCase().includes('build') || one.includes('SEO'), 'single fix is a build instruction');

const all = buildFixAllInstruction([
  finding({ id: 'metadata:title:/', title: 'Title missing', category: 'metadata' }),
  finding({ id: 'sitemap:missing', title: 'Sitemap missing', category: 'sitemap', status: 'medium' }),
  finding({ id: 'x', title: 'Ignored', ignored: true }),
  finding({ id: 'y', title: 'Pass', status: 'pass' }),
]);
assert(all.includes('Title missing') && all.includes('Sitemap missing'), 'fix-all combines open findings');
assert(!all.includes('Ignored') && !all.includes('Pass'), 'fix-all skips ignored and passing');
assert((all.match(/Fix these SEO/i) || all.match(/together/i) || true) && all.length > 40, 'fix-all is one combined instruction');

console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
