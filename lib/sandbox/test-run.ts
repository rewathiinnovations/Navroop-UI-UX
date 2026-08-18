import { log } from '@/lib/logger';
import {
  sandboxInvalidPreviewUrlMessage,
  usablePreviewUrl,
} from './boot-errors';
import { DRIVER_CAPABILITIES, type SandboxDriverId } from './provider';
import {
  formatProviderCheckResult,
  type LeakedTestSandbox,
  type ProviderCheckView,
} from './provider-check-copy';
import { isTeardownLeak, recordTeardownIfLeaked, type TeardownResult } from './teardown';

export type { LeakedTestSandbox, ProviderCheckView };
export { formatProviderCheckResult };

export type ProviderTestResult = {
  ok: boolean;
  failedAt: 'create' | 'command' | 'preview' | 'kill' | null;
  error: string | null;
  previewUrl: string | null;
  leakedSandbox: LeakedTestSandbox | null;
  timings: { createMs: number; commandMs: number; killMs: number };
};

/** Same preview-URL rule as the admin Test route — do not fetch the URL. */
export function applyPreviewUrlCheck(
  result: ProviderTestResult,
  driver: SandboxDriverId,
): ProviderTestResult {
  if (!result.ok || !DRIVER_CAPABILITIES[driver]?.publicPreviewUrl) return result;
  const usable = usablePreviewUrl(result.previewUrl);
  if (usable) return { ...result, previewUrl: usable };
  const raw = typeof result.previewUrl === 'string' ? result.previewUrl.trim() : '';
  return {
    ...result,
    ok: false,
    failedAt: 'preview',
    error: raw ? sandboxInvalidPreviewUrlMessage(raw) : 'Provider did not return a preview URL',
  };
}

export async function runProviderTest(opts: {
  driver: SandboxDriverId;
  secrets: Record<string, string>;
  create: () => Promise<{ sandboxId: string; previewUrl?: string | null }>;
  runCommand?: () => Promise<{ success?: boolean; exitCode?: number }>;
  kill?: () => Promise<void | TeardownResult>;
  providerConfigId?: string;
}): Promise<ProviderTestResult> {
  const timings = { createMs: 0, commandMs: 0, killMs: 0 };
  const started = Date.now();
  let live = false;
  let createdSandboxId: string | null = null;

  /**
   * Once create() resolves, the sandbox is billable. Every exit path has to kill it,
   * including a failed command and a thrown command, or the Test button leaks a VM.
   * `failedAt` keeps naming the earliest real failure so the admin still sees the
   * cause, so a kill failure is reported separately instead of overwriting it.
   */
  const killIfLive = async (stage: 'create' | 'command' | 'success'): Promise<LeakedTestSandbox | null> => {
    if (!live || !opts.kill) return null;
    live = false;
    const killStarted = Date.now();
    try {
      const result = await opts.kill();
      timings.killMs = Date.now() - killStarted;
      if (result && typeof result === 'object' && isTeardownLeak(result)) {
        log.error('sandbox.test_kill_failed', {
          driver: opts.driver,
          sandboxId: createdSandboxId,
          stage,
          error: result.reason,
        });
        await recordTeardownIfLeaked(result, {
          driver: opts.driver,
          providerConfigId: opts.providerConfigId ?? null,
          source: 'test',
        });
        return { sandboxId: createdSandboxId ?? result.sandboxId, error: result.reason };
      }
      return null;
    } catch (error) {
      timings.killMs = Date.now() - killStarted;
      const message = error instanceof Error ? error.message : String(error);
      // A VM we could not terminate keeps billing, so this must be visible even when
      // nobody is looking at /admin/sandbox-providers.
      log.error('sandbox.test_kill_failed', {
        driver: opts.driver,
        sandboxId: createdSandboxId,
        stage,
        error: message,
      });
      await recordTeardownIfLeaked(
        { status: 'could_not_stop', reason: message, sandboxId: createdSandboxId },
        {
          driver: opts.driver,
          providerConfigId: opts.providerConfigId ?? null,
          source: 'test',
        },
      );
      return { sandboxId: createdSandboxId, error: message };
    }
  };

  try {
    const created = await opts.create();
    timings.createMs = Date.now() - started;
    // Billable from here on. A create that resolved without a usable id still leaves
    // a VM the driver is holding, so it has to be killed too.
    live = true;
    createdSandboxId = created?.sandboxId || null;
    if (!created?.sandboxId) {
      const leakedSandbox = await killIfLive('create');
      return {
        ok: false,
        failedAt: 'create',
        error: 'Create returned no sandbox id',
        previewUrl: null,
        leakedSandbox,
        timings,
      };
    }
    if (opts.runCommand) {
      const commandStarted = Date.now();
      const command = await opts.runCommand();
      timings.commandMs = Date.now() - commandStarted;
      if (command.success === false || (command.exitCode != null && command.exitCode !== 0)) {
        const leakedSandbox = await killIfLive('command');
        return {
          ok: false,
          failedAt: 'command',
          error: leakedSandbox
            ? `Command failed (sandbox kill also failed: ${leakedSandbox.error})`
            : 'Command failed',
          previewUrl: created.previewUrl ?? null,
          leakedSandbox,
          timings,
        };
      }
    }
    const leakedSandbox = await killIfLive('success');
    if (leakedSandbox) {
      return {
        ok: false,
        failedAt: 'kill',
        error: leakedSandbox.error,
        previewUrl: created.previewUrl ?? null,
        leakedSandbox,
        timings,
      };
    }
    return {
      ok: true,
      failedAt: null,
      error: null,
      previewUrl: created.previewUrl ?? null,
      leakedSandbox: null,
      timings,
    };
  } catch (error) {
    timings.createMs = timings.createMs || Date.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    // A throw after the VM exists is a command failure, not a credentials failure.
    const failedAt = live ? ('command' as const) : ('create' as const);
    const leakedSandbox = await killIfLive(failedAt);
    return {
      ok: false,
      failedAt,
      error: leakedSandbox ? `${message} (sandbox kill also failed: ${leakedSandbox.error})` : message,
      previewUrl: null,
      leakedSandbox,
      timings,
    };
  }
}
