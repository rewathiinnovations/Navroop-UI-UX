import type { CommandResult } from './types';

/**
 * `@e2b/code-interpreter` Execution has no subprocess `exitCode`.
 * `error` is a Python exception on the `runCode` cell, not the command
 * return code. The Python we send prints `Return code: N` — that is the
 * real signal. If it is missing, assume failure rather than success.
 */
export type E2BExecutionLike = {
  error?: { name?: string; value?: string } | null;
  logs?: { stdout?: string[]; stderr?: string[] };
};

const RETURN_CODE = /Return code:\s*(-?\d+)/g;

export function parseE2BPrintedReturnCode(...chunks: string[]): number | null {
  let last: number | null = null;
  for (const chunk of chunks) {
    for (const match of chunk.matchAll(RETURN_CODE)) {
      last = Number(match[1]);
    }
  }
  return last !== null && Number.isFinite(last) ? last : null;
}

export function commandResultFromE2BExecution(result: E2BExecutionLike): CommandResult {
  const stdout = (result.logs?.stdout ?? []).join('\n');
  const stderr = (result.logs?.stderr ?? []).join('\n');
  const printed = parseE2BPrintedReturnCode(stdout, stderr);
  if (printed !== null) {
    return { stdout, stderr, exitCode: printed, success: printed === 0 };
  }
  return { stdout, stderr, exitCode: 1, success: false };
}
