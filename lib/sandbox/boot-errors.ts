import { sandboxDriverLabel } from './provider';
import type { TeardownResult } from './teardown';
import { unusedSandboxTeardownSuffix } from './teardown';

export { sandboxDriverLabel };

/** Last non-empty lines of install output — enough for an admin, no env dumps. */
export function lastCommandOutput(stdout: string, stderr: string, maxLines = 8): string {
  const combined = [stderr, stdout]
    .join('\n')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  return combined.slice(-maxLines).join('\n');
}

export function sandboxNpmInstallFailedMessage(
  driver: string,
  exitCode: number,
  output: string,
  outcome?: TeardownResult,
): string {
  const label = sandboxDriverLabel(driver);
  const detail = output.trim();
  const body = detail
    ? `${label} created a sandbox but npm install failed (exit ${exitCode}): ${detail}. `
    : `${label} created a sandbox but npm install failed (exit ${exitCode}). `;
  return body + unusedSandboxTeardownSuffix(label, outcome);
}

/** Create-time: a host/tunnel/link was never returned. Not an HTTP ready check. */
export function sandboxMissingPreviewUrlMessage(
  driver: string,
  port: number,
  outcome?: TeardownResult,
): string {
  const label = sandboxDriverLabel(driver);
  return (
    `${label} created a sandbox but did not return a preview URL for the Vite dev server on port ${port}. ` +
    unusedSandboxTeardownSuffix(label, outcome)
  );
}

/**
 * Reconnect: the VM is there but no usable preview URL.
 * We did not create this sandbox and we did not stop it — do not tell the
 * user they are not being billed.
 */
export function sandboxReconnectMissingPreviewUrlMessage(driver: string, port: number): string {
  const label = sandboxDriverLabel(driver);
  return (
    `${label} found this sandbox but did not return a usable preview URL for the Vite dev server on port ${port}. ` +
    `The sandbox is still running and may still be billed. Try again, or ask an admin to test the ${label} provider on /admin/sandbox-providers.`
  );
}

export function previewNeverBecameReadyMessage(
  driver: string,
  lastError: string,
  outcome?: TeardownResult,
): string {
  const label = sandboxDriverLabel(driver) || 'The sandbox';
  const detail = lastError.trim() || 'Preview did not become ready';
  return (
    `${label} created a sandbox but the preview never became ready (${detail}). ` +
    unusedSandboxTeardownSuffix(label, outcome)
  );
}

/** Mid-generation restart — code is already saved; the VM stays up. */
export function previewRestartFailedMessage(driver: string, lastError: string): string {
  const label = sandboxDriverLabel(driver) || 'The sandbox';
  const detail = lastError.trim() || 'Preview did not become ready';
  return (
    `${label} restarted the preview but it never became ready (${detail}). ` +
    `The generated code was saved. Refresh or try again, or ask an admin to test the ${label} provider on /admin/sandbox-providers.`
  );
}

export function sandboxListUnreadableMessage(driver: string, detail: string): string {
  const label = sandboxDriverLabel(driver);
  const body = detail.trim()
    ? `${label} could not list the files in the sandbox (${detail.trim()}). `
    : `${label} could not list the files in the sandbox. `;
  return (
    body +
    `Try again, or ask an admin to test the ${label} provider on /admin/sandbox-providers.`
  );
}

/** Probe/reconnect could not decide — not the same as "the sandbox is gone". */
export function sandboxReconnectUncertainMessage(driver: string, detail: string): string {
  const label = sandboxDriverLabel(driver);
  const body = detail.trim()
    ? `${label} could not tell whether this sandbox is still running (${detail.trim()}). `
    : `${label} could not tell whether this sandbox is still running. `;
  return (
    body +
    `Try again, or ask an admin to test the ${label} provider on /admin/sandbox-providers.`
  );
}

/**
 * A string we will treat as a preview URL. Does not fetch.
 * `https://undefined` parses as a URL — refuse that hostname explicitly.
 */
export function usablePreviewUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.trim();
  if (!host || host === 'undefined' || host === 'null') return null;
  return trimmed;
}

export function sandboxInvalidPreviewUrlMessage(raw: string): string {
  return `Provider returned an invalid preview URL (${raw.trim() || 'empty'})`;
}

export function sandboxEditInstallFailedMessage(
  driver: string,
  exitCode: number,
  packages: string[],
  output: string,
): string {
  const label = sandboxDriverLabel(driver);
  const pkg = packages.join(', ');
  const detail = output.trim();
  const body = detail
    ? `${label} ran npm install during an edit but it failed (exit ${exitCode}) for ${pkg}: ${detail}. `
    : `${label} ran npm install during an edit but it failed (exit ${exitCode}) for ${pkg}. `;
  return (
    body +
    `The generated code was saved. Try again, or ask an admin to test the ${label} provider on /admin/sandbox-providers.`
  );
}
