/**
 * What phase a project should resume to after a job dies.
 *
 * COMPLETE means there is a finished site. A first plan that never generated
 * must not look complete. A follow-up that is discarded on a live site stays
 * COMPLETE — that is lastCode / checkpoints, not "no plan row".
 *
 * `filesWritten` is stream/apply progress on the job row. It is not site
 * evidence: a BUILD can close 11 files in the SSE stream and still have
 * lastCode null and zero checkpoints when the sandbox never went READY.
 */

export function resumablePhaseFromEvidence(input: {
  filesWritten?: number;
  hasLastCode?: boolean;
  checkpointCount?: number;
  hasActivePlan?: boolean;
}): 'PLANNING' | 'COMPLETE' {
  void input.filesWritten;
  const finishedSite = Boolean(input.hasLastCode) || (input.checkpointCount ?? 0) > 0;
  if (finishedSite) return 'COMPLETE';
  return 'PLANNING';
}
