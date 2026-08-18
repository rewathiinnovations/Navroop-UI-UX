import { describe, expect, it, vi } from 'vitest';
import { E2BProvider } from '@/lib/sandbox/providers/e2b-provider';
import { commandResultFromE2BExecution } from '@/lib/sandbox/e2b-command-result';

/**
 * `@e2b/code-interpreter` Execution has `logs` and an optional Python
 * `error` — not a subprocess exit code. `runCommand` must read the printed
 * return code. No live VM.
 */

type E2BModule = typeof import('@e2b/code-interpreter');
type Execution = Awaited<ReturnType<InstanceType<E2BModule['Sandbox']>['runCode']>>;

function fakeE2B(
  runCode: (code: string) => Promise<{
    logs: { stdout: string[]; stderr: string[] };
    error?: { name: string; value: string };
  }>,
) {
  const provider = new E2BProvider({ apiKey: 'e2b-not-real' });
  const kill = vi.fn(async () => undefined);
  (provider as unknown as { sandbox: { runCode: typeof runCode; kill: typeof kill } }).sandbox = {
    runCode,
    kill,
  };
  return { provider, kill };
}

describe('E2B Execution has no subprocess exitCode', () => {
  it('the installed SDK result is logs + optional Python error only', () => {
    type Keys = keyof Execution;
    const hasExitCode = false satisfies 'exitCode' extends Keys ? true : false;
    const hasReturnCode = false satisfies 'returncode' extends Keys ? true : false;
    expect(hasExitCode).toBe(false);
    expect(hasReturnCode).toBe(false);

    const execution: Pick<Execution, 'logs' | 'error'> = {
      logs: { stdout: ['Return code: 1'], stderr: [] },
      error: undefined,
    };
    expect(execution.error).toBeUndefined();
    expect(execution.logs.stdout.join('\n')).toContain('Return code: 1');
  });
});

describe('commandResultFromE2BExecution', () => {
  it('uses the last printed Return code, not result.error', () => {
    const result = commandResultFromE2BExecution({
      logs: { stdout: ['STDOUT:', '', 'Return code: 1'], stderr: [] },
    });
    // The return code is still read from the printed text — that is this test's subject and
    // it is unchanged. What the caller receives as `stdout` no longer carries the envelope:
    // `STDOUT:` and `Return code: 1` are the wire format, and a caller that splits stdout
    // into lines (the static preview's file listing) took them for filenames.
    // `e2b-command-envelope.test.ts` owns that behaviour.
    expect(result).toEqual({
      stdout: '',
      stderr: '',
      exitCode: 1,
      success: false,
    });
  });

  it('reports 0 when the printed Return code is 0 and Python did not raise', () => {
    const result = commandResultFromE2BExecution({
      logs: { stdout: ['ok', 'Return code: 0'], stderr: [] },
    });
    expect(result.exitCode).toBe(0);
    expect(result.success).toBe(true);
  });

  it('does not treat a missing Python error as exit 0 when no return code was printed', () => {
    const result = commandResultFromE2BExecution({
      logs: { stdout: ['ok'], stderr: [] },
    });
    expect(result.exitCode).toBe(1);
    expect(result.success).toBe(false);
  });

  it('treats a Python exception as failure when no return code was printed', () => {
    const result = commandResultFromE2BExecution({
      logs: { stdout: [], stderr: ['boom'] },
      error: { name: 'RuntimeError', value: 'subprocess exploded' },
    });
    expect(result.exitCode).toBe(1);
    expect(result.success).toBe(false);
  });
});

describe('E2BProvider.runCommand reports the subprocess return code', () => {
  it('is exit 1 when npm install fails without a Python exception', async () => {
    const { provider } = fakeE2B(async () => ({
      logs: {
        stdout: ['STDOUT:', 'npm ERR! ERESOLVE', 'Return code: 1'],
        stderr: [],
      },
    }));

    const result = await provider.runCommand('npm install left-pad');
    expect(result.exitCode).toBe(1);
    expect(result.success).toBe(false);
  });

  it('is exit 0 only when the printed Return code is 0', async () => {
    const { provider } = fakeE2B(async () => ({
      logs: { stdout: ['STDOUT:', 'added 1', 'Return code: 0'], stderr: [] },
    }));

    const result = await provider.runCommand('npm install zod');
    expect(result.exitCode).toBe(0);
    expect(result.success).toBe(true);
  });
});

describe('E2BProvider.installPackages decides on the same signal', () => {
  it('is a failed CommandResult when the printed Return code is non-zero', async () => {
    const { provider } = fakeE2B(async (code) => {
      if (code.includes('npm') && code.includes('install')) {
        return {
          logs: { stdout: ['STDERR:', 'npm ERR! 404', 'Return code: 1'], stderr: [] },
        };
      }
      return { logs: { stdout: ['ok'], stderr: [] } };
    });

    const result = await provider.installPackages(['not-a-real-pkg']);
    expect(result.exitCode).toBe(1);
    expect(result.success).toBe(false);
  });
});
