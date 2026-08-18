import type { JobResourceIds, SandboxAttemptRecord, SandboxSkippedRecord } from './types';

export function sandboxChoiceLines(
  resourceIds: JobResourceIds | null | undefined,
  opts?: SandboxLineOpts,
): string[] {
  const lines: string[] = [];
  for (const attempt of resourceIds?.sandboxAttempts ?? []) {
    lines.push(sandboxAttemptLine(attempt, opts));
  }
  for (const skipped of resourceIds?.sandboxSkipped ?? []) {
    lines.push(sandboxSkippedLine(skipped));
  }
  return lines.filter(Boolean);
}

export type SandboxLineOpts = {
  /**
   * The failure message already rendered next to these lines. A failed
   * attempt whose error is that exact text prints "the error above" instead
   * of the whole paragraph a second time — /admin/jobs shows the job's
   * `errorMessage` first, and the losing attempt usually *is* that error.
   */
  omitError?: string | null;
};

export function sandboxAttemptLine(attempt: SandboxAttemptRecord, opts?: SandboxLineOpts): string {
  const duplicate = !attempt.ok && attempt.error && attempt.error === opts?.omitError;
  const result = attempt.ok
    ? 'ok'
    : duplicate
      ? 'failed with the error above'
      : attempt.error || 'failed';
  const why = attempt.selectionReason ? ` ${attempt.selectionReason}` : '';
  return `${attempt.driver} — ${result}.${why}`.trim();
}

export function sandboxSkippedLine(row: SandboxSkippedRecord): string {
  return row.reason;
}
