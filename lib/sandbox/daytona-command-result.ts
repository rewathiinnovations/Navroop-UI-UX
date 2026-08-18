import type { CommandResult } from './types';

/**
 * `@daytona/sdk` 0.205.0 types `ExecuteResponse.exitCode` as a required
 * number and does not expose `stderr`. At runtime the field is still
 * sometimes missing — treat that the same way as a missing E2B return
 * code: failure, not success.
 */
export type DaytonaExecuteLike = {
  result?: string;
  exitCode?: number;
  artifacts?: { stdout?: string };
};

export function commandResultFromDaytonaExecute(result: DaytonaExecuteLike): CommandResult {
  const output = result.result || result.artifacts?.stdout || '';
  const exitCode =
    typeof result.exitCode === 'number' && Number.isFinite(result.exitCode) ? result.exitCode : 1;
  return {
    stdout: output,
    stderr: exitCode === 0 ? '' : output,
    exitCode,
    success: exitCode === 0,
  };
}
