import { describe, expect, it } from 'vitest';
import {
  commandResultFromE2BExecution,
  unwrapE2BPrintedStreams,
} from '@/lib/sandbox/e2b-command-result';

/**
 * `runCommand` on E2B goes through a Python cell that prints `STDOUT:`, the output, an
 * optional `STDERR:` section, and `Return code: N`. That envelope is a wire format between
 * the Python and the mapper — it is not what the command said.
 *
 * Returning it verbatim made every caller responsible for knowing about it, and the static
 * preview did not: `sandboxFromProvider.listFiles` runs `find -type f` and splits stdout a
 * line at a time, so `STDOUT:` became a filename. The capture then tried to write
 * `previews/<project>/<build>/STDOUT:` — not a legal filename on Windows — and a generation
 * that had genuinely succeeded ended with `preview_after_generation_failed` and a null
 * previewUrl. Observed live on 2026-08-18.
 */

/** What the provider's Python prints, as the SDK reports it back. */
function execution(stdoutLines: string[], stderrLines: string[] = []) {
  return { logs: { stdout: stdoutLines, stderr: stderrLines } };
}

describe('the printed envelope is not part of the command output', () => {
  it('gives back only what the command wrote', () => {
    const { stdout, stderr } = unwrapE2BPrintedStreams(
      'STDOUT:\nout/index.html\nout/about.html\n\nReturn code: 0',
    );
    expect(stdout).toBe('out/index.html\nout/about.html');
    expect(stderr).toBe('');
  });

  it('separates the stderr section from the stdout one', () => {
    const { stdout, stderr } = unwrapE2BPrintedStreams(
      'STDOUT:\nbuilt\n\nSTDERR:\nwarning: peer dep\n\nReturn code: 1',
    );
    expect(stdout).toBe('built');
    expect(stderr).toBe('warning: peer dep');
  });

  it('passes through output that carries no envelope', () => {
    // `runCode` callers that do not print the markers must be untouched.
    expect(unwrapE2BPrintedStreams('plain output').stdout).toBe('plain output');
  });

  it('anchors on the first marker, so output containing the word survives', () => {
    const { stdout } = unwrapE2BPrintedStreams(
      'STDOUT:\necho STDOUT: is not a marker here\n\nReturn code: 0',
    );
    expect(stdout).toBe('echo STDOUT: is not a marker here');
  });
});

describe('a file listing built from command output has no envelope lines in it', () => {
  /** Exactly what `sandboxFromProvider.listFiles` does with the result. */
  function asFileList(stdout: string) {
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  it('lists the files and nothing else', () => {
    const result = commandResultFromE2BExecution(
      execution(['STDOUT:', 'out/index.html\nout/assets/app.css\n', '', 'Return code: 0']),
    );
    const listed = asFileList(result.stdout);

    expect(listed).toEqual(['out/index.html', 'out/assets/app.css']);
    // The three that became filenames, and the one that reached the filesystem.
    expect(listed).not.toContain('STDOUT:');
    expect(listed).not.toContain('STDERR:');
    expect(listed.some((line) => line.startsWith('Return code:'))).toBe(false);
    // `:` is illegal in a Windows filename, which is how this surfaced as ENOENT.
    expect(listed.some((line) => line.includes(':'))).toBe(false);
  });

  it('still reports the real exit code, which is only in the raw text', () => {
    const failed = commandResultFromE2BExecution(
      execution(['STDOUT:', '', '', 'STDERR:', 'build failed', '', 'Return code: 2']),
    );
    expect(failed.exitCode).toBe(2);
    expect(failed.success).toBe(false);
    expect(failed.stderr).toContain('build failed');

    const ok = commandResultFromE2BExecution(execution(['STDOUT:', 'fine', '', 'Return code: 0']));
    expect(ok.exitCode).toBe(0);
    expect(ok.success).toBe(true);
  });

  it('keeps treating a missing return code as failure', () => {
    // Unchanged: the cell died before printing one, so nothing proves the command ran.
    const result = commandResultFromE2BExecution(execution(['STDOUT:', 'partial']));
    expect(result.exitCode).toBe(1);
    expect(result.success).toBe(false);
  });
});
