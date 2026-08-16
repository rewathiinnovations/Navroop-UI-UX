async function readOutput(value: unknown) {
  if (typeof value === 'function') {
    return String(await value());
  }
  return value == null ? '' : String(value);
}

type SandboxCommandResult = {
  exitCode?: number;
  success?: boolean;
  stdout?: unknown;
  stderr?: unknown;
};

/**
 * Preferred push path: git in the existing sandbox (same shell as get-sandbox-files).
 * Force-push is OK. Returns false so the Git Data API fallback can run.
 */
export async function trySandboxGitPush(input: { token: string; fullName: string }) {
  const sandbox = (
    globalThis as {
      activeSandbox?: {
        runCommand?: (opts: { cmd: string; args: string[] }) => Promise<SandboxCommandResult>;
      };
    }
  ).activeSandbox;
  if (!sandbox?.runCommand) return false;

  const run = async (cmd: string, args: string[]) => {
    const result = await sandbox.runCommand!({ cmd, args });
    const exitCode =
      typeof result.exitCode === 'number' ? result.exitCode : result.success === false ? 1 : 0;
    return {
      exitCode,
      stdout: await readOutput(result.stdout),
      stderr: await readOutput(result.stderr),
    };
  };

  try {
    const version = await run('git', ['--version']);
    if (version.exitCode !== 0) return false;

    await run('git', ['init']);
    await run('git', ['checkout', '-B', 'main']);
    await run('git', ['add', '-A']);
    await run('git', [
      '-c',
      'user.email=navroop@local',
      '-c',
      'user.name=Navroop',
      'commit',
      '-m',
      'Push from Navroop',
    ]);

    const remote = `https://x-access-token:${input.token}@github.com/${input.fullName}.git`;
    const push = await run('git', ['push', remote, 'HEAD:main', '--force']);
    return push.exitCode === 0;
  } catch {
    return false;
  }
}
