/**
 * Scans generated source for bare imports and installs whatever the sandbox is
 * missing.
 *
 * Extracted from POST /api/detect-and-install-packages so the apply route can
 * call it directly instead of over HTTP. The route is a thin wrapper.
 */

declare global {
  var activeSandboxProvider: any;
}

const NODE_BUILTINS = [
  'fs',
  'path',
  'http',
  'https',
  'crypto',
  'stream',
  'util',
  'os',
  'url',
  'querystring',
  'child_process',
];

export type DetectAndInstallResult =
  | {
      ok: true;
      packagesInstalled: string[];
      packagesFailed: string[];
      packagesAlreadyInstalled: string[];
      message: string;
      logs?: string;
    }
  | { ok: false; status: number; error: string };

function collectImportedPackages(files: Record<string, unknown>): string[] {
  const imports = new Set<string>();
  const importRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s*,?\s*)*(?:from\s+)?['"]([^'"]+)['"]/g;
  const requireRegex = /require\s*\(['"]([^'"]+)['"]\)/g;

  for (const [filePath, content] of Object.entries(files)) {
    if (typeof content !== 'string') continue;
    if (!filePath.match(/\.(jsx?|tsx?)$/)) continue;

    let match;
    while ((match = importRegex.exec(content)) !== null) imports.add(match[1]);
    while ((match = requireRegex.exec(content)) !== null) imports.add(match[1]);
  }

  console.log('[detect-and-install-packages] Found imports:', Array.from(imports));

  const heroiconImports = Array.from(imports).filter((imp) => imp.includes('heroicons'));
  if (heroiconImports.length > 0) {
    console.log('[detect-and-install-packages] Heroicon imports:', heroiconImports);
  }

  const packages = Array.from(imports).filter((imp) => {
    if (imp.startsWith('.') || imp.startsWith('/')) return false;
    if (NODE_BUILTINS.includes(imp)) return false;
    return true;
  });

  // Strip subpaths: `@scope/pkg/thing` and `pkg/thing` both install `pkg`.
  const packageNames = packages.map((pkg) =>
    pkg.startsWith('@') ? pkg.split('/').slice(0, 2).join('/') : pkg.split('/')[0],
  );

  return [...new Set(packageNames)];
}

export async function detectAndInstallPackages(input: {
  files: unknown;
}): Promise<DetectAndInstallResult> {
  const { files } = input;

  if (!files || typeof files !== 'object') {
    return { ok: false, status: 400, error: 'Files object is required' };
  }

  if (!global.activeSandboxProvider) {
    return { ok: false, status: 404, error: 'No active sandbox' };
  }

  try {
    const fileMap = files as Record<string, unknown>;
    console.log('[detect-and-install-packages] Processing files:', Object.keys(fileMap));

    const uniquePackages = collectImportedPackages(fileMap);
    console.log('[detect-and-install-packages] Packages to install:', uniquePackages);

    if (uniquePackages.length === 0) {
      return {
        ok: true,
        packagesInstalled: [],
        packagesFailed: [],
        packagesAlreadyInstalled: [],
        message: 'No new packages to install',
      };
    }

    const provider = global.activeSandboxProvider;
    const installed: string[] = [];
    const missing: string[] = [];

    for (const packageName of uniquePackages) {
      try {
        const checkResult = await provider.runCommand(
          `test -d ${JSON.stringify(`node_modules/${packageName}`)}`,
        );
        if (checkResult.exitCode === 0) installed.push(packageName);
        else missing.push(packageName);
      } catch (checkError) {
        console.debug(`Package check failed for ${packageName}:`, checkError);
        missing.push(packageName);
      }
    }

    console.log('[detect-and-install-packages] Package status:', { installed, missing });

    if (missing.length === 0) {
      return {
        ok: true,
        packagesInstalled: [],
        packagesFailed: [],
        packagesAlreadyInstalled: installed,
        message: 'All packages already installed',
      };
    }

    console.log('[detect-and-install-packages] Installing packages:', missing);

    const installResult = await provider.runCommand(
      `npm install --save ${missing.map((name) => JSON.stringify(name)).join(' ')}`,
    );

    const stdout = String(installResult.stdout ?? '');
    const stderr = String(installResult.stderr ?? '');

    console.log('[detect-and-install-packages] Install stdout:', stdout);
    if (stderr) console.log('[detect-and-install-packages] Install stderr:', stderr);

    const finalInstalled: string[] = [];
    const failed: string[] = [];

    for (const packageName of missing) {
      try {
        const verifyResult = await provider.runCommand(
          `test -d ${JSON.stringify(`node_modules/${packageName}`)}`,
        );
        if (verifyResult.exitCode === 0) {
          finalInstalled.push(packageName);
          console.log(`✓ Verified installation of ${packageName}`);
        } else {
          failed.push(packageName);
          console.log(`✗ Failed to verify installation of ${packageName}`);
        }
      } catch (error) {
        failed.push(packageName);
        console.log(`✗ Error verifying ${packageName}:`, error);
      }
    }

    if (failed.length > 0) {
      console.error('[detect-and-install-packages] Failed to install:', failed);
    }

    return {
      ok: true,
      packagesInstalled: finalInstalled,
      packagesFailed: failed,
      packagesAlreadyInstalled: installed,
      message: `Installed ${finalInstalled.length} packages`,
      logs: stdout,
    };
  } catch (error) {
    console.error('[detect-and-install-packages] Error:', error);
    return { ok: false, status: 500, error: (error as Error).message };
  }
}
