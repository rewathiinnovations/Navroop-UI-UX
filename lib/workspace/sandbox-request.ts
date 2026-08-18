/**
 * The workspace asks for a VM only when the user is about to use one.
 * Opening a project (including PLANNING) must not boot a sandbox.
 */
export type SandboxRequestReason = 'open' | 'generate' | 'live' | 'restore';

export function shouldRequestSandbox(reason: SandboxRequestReason): boolean {
  return reason === 'generate' || reason === 'live' || reason === 'restore';
}
