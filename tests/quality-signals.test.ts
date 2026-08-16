/**
 * Quality measurement layer — scoring, aggregation, collectors.
 * Run: npx tsx tests/quality-signals.test.ts
 */
import {
  QUALITY_SIGNAL_KINDS,
  a11yScoreFromAxe,
  buildSuccessScore,
  composeKindMetric,
  composeOverallScore,
  followupsToSettleScore,
  seoScoreFromFindings,
  typeSafetyScore,
  visualEditRateScore,
} from '../lib/signals/score';
import { QUALITY_SCORE_WEIGHTS } from '../lib/signals/metrics';
import { withSignalGuard } from '../lib/signals/collect';
import { assembleVersionedPrefix, hashPromptPrefix } from '../lib/prompts/version';

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

assert(followupsToSettleScore(1) === 1, '1 generation → 1.0');
assert(followupsToSettleScore(2) === 0.8, '2 generations → 0.8');
assert(followupsToSettleScore(3) === 0.6, '3 generations → 0.6');
assert(followupsToSettleScore(4) === 0.4, '4 generations → 0.4');
assert(followupsToSettleScore(5) === 0.2, '5 generations → 0.2');
assert(followupsToSettleScore(12) === 0.2, '5+ generations → 0.2');

assert(visualEditRateScore(0) === 1, '0 visual edits → 1.0');
assert(visualEditRateScore(1) === 0.8, '1 visual edit → 0.8');
assert(visualEditRateScore(4) === 0.2, '4+ visual edits → 0.2');

assert(
  seoScoreFromFindings([
    { status: 'pass', ignored: false },
    { status: 'pass', ignored: false },
    { status: 'high', ignored: false },
    { status: 'medium', ignored: true },
  ]) === 2 / 3,
  'seo_score = passing / applicable (ignored excluded)',
);
assert(seoScoreFromFindings([]) === 1, 'no applicable SEO findings → 1.0');

assert(a11yScoreFromAxe([]) === 1, 'no axe violations → 1.0');
assert(a11yScoreFromAxe([{ impact: 'critical' }]) < 1, 'axe violations lower a11y_score');
assert(a11yScoreFromAxe([{ impact: 'minor' }]) > a11yScoreFromAxe([{ impact: 'critical' }]), 'critical weighs more than minor');

assert(buildSuccessScore(true) === 1, 'build ok → 1.0');
assert(buildSuccessScore(false) === 0, 'build failed → 0.0');

assert(typeSafetyScore(0) === 1, 'zero tsc errors → 1.0');
assert(typeSafetyScore(1) < 1, 'tsc errors scale type_safety down');
assert(typeSafetyScore(4) < typeSafetyScore(1), 'more tsc errors → lower score');

const thin = composeKindMetric([0.5, 0.6, 0.7, 0.8, 0.9]);
assert(thin === null, 'kind metric is null when n < 10');

const enough = composeKindMetric(Array.from({ length: 10 }, () => 0.5));
assert(enough !== null && enough.mean === 0.5 && enough.n === 10, 'kind metric returns mean when n >= 10');

const overallThin = composeOverallScore({
  revert_rate: { mean: 1, n: 10 },
  followups_to_settle: { mean: 1, n: 10 },
  build_success: { mean: 1, n: 5 },
});
assert(overallThin === null, 'overall score is null when total samples < 30');

const overall = composeOverallScore({
  revert_rate: { mean: 1, n: 10 },
  followups_to_settle: { mean: 0.8, n: 10 },
  build_success: { mean: 1, n: 10 },
  seo_score: { mean: 0.5, n: 10 },
  a11y_score: { mean: 1, n: 10 },
  thumbs: { mean: 1, n: 10 },
  visual_edit_rate: { mean: 1, n: 10 },
});
const expected =
  1 * 0.3 + 0.8 * 0.25 + 1 * 0.15 + 0.5 * 0.1 + 1 * 0.1 + 1 * 0.05 + 1 * 0.05;
assert(overall !== null && Math.abs(overall - expected) < 1e-9, 'overall score uses exported weights');

assert(QUALITY_SCORE_WEIGHTS.revert_rate === 0.3, 'revert weight 30%');
assert(QUALITY_SCORE_WEIGHTS.followups_to_settle === 0.25, 'followups weight 25%');
assert(QUALITY_SCORE_WEIGHTS.build_success === 0.15, 'build weight 15%');
assert(QUALITY_SCORE_WEIGHTS.seo_score === 0.1, 'seo weight 10%');
assert(QUALITY_SCORE_WEIGHTS.a11y_score === 0.1, 'a11y weight 10%');
assert(QUALITY_SCORE_WEIGHTS.thumbs === 0.05, 'thumbs weight 5%');
assert(QUALITY_SCORE_WEIGHTS.visual_edit_rate === 0.05, 'visual_edit weight 5%');

assert(!QUALITY_SIGNAL_KINDS.includes('ai_grade' as never), 'no self-grading AI quality kind');
assert(
  QUALITY_SIGNAL_KINDS.every((kind) => kind !== 'ai_quality' && kind !== 'llm_judge'),
  'explicitly no AI-rates-itself signal',
);

const swallowed = await withSignalGuard('test', async () => {
  throw new Error('collector boom');
});
assert(swallowed === null, 'collector swallows errors');

const prefixA = assembleVersionedPrefix();
const prefixB = assembleVersionedPrefix();
assert(prefixA === prefixB, 'assembled prefix is stable');
assert(hashPromptPrefix(prefixA) === hashPromptPrefix(prefixB), 'prefix hash is stable');
assert(hashPromptPrefix(prefixA).length === 64, 'hash is sha256 hex');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
