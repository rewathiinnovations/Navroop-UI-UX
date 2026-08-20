/**
 * Multi-pass URL import: modes, segmentation cap, rehost skip, fallback, cache prefix.
 * Run: node --experimental-strip-types tests/import-pipeline.test.ts
 */
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

const { looksLikeUrl } = await import('../lib/projects/prompt.ts');
const { DEFAULT_IMPORT_MODE, IMPORT_MODES, resolveImportMode, isImportMode, parseDraftImportMode } =
  await import('../lib/import/mode.ts');
const { BLOCKED_ACCESS_MESSAGE, isBlockedAccessError } = await import('../lib/import/errors.ts');
const { MAX_REHOST_BYTES, shouldSkipRehost } = await import('../lib/import/rehost-assets.ts');
const { mergeSectionsToCap, MAX_IMPORT_SECTIONS } = await import('../lib/import/segment.ts');
const { IMPORT_PROGRESS, buildingSectionProgress } = await import('../lib/import/progress.ts');
const { clusterColors, formatDesignTokens } = await import('../lib/import/tokens.ts');
const { buildSectionVolatilePrompt } = await import('../lib/import/prompts.ts');
const { buildCachedMessages } = await import('../lib/generation/prompt-cache.ts');
const { decideUrlImportFlow, runUrlImportPipeline } = await import('../lib/import/pipeline.ts');

assert(DEFAULT_IMPORT_MODE === 'reimagine', 'default import mode is reimagine');
assert(
  IMPORT_MODES.includes('replicate') && IMPORT_MODES.includes('reimagine'),
  'both modes exist',
);
assert(resolveImportMode(undefined) === 'reimagine', 'undefined mode resolves to reimagine');
assert(resolveImportMode('replicate') === 'replicate', 'replicate is accepted');
assert(resolveImportMode('nope') === 'reimagine', 'invalid mode falls back to reimagine');
assert(isImportMode('reimagine') && !isImportMode('clone'), 'isImportMode guards values');
assert(
  parseDraftImportMode({ importMode: 'replicate' }) === 'replicate',
  'draft JSON keeps replicate',
);
assert(parseDraftImportMode({ importMode: 'nope' }) === 'reimagine', 'draft JSON falls back');

assert(looksLikeUrl('https://example.com/pricing'), 'https URL is detected');
assert(looksLikeUrl('example.com'), 'bare domain is detected');
assert(!looksLikeUrl('build a bakery site'), 'plain prompt is not a URL');

const urlFlow = decideUrlImportFlow({
  initialPrompt: 'https://stripe.com',
  skipPlanning: false,
  importMode: 'replicate',
});
assert(urlFlow.isUrlImport === true, 'URL input is an import');
assert(urlFlow.skipPlanning === true, 'URL import skips planning so the user is not stuck');
assert(urlFlow.importMode === 'replicate', 'URL flow keeps requested mode');
assert(urlFlow.sourceUrl === 'https://stripe.com', 'URL flow normalizes source URL');

const bareFlow = decideUrlImportFlow({
  initialPrompt: 'stripe.com/pricing',
  skipPlanning: false,
});
assert(bareFlow.sourceUrl === 'https://stripe.com/pricing', 'bare domain gets https');

const promptFlow = decideUrlImportFlow({
  initialPrompt: 'A cafe landing page',
  skipPlanning: false,
});
assert(promptFlow.isUrlImport === false, 'plain prompt is not an import');
assert(promptFlow.skipPlanning === false, 'plain prompt keeps planning');
assert(promptFlow.importMode === 'reimagine', 'plain prompt still defaults reimagine');

assert(IMPORT_PROGRESS.capturing === 'Capturing page…', 'capture progress copy');
assert(IMPORT_PROGRESS.extracting === 'Extracting design…', 'extract progress copy');
assert(buildingSectionProgress(3, 7) === 'Building section 3 of 7…', 'section progress copy');

assert(
  BLOCKED_ACCESS_MESSAGE ===
    "This site blocked automated access — try pasting the page's content directly instead",
  'blocked-access message is exact',
);
assert(
  isBlockedAccessError(new Error('net::ERR_HTTP_RESPONSE_CODE_FAILURE 403')),
  '403 is blocked',
);
assert(isBlockedAccessError(new Error('Timeout 30000ms exceeded')), 'timeout is blocked');
assert(isBlockedAccessError(new Error('Please log in to continue')), 'login wall is blocked');
assert(!isBlockedAccessError(new Error('sharp failed')), 'unrelated errors are not blocked');

assert(MAX_REHOST_BYTES === 10 * 1024 * 1024, 'rehost cap is 10MB');
assert(shouldSkipRehost({ contentLength: 11 * 1024 * 1024 }) === true, 'skips over 10MB by header');
assert(shouldSkipRehost({ byteLength: 10 * 1024 * 1024 + 1 }) === true, 'skips over 10MB by body');
assert(shouldSkipRehost({ contentLength: 1024 }) === false, 'keeps small images');

const many = Array.from({ length: 15 }, (_, i) => ({
  id: `s${i}`,
  label: `Section ${i}`,
  purpose: 'block',
  contentSummary: `copy ${i}`,
  approximateYRange: [i * 200, i * 200 + (i === 4 ? 40 : 180)] as [number, number],
}));
const capped = mergeSectionsToCap(many, MAX_IMPORT_SECTIONS);
assert(capped.length === 12, 'merges down to 12 sections');
assert(
  capped.every((section) => section.id && section.label),
  'merged sections keep id/label',
);
assert(
  capped.some(
    (section) => section.label.includes('Section 4') || section.contentSummary.includes('copy 4'),
  ),
  'smallest adjacent section is merged rather than dropped',
);
assert(mergeSectionsToCap(many.slice(0, 5)).length === 5, 'does not merge when already under cap');

const clustered = clusterColors([
  'rgb(255, 0, 0)',
  'rgb(254, 1, 1)',
  'rgb(0, 0, 255)',
  '#0000FE',
  'rgb(10, 10, 10)',
  '#111111',
  '#222222',
  '#333333',
  '#444444',
  '#555555',
  '#666666',
  '#777777',
  '#888888',
]);
assert(clustered.length <= 8, 'clusters colors to about 8');
assert(clustered.length >= 3, 'keeps distinct color families');
assert(
  clustered.every((hex) => /^#[0-9a-f]{6}$/i.test(hex)),
  'colors are hex',
);

const tokenBlock = formatDesignTokens({
  fontFamily: 'Inter, system-ui, sans-serif',
  fontSizes: ['16px', '24px', '32px'],
  colors: ['#111111', '#2563EB'],
  radii: ['8px', '999px'],
  spacingRhythm: ['16px', '24px'],
});
assert(tokenBlock.includes('Inter'), 'token block includes font');
assert(tokenBlock.includes('#2563EB'), 'token block includes color');

const prefixA = buildCachedMessages({
  stablePrefix: 'base-rules + stack + memory',
  volatileUser: 'section-1',
});
const prefixB = buildCachedMessages({
  stablePrefix: 'base-rules + stack + memory',
  volatileUser: 'section-2',
});
assert(
  prefixA[0]?.content === prefixB[0]?.content,
  'stable prefix is byte-identical across sections',
);
assert(
  prefixA[0]?.content === 'base-rules + stack + memory',
  'system slot is the cacheable prefix',
);

const replicateVolatile = buildSectionVolatilePrompt({
  mode: 'replicate',
  tokens: tokenBlock,
  section: {
    id: 'hero',
    label: 'Hero',
    purpose: 'intro',
    contentSummary: 'Headline and CTA',
    approximateYRange: [0, 400],
  },
  firecrawlText: 'Welcome to Example',
  assets: [{ url: '/uploads/hero.webp', altText: 'Hero photo', width: 1600, height: 900 }],
  designDirection: 'minimal',
});
assert(replicateVolatile.includes('/uploads/hero.webp'), 'section prompt lists rehosted URL');
assert(replicateVolatile.includes('rehosted'), 'section prompt requires rehosted URLs only');
assert(
  replicateVolatile.includes('faithful') || replicateVolatile.includes('match source'),
  'replicate is faithful',
);
assert(!replicateVolatile.includes('look deliberately different'), 'replicate does not reimagine');

const reimagineVolatile = buildSectionVolatilePrompt({
  mode: 'reimagine',
  tokens: tokenBlock,
  section: {
    id: 'hero',
    label: 'Hero',
    purpose: 'intro',
    contentSummary: 'Headline and CTA',
    approximateYRange: [0, 400],
  },
  firecrawlText: 'Welcome to Example',
  assets: [],
  designDirection: 'bold',
});
assert(
  reimagineVolatile.includes('deliberately different') ||
    reimagineVolatile.includes('design direction'),
  'reimagine applies project design direction',
);

const fallback = await runUrlImportPipeline({
  projectId: 'proj_test',
  sourceUrl: 'https://example.com',
  mode: 'reimagine',
  stack: 'NEXTJS',
  designDirection: 'minimal',
  userId: 'user_test',
  capture: async () => ({
    sourceUrl: 'https://example.com',
    desktopPng: Buffer.from('desk'),
    tokens: {
      fontFamily: 'Inter',
      fontSizes: ['16px'],
      colors: ['#111111'],
      radii: ['8px'],
      spacingRhythm: ['16px'],
    },
    images: [],
    firecrawlText: 'Example homepage',
    capturedAt: new Date('2026-08-16T00:00:00.000Z'),
  }),
  rehost: async () => ({ assets: [], warnings: ['skipped huge.png'] }),
  segment: async () => {
    throw new Error('segment exploded');
  },
  generateSections: async () => {
    throw new Error('should not run when segment fails');
  },
  generateFallback: async () => ({
    filesXml: '<file path="app/page.tsx">fallback</file>',
    inputTokens: 42,
  }),
  persistSource: async () => undefined,
  onProgress: () => undefined,
});
assert(fallback.usedFallback === true, 'segmentation failure falls back to single-pass');
assert(fallback.filesXml.includes('fallback'), 'fallback returns captured-data generation');
assert(fallback.warnings.includes('skipped huge.png'), 'rehost warnings survive fallback');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
