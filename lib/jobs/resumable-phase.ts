/**
 * What phase a project should resume to after a job dies.
 *
 * COMPLETE means there is a finished site. A first plan that never generated
 * must not look complete. A follow-up that is discarded on a live site stays
 * COMPLETE — that is lastCode / checkpoints / files written, not "no plan row".
 */

export function resumablePhaseFromEvidence(input: {
  filesWritten?: number;
  hasLastCode?: boolean;
  checkpointCount?: number;
  hasActivePlan?: boolean;
}): 'PLANNING' | 'COMPLETE' {
  const finishedSite =
    (input.filesWritten ?? 0) > 0 || Boolean(input.hasLastCode) || (input.checkpointCount ?? 0) > 0;
  if (finishedSite) return 'COMPLETE';
  return 'PLANNING';
}
