/**
 * Code-quality audit parsers + helpers (no UI, no live sandbox).
 * Run: npx tsx tests/code-audit.test.ts
 */
import { parseTscOutput } from '../lib/audit/static/typescript';
import { parseEslintJson, eslintConfigForStack } from '../lib/audit/static/lint';
import { parseDepcheckJson, parseNpmAuditJson } from '../lib/audit/static/dependencies';
import { parseKnipJson, parseTsPruneOutput } from '../lib/audit/static/dead-code';
import { toolFailedFinding } from '../lib/audit/static/tool-fail';
import { findingsFromBundle, measureShouldSkip } from '../lib/audit/bundle';
import { mapAxeImpact, findingsFromAxe, dedupeA11yAgainstSeo } from '../lib/audit/a11y';
import { shouldSkipAiReview, selectFilesForAiReview, parseAiReviewJson } from '../lib/audit/ai-review';
import { mergeIgnoredFindings, sortFindings, asCodeFindings, asMetrics, emptyMetrics } from '../lib/audit/findings';
import { buildFixInstruction, buildFixAllInstruction } from '../lib/audit/fix-instruction';
import { groupRecurringIssues } from '../lib/audit/recurring';
import { getStack } from '../lib/stacks';
import type { CodeFinding } from '../lib/audit/types';
import type { SeoFinding } from '../lib/seo/types';

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

function finding(partial: Partial<CodeFinding> & Pick<CodeFinding, 'id' | 'title'>): CodeFinding {
  return {
    category: 'typescript',
    status: 'medium',
    detail: 'detail',
    fixable: true,
    ignored: false,
    ...partial,
  };
}

// --- tsc parser ---
const tscOut = [
  'src/App.tsx(12,5): error TS2322: Type \'string\' is not assignable to type \'number\'.',
  'app/page.tsx(3,1): error TS2304: Cannot find name \'foo\'.',
].join('\n');
const tsFindings = parseTscOutput(tscOut);
assert(tsFindings.length === 2, 'tsc parser yields one finding per error');
assert(tsFindings.every((row) => row.status === 'high'), 'each tsc error is high');
assert(tsFindings[0].filePath === 'src/App.tsx' && tsFindings[0].line === 12, 'tsc finding has file/line');
assert(tsFindings[0].category === 'typescript', 'tsc category is typescript');
assert(tsFindings[1].id.includes('page.tsx'), 'tsc finding id is stable per file');

const tscEmpty = parseTscOutput('Found 0 errors.\n');
assert(tscEmpty.length === 0, 'clean tsc output yields no findings');

// --- eslint parser + stack-aware config ---
const eslintJson = JSON.stringify([
  {
    filePath: '/home/user/app/src/Button.tsx',
    messages: [
      { line: 8, severity: 2, message: 'Missing return type', ruleId: '@typescript-eslint/explicit-function-return-type' },
      { line: 20, severity: 1, message: 'img missing alt', ruleId: 'jsx-a11y/alt-text' },
    ],
  },
]);
const lintFindings = parseEslintJson(eslintJson);
assert(lintFindings.length === 2, 'eslint parser yields one finding per message');
assert(lintFindings[0].filePath?.endsWith('src/Button.tsx') && lintFindings[0].line === 8, 'eslint finding has file/line');
assert(lintFindings[0].category === 'lint', 'eslint category is lint');

const nextCfg = eslintConfigForStack('NEXTJS');
assert(nextCfg.includes('typescript-eslint') && nextCfg.includes('jsx-a11y') && nextCfg.includes('react-hooks'), 'NEXTJS eslint config includes ts + jsx-a11y + react-hooks');
const vueCfg = eslintConfigForStack('VUE');
assert(!vueCfg.includes('react-hooks') && !vueCfg.includes('jsx-a11y'), 'VUE skips react-hooks and jsx-a11y');
const htmlCfg = eslintConfigForStack('STATIC_HTML');
assert(htmlCfg === null || htmlCfg.length === 0, 'STATIC_HTML skips eslint config');

// --- depcheck + npm audit ---
const depcheck = parseDepcheckJson(JSON.stringify({ dependencies: ['lodash', 'moment'], devDependencies: [] }));
assert(depcheck.length === 2, 'depcheck unused deps become findings');
assert(depcheck.every((row) => row.category === 'dependencies'), 'depcheck category is dependencies');

const audit = parseNpmAuditJson(JSON.stringify({
  vulnerabilities: {
    lodash: { name: 'lodash', severity: 'critical', via: ['GHSA-1'] },
    axios: { name: 'axios', severity: 'high', via: ['GHSA-2'] },
    qs: { name: 'qs', severity: 'moderate', via: ['GHSA-3'] },
    debug: { name: 'debug', severity: 'low', via: ['GHSA-4'] },
  },
}));
assert(audit.find((row) => row.title.includes('lodash'))?.status === 'high', 'npm audit critical → high');
assert(audit.find((row) => row.title.includes('axios'))?.status === 'high', 'npm audit high → high');
assert(audit.find((row) => row.title.includes('qs'))?.status === 'medium', 'npm audit moderate → medium');
assert(!audit.some((row) => row.title.includes('debug')), 'npm audit low is omitted');

// --- knip / ts-prune ---
const knip = parseKnipJson(JSON.stringify({
  files: ['src/unused.ts'],
  exports: [{ file: 'src/helpers.ts', name: 'deadFn' }],
}));
assert(knip.some((row) => row.filePath === 'src/unused.ts'), 'knip unused file is a finding');
assert(knip.some((row) => row.title.toLowerCase().includes('deadfn') || row.detail.toLowerCase().includes('deadfn')), 'knip unused export is a finding');

const pruned = parseTsPruneOutput('src/old.ts:12 - leftover\n');
assert(pruned[0]?.filePath === 'src/old.ts' && pruned[0]?.line === 12, 'ts-prune finding has file/line');

// --- tool fail never aborts ---
const info = toolFailedFinding('typescript', new Error('tsc not found'));
assert(info.status === 'low' && info.fixable === false, 'tool fail is informational (low, not fixable)');
assert(info.category === 'tool', 'tool fail category is tool');
assert(info.detail.toLowerCase().includes('tsc not found') || info.detail.toLowerCase().includes('not found'), 'tool fail includes the real error');

// --- bundle ---
assert(measureShouldSkip('STATIC_HTML') === true, 'STATIC_HTML skips production build');
assert(measureShouldSkip('NEXTJS') === false, 'NEXTJS runs production build');
assert(getStack('NEXTJS').buildCommand?.includes('next'), 'NEXTJS buildCommand is next from registry');
assert(getStack('ASTRO').buildCommand?.includes('astro'), 'ASTRO buildCommand is astro from registry');
assert(getStack('REACT').buildCommand?.includes('vite'), 'REACT buildCommand is vite from registry');
assert(getStack('STATIC_HTML').buildCommand == null, 'STATIC_HTML has no buildCommand');

const failBuild = findingsFromBundle({
  stack: 'NEXTJS',
  ok: false,
  error: 'Module not found: ./missing',
  assets: [],
  routeCount: 1,
});
assert(failBuild[0]?.status === 'high' && failBuild[0]?.detail.includes('Module not found'), 'build FAIL is top high with real error');

const heavy = findingsFromBundle({
  stack: 'NEXTJS',
  ok: true,
  error: null,
  assets: [
    { path: '.next/static/chunks/main.js', kind: 'js', gzipKb: 220, rawKb: 600 },
    { path: '.next/static/chunks/page.js', kind: 'js', gzipKb: 120, rawKb: 300 },
    { path: '.next/static/media/hero.png', kind: 'image', gzipKb: 80, rawKb: 400 },
  ],
  routeCount: 3,
});
assert(heavy.some((row) => row.id === 'bundle:total-js' && row.status === 'medium'), 'total JS >300KB gz is medium');
assert(heavy.some((row) => row.status === 'medium' && row.detail.includes('150')), 'chunk >150KB gz is medium');
assert(heavy.some((row) => row.category === 'bundle' && row.title.toLowerCase().includes('image')), 'unoptimized image is medium');
assert(heavy.some((row) => row.id === 'bundle:code-split' && row.status === 'low'), 'missing code-split on multi-route is low');
assert(heavy.every((row) => row.detail.toLowerCase().includes('sandbox') || row.title.toLowerCase().includes('sandbox')), 'bundle findings labeled sandbox estimates');

const light = findingsFromBundle({
  stack: 'REACT',
  ok: true,
  error: null,
  assets: [{ path: 'dist/assets/index.js', kind: 'js', gzipKb: 40, rawKb: 90 }],
  routeCount: 1,
});
assert(!light.some((row) => row.status !== 'pass' && row.id === 'bundle:total-js'), 'small bundle does not fail total JS');

// --- a11y mapping + SEO dedup ---
assert(mapAxeImpact('critical') === 'high', 'axe critical → high');
assert(mapAxeImpact('serious') === 'medium', 'axe serious → medium');
assert(mapAxeImpact('moderate') === 'low', 'axe moderate → low');
assert(mapAxeImpact('minor') === 'low', 'axe minor → low');

const axeFindings = findingsFromAxe([
  { id: 'image-alt', impact: 'critical', help: 'Images must have alternate text', nodes: [{ target: ['img.hero'] }] },
  { id: 'button-name', impact: 'serious', help: 'Buttons must have discernible text', nodes: [{ target: ['button.submit'] }] },
], 'desktop');
assert(axeFindings[0].status === 'high' && axeFindings[0].selector === 'img.hero', 'axe finding includes selector');
assert(axeFindings[0].category === 'a11y', 'axe category is a11y');

const seoAlt: SeoFinding[] = [{
  id: 'page-basics:missing-alt',
  category: 'page-basics',
  status: 'medium',
  title: 'Images are missing alt text',
  detail: 'Add alt attributes',
  fixable: true,
  ignored: false,
}];
const deduped = dedupeA11yAgainstSeo(axeFindings, seoAlt);
assert(!deduped.some((row) => row.id.includes('image-alt')), 'missing-alt is not reported in both SEO and a11y');
assert(deduped.some((row) => row.id.includes('button-name')), 'unrelated a11y findings are kept');

// --- AI review skip + file cap ---
assert(shouldSkipAiReview(Array.from({ length: 20 }, (_, i) => finding({ id: `s${i}`, title: 'x', status: 'high' }))) === true, 'skip AI when static findings >= 20');
assert(shouldSkipAiReview(Array.from({ length: 19 }, (_, i) => finding({ id: `s${i}`, title: 'x', status: 'high' }))) === false, 'run AI when static findings < 20');

const files = [
  { path: 'src/tiny.ts', content: 'x'.repeat(100) },
  { path: 'src/huge.tsx', content: 'x'.repeat(8000) },
  { path: 'src/big.tsx', content: 'x'.repeat(4000) },
  { path: 'package.json', content: '{}'.repeat(50) },
];
const picked = selectFilesForAiReview(files, [finding({ id: 'typescript:src/huge.tsx:1', title: 'err', filePath: 'src/huge.tsx' })]);
assert(picked.every((file) => file.path !== 'src/huge.tsx'), 'AI review skips files static analysis already fully covered');
assert(picked[0]?.path === 'src/big.tsx', 'AI review prefers largest remaining source files');
assert(picked.length <= 10, 'AI review caps at 10 files');

const aiParsed = parseAiReviewJson(JSON.stringify({
  findings: [{ title: 'State grows unbounded', detail: 'items[] never reset', filePath: 'src/big.tsx', line: 40, status: 'medium' }],
}));
assert(aiParsed[0]?.category === 'ai-review' && aiParsed[0]?.filePath === 'src/big.tsx', 'AI review JSON becomes findings');

// --- findings helpers ---
const merged = mergeIgnoredFindings(
  [finding({ id: 'typescript:a', title: 'A' }), finding({ id: 'lint:b', title: 'B' })],
  [finding({ id: 'typescript:a', title: 'A', ignored: true })],
);
assert(merged.find((row) => row.id === 'typescript:a')?.ignored === true, 'ignored ids persist across rescan');
assert(merged.find((row) => row.id === 'lint:b')?.ignored === false, 'new findings are not ignored');

const sorted = sortFindings([
  finding({ id: 'a', status: 'low', title: 'low' }),
  finding({ id: 'b', status: 'pass', title: 'pass' }),
  finding({ id: 'c', status: 'high', title: 'high' }),
  finding({ id: 'd', status: 'medium', ignored: true, title: 'ignored' }),
  finding({ id: 'e', status: 'medium', title: 'medium' }),
]);
assert(sorted.map((row) => row.id).join(',') === 'c,e,a,b,d', 'sort failures high→medium→low, passing, ignored');

assert(asCodeFindings(null).length === 0, 'asCodeFindings handles null');
assert(asMetrics({ bundleKb: 12.5, tsErrors: 2, lintErrors: 1, a11yViolations: 3, unusedDeps: 4 }).tsErrors === 2, 'asMetrics reads counts');
assert(emptyMetrics().bundleKb === null, 'empty metrics start with null bundle');

// --- fix instructions include file/line ---
const one = buildFixInstruction(finding({
  id: 'typescript:src/App.tsx:12',
  title: 'Type error in App',
  detail: 'string not assignable to number',
  filePath: 'src/App.tsx',
  line: 12,
}));
assert(one.includes('src/App.tsx') && one.includes('12'), 'single fix names filePath and line');
assert(one.toLowerCase().includes('build') || one.toLowerCase().includes('fix'), 'single fix is a build instruction');

const all = buildFixAllInstruction([
  finding({ id: 'h', title: 'High issue', status: 'high', filePath: 'a.ts', line: 1 }),
  finding({ id: 'm', title: 'Medium issue', status: 'medium', filePath: 'b.ts' }),
  finding({ id: 'l', title: 'Low issue', status: 'low' }),
  finding({ id: 'x', title: 'Ignored', ignored: true }),
  finding({ id: 'y', title: 'Pass', status: 'pass' }),
]);
assert(all.indexOf('High issue') < all.indexOf('Medium issue') && all.indexOf('Medium issue') < all.indexOf('Low issue'), 'fix-all lists severity order high→medium→low');
assert(!all.includes('Ignored') && !all.includes('Pass'), 'fix-all skips ignored and passing');

// --- recurring issues group ---
const grouped = groupRecurringIssues([
  { findings: [finding({ id: '1', category: 'typescript', title: 'TS2322' }), finding({ id: '2', category: 'lint', title: 'hooks' })] },
  { findings: [finding({ id: '3', category: 'typescript', title: 'TS2304' }), finding({ id: '4', category: 'a11y', title: 'alt' })] },
  { findings: [finding({ id: '5', category: 'typescript', title: 'TS2322' })] },
]);
assert(grouped[0]?.category === 'typescript' && grouped[0]?.count === 3, 'top recurring category is typescript with count 3');
assert(grouped.some((row) => row.category === 'lint' && row.count === 1), 'other categories are counted');

console.log(`\n${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
