import { sandboxManager } from '@/lib/sandbox/sandbox-manager';
import type { SandboxCommandResult, SandboxRunner } from './types';

type LooseProvider = {
  runCommand?: (command: string) => Promise<{ stdout?: string; stderr?: string; exitCode?: number; success?: boolean }>;
  writeFile?: (path: string, content: string) => Promise<void>;
};

function asRunner(provider: LooseProvider | null | undefined): SandboxRunner | null {
  if (!provider?.runCommand) return null;
  return {
    runCommand: async (command) => {
      const result = await provider.runCommand!(command);
      return {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exitCode: typeof result.exitCode === 'number' ? result.exitCode : result.success === false ? 1 : 0,
        success: result.success !== false,
      } satisfies SandboxCommandResult;
    },
    writeFile: provider.writeFile ? (path, content) => provider.writeFile!(path, content) : undefined,
  };
}

export function resolveSandboxRunner(sandboxId?: string | null): SandboxRunner | null {
  if (sandboxId) {
    const named = asRunner(sandboxManager.getProvider(sandboxId));
    if (named) return named;
  }
  return asRunner(
    sandboxManager.getActiveProvider() ||
      (globalThis as { activeSandboxProvider?: LooseProvider }).activeSandboxProvider ||
      null,
  );
}
