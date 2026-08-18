import { describe, expect, it } from 'vitest';
import { DaytonaProvider } from '@/lib/sandbox/providers/daytona-provider';
import { commandResultFromDaytonaExecute } from '@/lib/sandbox/daytona-command-result';

/**
 * `@daytona/sdk` 0.205.0 types `ExecuteResponse.exitCode` as a required
 * number, but the field is still missing at runtime on some responses.
 * `runCommandLive` must not treat that absence as exit 0. No live VM.
 */

type DaytonaModule = typeof import('@daytona/sdk');
type ExecuteResponse = Awaited<
  ReturnType<InstanceType<DaytonaModule['Process']>['executeCommand']>
>;

function fakeDaytona(
  executeCommand: (command: string) => Promise<{ result?: string; exitCode?: number }>,
) {
  const provider = new DaytonaProvider({ apiKey: 'daytona-not-real' });
  (provider as unknown as { live: { process: { executeCommand: typeof executeCommand } } }).live = {
    process: { executeCommand },
  };
  return provider;
}

describe('Daytona ExecuteResponse exitCode in the pinned SDK', () => {
  it('the installed 0.205.0 typings require exitCode as a number', () => {
    const hasExitCode = true satisfies 'exitCode' extends keyof ExecuteResponse ? true : false;
    // `number | undefined` would accept this; a required `number` does not.
    const required = true satisfies [undefined] extends [ExecuteResponse['exitCode']] ? false : true;
    expect(hasExitCode).toBe(true);
    expect(required).toBe(true);

    const response: Pick<ExecuteResponse, 'exitCode' | 'result'> = {
      exitCode: 1,
      result: 'npm ERR!',
    };
    expect(response.exitCode).toBe(1);
  });
});

describe('commandResultFromDaytonaExecute', () => {
  it('uses a numeric exitCode as-is', () => {
    expect(commandResultFromDaytonaExecute({ result: 'ok', exitCode: 0 })).toEqual({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      success: true,
    });
    expect(commandResultFromDaytonaExecute({ result: 'npm ERR!', exitCode: 1 })).toEqual({
      stdout: 'npm ERR!',
      stderr: 'npm ERR!',
      exitCode: 1,
      success: false,
    });
  });

  it('does not treat a missing exitCode as success', () => {
    const result = commandResultFromDaytonaExecute({ result: 'ok' });
    expect(result.exitCode).toBe(1);
    expect(result.success).toBe(false);
  });
});

describe('DaytonaProvider.runCommand reports a missing exit code as failure', () => {
  it('is exit 1 when executeCommand omits exitCode', async () => {
    const provider = fakeDaytona(async () => ({ result: 'added 1 package' }));
    const result = await provider.runCommand('npm install left-pad');
    expect(result.exitCode).toBe(1);
    expect(result.success).toBe(false);
  });

  it('is exit 0 only when executeCommand returns 0', async () => {
    const provider = fakeDaytona(async () => ({ result: 'added 1 package', exitCode: 0 }));
    const result = await provider.runCommand('npm install zod');
    expect(result.exitCode).toBe(0);
    expect(result.success).toBe(true);
  });
});
