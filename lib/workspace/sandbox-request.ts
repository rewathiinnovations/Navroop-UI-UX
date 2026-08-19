/**
 * There are no sandbox VMs any more: a project's files live in the database
 * and the preview compiles them in the browser, so nothing has to be booted
 * before generating, previewing, or restoring.
 *
 * Kept as a single gate rather than deleted so the workspace's remaining
 * sandbox branches stay unreachable from one place — every caller already
 * checks it, and a stray `createSandbox()` cannot resurrect a request for a
 * VM that no longer exists.
 */
export type SandboxRequestReason = 'open' | 'generate' | 'live' | 'restore';

export function shouldRequestSandbox(_reason: SandboxRequestReason): boolean {
  return false;
}
