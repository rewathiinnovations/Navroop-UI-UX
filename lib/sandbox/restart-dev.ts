/**
 * Restarts the dev server inside the active sandbox.
 *
 * Extracted from POST /api/restart-vite so callers can invoke it directly
 * instead of over HTTP. The route is a thin wrapper.
 *
 * "Restarted" means the preview answered successfully (2xx or 304). The same
 * poll as first boot (`pollPreviewReady`) is the proof. A failed restart is a
 * typed degraded result — generated files stay in the VM.
 */

import { previewRestartFailedMessage } from '@/lib/sandbox/boot-errors';
import { pollPreviewReady } from '@/lib/sandbox/manager';

declare global {
  var activeSandbox: any;
  var activeSandboxProvider: any;
  var lastViteRestartTime: number;
  var viteRestartInProgress: boolean;
}

/** Restarts closer together than this are treated as the same restart. */
const RESTART_COOLDOWN_MS = 5000;

export type RestartDevServerResult =
  | { ok: true; restarted: boolean; message: string }
  | { ok: false; status: number; error: string };

export type RestartDevServerOptions = {
  /** Skip cooldown / in-progress short-circuit (install just killed the server). */
  force?: boolean;
  timeoutMs?: number;
  intervalMs?: number;
};

function previewUrlFrom(provider: {
  getSandboxUrl?: () => string | null;
  getSandboxInfo?: () => { url?: string | null } | null;
}): string {
  const fromMethod = typeof provider.getSandboxUrl === 'function' ? provider.getSandboxUrl() : null;
  const fromInfo = typeof provider.getSandboxInfo === 'function' ? provider.getSandboxInfo()?.url : null;
  const fromData = (globalThis as { sandboxData?: { url?: string } }).sandboxData?.url;
  return String(fromMethod || fromInfo || fromData || '').trim();
}

function driverFrom(provider: { driver?: string; getSandboxInfo?: () => { provider?: string } | null }): string {
  return provider.driver || provider.getSandboxInfo?.()?.provider || '';
}

async function confirmPreviewReady(
  provider: {
    driver?: string;
    getSandboxUrl?: () => string | null;
    getSandboxInfo?: () => { url?: string | null; provider?: string } | null;
  },
  options?: RestartDevServerOptions,
): Promise<RestartDevServerResult> {
  const driver = driverFrom(provider);
  const previewUrl = previewUrlFrom(provider);
  if (!previewUrl) {
    return { ok: false, status: 503, error: previewRestartFailedMessage(driver, 'No preview URL') };
  }
  try {
    await pollPreviewReady(previewUrl, 'restart-dev', {
      driver,
      timeoutMs: options?.timeoutMs,
      intervalMs: options?.intervalMs,
      timeoutMessage: (lastError) => previewRestartFailedMessage(driver, lastError),
    });
    return { ok: true, restarted: true, message: 'Vite restarted successfully' };
  } catch (error) {
    return { ok: false, status: 503, error: (error as Error).message };
  }
}

async function fallbackRestart(provider: { runCommand?: (command: string) => Promise<unknown> }) {
  if (typeof provider.runCommand !== 'function') {
    throw new Error('restartViteServer not implemented for this provider');
  }

  try {
    await provider.runCommand('pkill -f vite');
    console.log('[restart-vite] Killed existing Vite processes');
  } catch {
    console.log('[restart-vite] No existing Vite processes found');
  }

  try {
    await provider.runCommand(
      'bash -c "echo \'{\\"errors\\": [], \\"lastChecked\\": ' + Date.now() + '}\' > /tmp/vite-errors.json"',
    );
  } catch {
    // The error file is a cache; a stale one is harmless.
  }

  await provider.runCommand('sh -c "nohup npm run dev > /tmp/vite.log 2>&1 &"');
  console.log('[restart-vite] Vite dev server process started');
}

export async function restartDevServer(
  options?: RestartDevServerOptions,
): Promise<RestartDevServerResult> {
  // v1 and v2 sandbox creation store the handle under different globals.
  const provider = global.activeSandbox || global.activeSandboxProvider;

  if (!provider) {
    return { ok: false, status: 400, error: 'No active sandbox' };
  }

  if (!options?.force) {
    if (global.viteRestartInProgress) {
      console.log('[restart-vite] Vite restart already in progress, skipping...');
      return { ok: true, restarted: false, message: 'Vite restart already in progress' };
    }

    const now = Date.now();
    if (global.lastViteRestartTime && now - global.lastViteRestartTime < RESTART_COOLDOWN_MS) {
      const remainingTime = Math.ceil((RESTART_COOLDOWN_MS - (now - global.lastViteRestartTime)) / 1000);
      console.log(`[restart-vite] Cooldown active, ${remainingTime}s remaining`);
      return {
        ok: true,
        restarted: false,
        message: `Vite was recently restarted, cooldown active (${remainingTime}s remaining)`,
      };
    }
  }

  global.viteRestartInProgress = true;

  try {
    console.log('[restart-vite] Using provider method to restart Vite...');

    if (typeof provider.restartViteServer === 'function') {
      try {
        await provider.restartViteServer();
        console.log('[restart-vite] Vite restarted via provider method');
      } catch (error) {
        const message = (error as Error).message || '';
        if (!/not implemented/i.test(message)) throw error;
        console.log('[restart-vite] Provider restart not implemented, falling back...');
        await fallbackRestart(provider);
      }
    } else {
      console.log('[restart-vite] Fallback to manual Vite restart...');
      await fallbackRestart(provider);
    }

    const ready = await confirmPreviewReady(provider, options);
    if (ready.ok && ready.restarted) {
      global.lastViteRestartTime = Date.now();
    }
    return ready;
  } catch (error) {
    console.error('[restart-vite] Error:', error);
    return { ok: false, status: 500, error: (error as Error).message };
  } finally {
    global.viteRestartInProgress = false;
  }
}
