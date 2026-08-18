/**
 * Installs npm packages into the active sandbox and restarts its dev server.
 *
 * Extracted from POST /api/install-packages so the apply routes can call it
 * directly instead of over HTTP. The route is a thin wrapper that turns
 * `onProgress` into an SSE stream; a direct caller receives the same events
 * through the callback and the final tally as a typed result.
 */
import { lastCommandOutput, sandboxEditInstallFailedMessage } from '@/lib/sandbox/boot-errors';
import {
  restartDevServer,
  type RestartDevServerOptions,
} from '@/lib/sandbox/restart-dev';
import { DEFAULT_STACK, shouldInstallPackages } from '@/lib/stacks';

declare global {
  var activeSandboxProvider: any;
  var sandboxData: any;
}

export type InstallProgressEvent = {
  type: 'start' | 'status' | 'info' | 'output' | 'warning' | 'error' | 'success' | 'complete';
  message: string;
  packages?: string[];
  installedPackages?: string[];
  alreadyInstalled?: string[];
};

export type InstallPackagesInput = {
  packages: unknown;
  onProgress?: (event: InstallProgressEvent) => void | Promise<void>;
  /** Passed to `restartDevServer` so tests can use a short poll window. */
  restart?: RestartDevServerOptions;
};

export type InstallPackagesResult =
  | {
      ok: true;
      /** True when the stack has no node dependencies, so nothing was attempted. */
      skipped: boolean;
      installedPackages: string[];
      alreadyInstalled: string[];
      message: string;
      previewReady: boolean;
      previewNotice?: string;
    }
  | { ok: false; status: number; error: string };

export type InstallPrecheck =
  | { kind: 'ready'; packages: string[] }
  | { kind: 'skipped'; message: string }
  | { kind: 'error'; status: number; error: string };

/**
 * Everything that can be decided before any work starts.
 *
 * The HTTP route runs this first so a bad request is still an HTTP status
 * rather than an error event on a stream it has already committed to.
 */
export function precheckInstall(packages: unknown): InstallPrecheck {
  if (!packages || !Array.isArray(packages) || packages.length === 0) {
    return { kind: 'error', status: 400, error: 'Packages array is required' };
  }

  const validPackages = [...new Set(packages)]
    .filter((pkg): pkg is string => typeof pkg === 'string' && pkg.trim() !== '')
    .map((pkg) => pkg.trim());

  if (validPackages.length === 0) {
    return { kind: 'error', status: 400, error: 'No valid package names provided' };
  }

  if (packages.length !== validPackages.length) {
    console.log(
      `[install-packages] Cleaned packages: removed ${packages.length - validPackages.length} invalid/duplicate entries`,
    );
    console.log('[install-packages] Original:', packages);
    console.log('[install-packages] Cleaned:', validPackages);
  }

  if (!global.activeSandboxProvider) {
    return { kind: 'error', status: 400, error: 'No active sandbox provider available' };
  }

  const activeStack =
    (typeof global.sandboxData?.stack === 'string' && global.sandboxData.stack) || DEFAULT_STACK;
  if (!shouldInstallPackages(activeStack)) {
    return { kind: 'skipped', message: `skip install: ${activeStack} has no node dependencies` };
  }

  return { kind: 'ready', packages: validPackages };
}

export async function installPackages(input: InstallPackagesInput): Promise<InstallPackagesResult> {
  const { packages, onProgress } = input;
  const emit = async (event: InstallProgressEvent) => {
    if (onProgress) await onProgress(event);
  };

  const precheck = precheckInstall(packages);
  if (precheck.kind === 'error') {
    return { ok: false, status: precheck.status, error: precheck.error };
  }
  if (precheck.kind === 'skipped') {
    return {
      ok: true,
      skipped: true,
      installedPackages: [],
      alreadyInstalled: [],
      message: precheck.message,
      previewReady: true,
    };
  }

  const validPackages = precheck.packages;
  const provider = global.activeSandboxProvider;
  const restartOptions: RestartDevServerOptions = { force: true, ...input.restart };

  const bringDevServerBack = async () => {
    await emit({ type: 'status', message: 'Restarting development server...' });
    const restartResult = await restartDevServer(restartOptions);
    if (restartResult.ok && restartResult.restarted) {
      return { previewReady: true as const };
    }
    if (restartResult.ok && !restartResult.restarted) {
      // Cooldown / in-flight — we did not prove HTTP 200 this call.
      return { previewReady: false as const, previewNotice: restartResult.message };
    }
    const notice = restartResult.ok ? restartResult.message : restartResult.error;
    await emit({ type: 'warning', message: notice });
    return { previewReady: false as const, previewNotice: notice };
  };

  console.log('[install-packages] Installing packages:', validPackages);

  try {
    await emit({
      type: 'start',
      message: `Installing ${validPackages.length} package${validPackages.length > 1 ? 's' : ''}...`,
      packages: validPackages,
    });

    await emit({ type: 'status', message: 'Stopping development server...' });
    try {
      await provider.runCommand('pkill -f vite');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (killError) {
      console.debug('[install-packages] No existing dev server found:', killError);
    }

    await emit({ type: 'status', message: 'Checking installed packages...' });

    let packagesToInstall = validPackages;
    const alreadyInstalled: string[] = [];

    try {
      let packageJsonContent = '';
      try {
        packageJsonContent = await provider.readFile('package.json');
      } catch (error) {
        console.log('[install-packages] Error reading package.json:', error);
      }
      if (packageJsonContent) {
        const packageJson = JSON.parse(packageJsonContent);
        const allDeps = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) };
        const needInstall: string[] = [];

        for (const pkg of validPackages) {
          const pkgName = pkg.startsWith('@') ? pkg : pkg.split('@')[0];
          if (allDeps[pkgName]) alreadyInstalled.push(pkgName);
          else needInstall.push(pkg);
        }

        packagesToInstall = needInstall;

        if (alreadyInstalled.length > 0) {
          await emit({ type: 'info', message: `Already installed: ${alreadyInstalled.join(', ')}` });
        }
      }
    } catch (error) {
      console.error('[install-packages] Error checking existing packages:', error);
      packagesToInstall = validPackages;
    }

    if (packagesToInstall.length === 0) {
      await emit({
        type: 'success',
        message: 'All packages are already installed',
        installedPackages: [],
        alreadyInstalled: validPackages,
      });

      const restart = await bringDevServerBack();
      if (restart.previewReady) {
        await emit({ type: 'complete', message: 'Dev server restarted!', installedPackages: [] });
      }

      return {
        ok: true,
        skipped: false,
        installedPackages: [],
        alreadyInstalled: validPackages,
        message: 'All packages are already installed',
        ...restart,
      };
    }

    await emit({
      type: 'info',
      message: `Installing ${packagesToInstall.length} new package(s): ${packagesToInstall.join(', ')}`,
    });

    const installResult = await provider.installPackages(packagesToInstall);

    const stdout = String(installResult.stdout || '');
    const stderr = String(installResult.stderr || '');

    if (stdout) {
      for (const line of stdout.split('\n').filter((l) => l.trim())) {
        if (line.includes('npm WARN')) await emit({ type: 'warning', message: line });
        else await emit({ type: 'output', message: line });
      }
    }

    if (stderr) {
      for (const line of stderr.split('\n').filter((l) => l.trim())) {
        if (line.includes('ERESOLVE')) {
          await emit({
            type: 'warning',
            message: `Dependency conflict resolved with --legacy-peer-deps: ${line}`,
          });
        } else {
          await emit({ type: 'error', message: line });
        }
      }
    }

    const installFailed = installResult.exitCode !== 0;
    if (installFailed) {
      const installError = sandboxEditInstallFailedMessage(
        typeof provider.driver === 'string' ? provider.driver : '',
        Number(installResult.exitCode) || 1,
        packagesToInstall,
        lastCommandOutput(stdout, stderr),
      );
      await emit({ type: 'error', message: installError });
      // Restart even after a failed install: `pkill -f vite` above already took
      // the dev server down, so returning here would leave the sandbox with no
      // server running at all.
      await bringDevServerBack();
      return { ok: false, status: 500, error: installError };
    }

    await emit({
      type: 'success',
      message: `Successfully installed: ${packagesToInstall.join(', ')}`,
      installedPackages: packagesToInstall,
    });

    const restart = await bringDevServerBack();
    if (restart.previewReady) {
      await emit({
        type: 'complete',
        message: 'Package installation complete and dev server restarted!',
        installedPackages: packagesToInstall,
      });
    }

    return {
      ok: true,
      skipped: false,
      installedPackages: packagesToInstall,
      alreadyInstalled,
      message: `Installed ${packagesToInstall.length} package(s)`,
      ...restart,
    };
  } catch (error) {
    const message = (error as Error).message;
    console.error('[install-packages] Error:', error);
    if (message && message !== 'undefined') {
      await emit({ type: 'error', message });
    }
    return { ok: false, status: 500, error: message || 'Package installation failed' };
  }
}
