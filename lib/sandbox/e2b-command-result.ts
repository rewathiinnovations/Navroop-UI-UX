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

/**
 * Splits the printed envelope back into the command's own streams.
 *
 * `STDOUT:` / `STDERR:` / `Return code: N` are a wire format between the Python we send and
 * this mapper — they are not part of what the command said. Returning them to callers made
 * every consumer responsible for knowing that, and one of them did not: the static preview
 * lists files by splitting `find` output a line at a time, so `STDOUT:`, `STDERR:` and
 * `Return code: 0` all became filenames. The build then tried to write
 * `previews/<project>/<build>/STDOUT:`, which is not a legal filename on Windows, and the
 * capture died with ENOENT on a project whose generation had actually succeeded.
 *
 * Anchored on the first `STDOUT:`, so command output that merely contains the word is safe.
 * Output with no envelope at all is passed through unchanged.
 */
export function unwrapE2BPrintedStreams(raw: string): { stdout: string; stderr: string } {
  const marker = raw.indexOf('STDOUT:');
  if (marker === -1) return { stdout: stripPrintedReturnCode(raw), stderr: '' };

  const body = raw.slice(marker + 'STDOUT:'.length);
  const stderrAt = body.indexOf('\nSTDERR:');
  const out = stderrAt === -1 ? body : body.slice(0, stderrAt);
  const err = stderrAt === -1 ? '' : body.slice(stderrAt + '\nSTDERR:'.length);
  return { stdout: stripPrintedReturnCode(out), stderr: stripPrintedReturnCode(err) };
}

function stripPrintedReturnCode(text: string) {
  return text.replace(/\s*Return code:\s*-?\d+\s*$/, '').replace(/^\n+/, '').trimEnd();
}

export function commandResultFromE2BExecution(result: E2BExecutionLike): CommandResult {
  const rawStdout = (result.logs?.stdout ?? []).join('\n');
  const rawStderr = (result.logs?.stderr ?? []).join('\n');
  // The return code is read from the raw text, because that is where it was printed.
  const printed = parseE2BPrintedReturnCode(rawStdout, rawStderr);
  const unwrapped = unwrapE2BPrintedStreams(rawStdout);
  // A cell can write to both: the envelope's STDERR section and the notebook's own stream.
  const stderr = [unwrapped.stderr, rawStderr].filter(Boolean).join('\n');
  if (printed !== null) {
    return { stdout: unwrapped.stdout, stderr, exitCode: printed, success: printed === 0 };
  }
  return { stdout: unwrapped.stdout, stderr, exitCode: 1, success: false };
}
