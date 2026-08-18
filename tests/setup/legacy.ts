/**
 * Run an existing assert-style tsx suite inside Vitest.
 * Intercepts process.exit so the suite cannot kill the runner.
 */
export async function runLegacySuite(importPath: string) {
  const originalExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__legacy_exit_${exitCode}`);
  }) as typeof process.exit;
  try {
    await import(importPath);
    if (exitCode && exitCode !== 0) {
      throw new Error(`legacy suite failed with exit ${exitCode}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === '__legacy_exit_0') return;
    if (message.startsWith('__legacy_exit_')) {
      throw new Error(`legacy suite failed with ${message.replace('__legacy_exit_', 'exit ')}`);
    }
    throw error;
  } finally {
    process.exit = originalExit;
  }
}
