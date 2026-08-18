/**
 * Which existing plan path a failed-PLAN retry should take.
 *
 * COMPLETE (a live site, follow-up plan failed and rolled back) reuses
 * requestFollowUpPlan. PLANNING (the first plan never landed) reuses
 * generatePlan with the recorded prompt. BUILDING is another job — do not
 * start a second plan on top of a build.
 */
export function planRetryKind(phase: string | null | undefined): 'initial' | 'followup' | 'blocked' {
  if (phase === 'BUILDING') return 'blocked';
  if (phase === 'COMPLETE') return 'followup';
  return 'initial';
}
