import type { JobResourceIds, SandboxAttemptRecord, SandboxSkippedRecord } from './types';

export function sandboxChoiceLines(resourceIds: JobResourceIds | null | undefined): string[] {
  const lines: string[] = [];
  for (const attempt of resourceIds?.sandboxAttempts ?? []) {
    lines.push(sandboxAttemptLine(attempt));
  }
  for (const skipped of resourceIds?.sandboxSkipped ?? []) {
    lines.push(sandboxSkippedLine(skipped));
  }
  return lines.filter(Boolean);
}

export function sandboxAttemptLine(attempt: SandboxAttemptRecord): string {
  const result = attempt.ok ? 'ok' : attempt.error || 'failed';
  const why = attempt.selectionReason ? ` ${attempt.selectionReason}` : '';
  return `${attempt.driver} — ${result}.${why}`.trim();
}

export function sandboxSkippedLine(row: SandboxSkippedRecord): string {
  return row.reason;
}
