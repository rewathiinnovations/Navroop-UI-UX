import { sandboxDriverLabel } from './provider';

/**
 * A sandbox that was created but could not be shut down. Non-null means a billable
 * VM is still running, whatever stage the test failed at.
 */
export type LeakedTestSandbox = {
  sandboxId: string | null;
  error: string;
};

export type ProviderCheckView = {
  driver: string;
  ok: boolean;
  failedAt: string | null;
  error: string | null;
  previewUrl: string | null;
  leakedSandbox?: LeakedTestSandbox | null;
};

/** Driver-named English used by both Test and the cron probe. */
export function formatProviderCheckResult(view: ProviderCheckView): string {
  const label = sandboxDriverLabel(view.driver);
  const detail = (view.error || '').trim() || 'Unknown error';
  if (view.ok) {
    return `${label} created a sandbox, ran echo, and shut it down. The preview URL was returned but not fetched. This does not start a preview or run a build.`;
  }
  switch (view.failedAt) {
    case 'create':
      return `${label} could not create a sandbox (${detail}). Check the credentials for this provider on /admin/sandbox-providers.`;
    case 'command': {
      const leaked = Boolean(view.leakedSandbox) || /sandbox kill also failed/i.test(detail);
      if (leaked) {
        return `${label} created a sandbox but the test command did not succeed (${detail}). The sandbox could not be shut down and may still be billed. Check the provider dashboard.`;
      }
      return `${label} created a sandbox but the test command did not succeed (${detail}). The unused sandbox was asked to stop. Check the provider dashboard, then try Test again.`;
    }
    case 'preview': {
      const invalid = detail.match(/invalid preview URL \((.+)\)/i);
      const problem = invalid
        ? `returned an invalid preview URL (${invalid[1]})`
        : 'returned no preview URL';
      return `${label} created a sandbox and ran echo but ${problem}. This does not start a preview or run a build. Check the provider dashboard, then try Test again.`;
    }
    case 'kill':
      return `${label} created a sandbox and ran echo but could not shut the sandbox down (${detail}). Check the provider dashboard for a running sandbox.`;
    default:
      return `${label} provider test did not pass (${detail}). Check the credentials for this provider on /admin/sandbox-providers.`;
  }
}
