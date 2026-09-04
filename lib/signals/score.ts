export const QUALITY_SIGNAL_KINDS = [
  'revert_rate',
  'followups_to_settle',
  'visual_edit_rate',
  'thumbs',
  'seo_score',
  'a11y_score',
  'build_success',
  'type_safety',
] as const;

export type QualitySignalKind = (typeof QUALITY_SIGNAL_KINDS)[number];

/**
 * Reviewable weights for getOverallQualityScore. Sum = 1.
 *
 * Typed `Record<QualitySignalKind, number>` rather than inferred from the
 * object literal: a kind added to `QUALITY_SIGNAL_KINDS` without a weight is
 * now a compile error. `type_safety` was collected, stored, charted with its
 * own definition — and silently absent from this map, so `composeOverallScore`
 * (which iterates the weights) never let a type-check failure move the number
 * an operator uses to judge a prompt change (F-760). The seven original weights
 * are rebalanced proportionally to make room rather than re-argued.
 */
export const QUALITY_SCORE_WEIGHTS: Record<QualitySignalKind, number> = {
  revert_rate: 0.28,
  followups_to_settle: 0.22,
  build_success: 0.12,
  type_safety: 0.1,
  seo_score: 0.1,
  a11y_score: 0.1,
  thumbs: 0.04,
  visual_edit_rate: 0.04,
};

export const MIN_KIND_SAMPLES = 10;
export const MIN_OVERALL_SAMPLES = 30;

export const SIGNAL_DEFINITIONS: Record<QualitySignalKind, { label: string; definition: string }> =
  {
    revert_rate: {
      label: 'Revert rate',
      definition:
        '1.0 if a generation settled without a checkpoint restore; 0 if the user restored away from that output. Implicit — users do not opt in.',
    },
    followups_to_settle: {
      label: 'Follow-ups to settle',
      definition:
        'After 30 minutes with no new generation, count generations since the last settle. 1 → 1.0, 2 → 0.8, 3 → 0.6, 4 → 0.4, 5+ → 0.2.',
    },
    visual_edit_rate: {
      label: 'Visual edit rate',
      definition:
        'Visual-edit-sourced messages per generation. 0 → 1.0, 1 → 0.8, 2 → 0.6, 3 → 0.4, 4+ → 0.2. Heavy correction means the generated design missed.',
    },
    thumbs: {
      label: 'Thumbs',
      definition: 'Explicit chat thumbs up = 1.0, thumbs down = 0.0.',
    },
    seo_score: {
      label: 'SEO score',
      definition: 'On each SEO audit: passing findings ÷ applicable (non-ignored) findings.',
    },
    a11y_score: {
      label: 'Accessibility score',
      definition:
        'From Code Audit axe-core violations, weighted by impact (critical > serious > moderate > minor).',
    },
    build_success: {
      label: 'Build success',
      definition: '1.0 if the Code Audit production build succeeded, 0.0 if it failed.',
    },
    type_safety: {
      label: 'Type safety',
      definition: '1.0 when tsc reports zero errors; scales down as 1 / (1 + error count).',
    },
  };

/**
 * Tool-refusal rates live in `QualitySignal` under their own kind namespace,
 * deliberately outside `QUALITY_SIGNAL_KINDS`.
 *
 * Two reasons, and both are load-bearing. `QUALITY_SIGNAL_KINDS` is typed
 * against `QUALITY_SCORE_WEIGHTS`, whose weights sum to 1 — a ninth member is a
 * compile error until the other eight are re-argued, which is exactly the guard
 * F-760 bought and not something a new observability reading should spend. And
 * `value` here is a refusal *rate*, not a score: higher is worse, where every
 * other kind in the table is a 0..1 goodness score. Folding these rows into the
 * weighted composite would move the number an operator judges a prompt change by
 * in the wrong direction.
 *
 * The tool name is in the kind rather than in `rawValue` so the per-tool mean
 * falls out of the same `groupBy(['kind', 'promptVersion'])` the dashboard
 * already runs, under the `@@index([kind, createdAt])` that already exists — no
 * new query and no JSON-path filter. Per tool is the only honest granularity:
 * `add_dependency` answering "that package is not available" is the write guard
 * doing its job, while `edit_file` refusing means the model could not find the
 * text it meant to change. A single blended rate averages a working guard into a
 * defect count.
 */
export const TOOL_REFUSAL_KIND_PREFIX = 'tool_refusal_rate:';

export function toolRefusalKind(tool: string) {
  return `${TOOL_REFUSAL_KIND_PREFIX}${tool}`;
}

export function toolFromRefusalKind(kind: string): string | null {
  if (!kind.startsWith(TOOL_REFUSAL_KIND_PREFIX)) return null;
  const tool = kind.slice(TOOL_REFUSAL_KIND_PREFIX.length);
  return tool.length > 0 ? tool : null;
}

/**
 * The runtime-error count as a 0..1 goodness score.
 *
 * Deliberately NOT a member of `QUALITY_SIGNAL_KINDS`: that union is typed against
 * `QUALITY_SCORE_WEIGHTS`, whose eight weights must sum to exactly 1, so admitting a ninth
 * kind means re-arguing all eight. This kind is written, read and charted on its own — the
 * same arrangement `TOOL_REFUSAL_KIND_PREFIX` above uses, and for the same reason.
 *
 * One error is most of the damage: a page that threw once is a page the visitor saw break.
 * The curve is steep at the start and flat after four, because the difference between "broken"
 * and "very broken" is not worth resolution the panel would then have to display.
 */
export const RUNTIME_ERRORS_KIND = 'runtime_errors';

export function runtimeErrorScore(errors: number) {
  if (errors <= 0) return 1;
  return clamp01(1 / (1 + errors));
}

export function clamp01(value: number) {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function followupsToSettleScore(generations: number) {
  if (generations <= 1) return 1;
  if (generations === 2) return 0.8;
  if (generations === 3) return 0.6;
  if (generations === 4) return 0.4;
  return 0.2;
}

export function visualEditRateScore(visualEditCount: number) {
  if (visualEditCount <= 0) return 1;
  if (visualEditCount === 1) return 0.8;
  if (visualEditCount === 2) return 0.6;
  if (visualEditCount === 3) return 0.4;
  return 0.2;
}

export function seoScoreFromFindings(findings: Array<{ status?: string; ignored?: boolean }>) {
  // `info` findings record that a check could not run (an unreachable preview,
  // F-755). Counting them would let one of our outages lower the project's
  // recorded quality; they are neither a pass nor a defect.
  const applicable = findings.filter((row) => !row.ignored && row.status !== 'info');
  if (applicable.length === 0) return 1;
  const passing = applicable.filter((row) => row.status === 'pass').length;
  return clamp01(passing / applicable.length);
}

const AXE_IMPACT_WEIGHT: Record<string, number> = {
  critical: 1,
  high: 1,
  serious: 0.6,
  medium: 0.6,
  moderate: 0.3,
  low: 0.3,
  minor: 0.1,
};

export function a11yScoreFromAxe(violations: Array<{ impact?: string | null }>) {
  if (violations.length === 0) return 1;
  const penalty = violations.reduce((sum, row) => {
    const key = (row.impact || 'moderate').toLowerCase();
    return sum + (AXE_IMPACT_WEIGHT[key] ?? 0.3);
  }, 0);
  return clamp01(1 / (1 + penalty));
}

export function buildSuccessScore(ok: boolean) {
  return ok ? 1 : 0;
}

export function typeSafetyScore(tsErrors: number) {
  if (tsErrors <= 0) return 1;
  return clamp01(1 / (1 + tsErrors));
}

/**
 * The sample floor, applied to a mean the caller already has. `/admin/quality`
 * aggregates in SQL, so it never holds the individual values (F-732) — this is
 * the one place the floor is decided either way.
 */
export function composeKindStat(
  mean: number | null,
  n: number,
): { mean: number; n: number } | null {
  if (mean == null || n < MIN_KIND_SAMPLES) return null;
  return { mean, n };
}

export function composeKindMetric(values: number[]): { mean: number; n: number } | null {
  if (values.length === 0) return null;
  return composeKindStat(
    values.reduce((sum, value) => sum + value, 0) / values.length,
    values.length,
  );
}

export function composeOverallScore(
  stats: Record<string, { mean: number | null; n: number }>,
): number | null {
  const totalN = Object.values(stats).reduce((sum, row) => sum + row.n, 0);
  if (totalN < MIN_OVERALL_SAMPLES) return null;

  let acc = 0;
  let weightSum = 0;
  for (const [kind, weight] of Object.entries(QUALITY_SCORE_WEIGHTS)) {
    const row = stats[kind];
    if (!row || row.mean == null) continue;
    acc += row.mean * weight;
    weightSum += weight;
  }
  if (weightSum === 0) return null;
  return acc / weightSum;
}

export function looksLikeVisualEdit(text?: string | null) {
  if (!text) return false;
  return /approximate selector:/i.test(text) || /For the \S+ element containing/i.test(text);
}
